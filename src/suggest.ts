import Anthropic from "@anthropic-ai/sdk";
import type { Env, CalendarEvent, Pick } from "./types";
// @ts-expect-error - Wrangler text rule provides the file as a string
import taste from "./taste.md";

const SYSTEM_PROMPT = `You pick this week's activities for Tim & Jess in the Phoenix/Tempe area. Given their taste profile and their calendar, suggest 3-5 specific events you can verify via web search.

Suggest only events happening in the next 7 days. The calendar feed covers the next 3 weeks so you can see what's already planned: skip anything already on the calendar, including equivalents of a future-week entry (same show, exhibit, or event on a different date). If you can't verify something is real and happening this week, drop it.

Emit two tagged blocks — anything outside both is discarded, so use that space freely for thinking, scratch, or compilation notes.

1) <intro> — 1-2 sentences of markdown on the shape of the week: the through-line, anything notable. No greeting or sign-off; it renders under the email's header.

2) <picks> — a JSON array (no markdown code fences, no comments) of the 3-5 events you're recommending, best first. Each object has these fields exactly:
   {
     "title": string,
     "start": ISO 8601 datetime with -07:00 offset (Phoenix doesn't observe DST). Provide a real start time even if you only know the day; default to a reasonable typical hour for the kind of event.
     "end":   ISO 8601 datetime with -07:00 offset, or null if you don't know.
     "venue": string or null,
     "url":   string,
     "cost":  string (e.g. "$30-45", "free") or null,
     "blurb": string — one or two sentences on why this fits them. Voice: a friend who knows them, not a tour guide. Plain text, no markdown.
   }

Each pick renders as a card in the email with your blurb and its own links; there is no other email body to write.`;

// Use the BASIC web search variant, not the dynamic-filtering one (web_search_20260209).
// The dynamic-filtering variant runs code_execution under the hood in loops that `max_uses`
// does NOT bound: in testing it issued 24+ server_tool_use / 16+ code_execution blocks,
// never converged within the turn, and the model exhausted its output budget on tool calls
// before ever writing the <email> block ("No <email> block in Anthropic response").
// The basic variant respects max_uses, converges in ~60s with stop_reason=end_turn, and
// returns the same `web_search_tool_result` content-block shape. Do not "upgrade" this back
// to web_search_20260209 without re-checking convergence — see scripts/test-suggest.ts.
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";

function formatCalendar(events: CalendarEvent[]): string {
  if (events.length === 0) return "(nothing on the calendar this week)";
  return events
    .map((e) => {
      const calSuffix = e.calendar !== "primary" ? ` [${e.calendar}]` : "";
      const loc = e.location ? ` @ ${e.location}` : "";
      if (e.allDay) {
        // e.start is "YYYY-MM-DD"; anchor to noon Phoenix so the day label can't drift.
        const day = new Date(`${e.start}T12:00:00-07:00`).toLocaleString("en-US", {
          timeZone: "America/Phoenix",
          weekday: "short",
          month: "short",
          day: "numeric",
        });
        return `- ${day} (all day): ${e.title}${loc}${calSuffix}`;
      }
      const start = new Date(e.start).toLocaleString("en-US", {
        timeZone: "America/Phoenix",
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      return `- ${start}: ${e.title}${loc}${calSuffix}`;
    })
    .join("\n");
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    return status === 429 || (status !== undefined && status >= 500);
  }
  return err instanceof TypeError; // e.g. fetch network error
}

async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isRetryable(err)) throw err;
    await new Promise((r) => setTimeout(r, 2000));
    return await fn();
  }
}

function parsePicks(fullText: string): Pick[] {
  const match = fullText.match(/<picks>([\s\S]*?)<\/picks>/i);
  if (!match) throw new Error("No <picks> block in Anthropic response");
  // Strip optional ```json ... ``` fences in case the model added them despite instructions.
  const json = match[1].trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`<picks> JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("<picks> is not a JSON array");
  if (parsed.length === 0) throw new Error("<picks> is empty");
  return parsed.map((p, i) => {
    if (typeof p !== "object" || p === null) throw new Error(`<picks>[${i}] is not an object`);
    const o = p as Record<string, unknown>;
    if (
      typeof o.title !== "string" ||
      typeof o.start !== "string" ||
      typeof o.url !== "string" ||
      typeof o.blurb !== "string"
    ) {
      throw new Error(`<picks>[${i}] missing required fields title/start/url/blurb`);
    }
    if (!o.start.includes("T") || !Number.isFinite(Date.parse(o.start))) {
      throw new Error(`<picks>[${i}] invalid start datetime: ${o.start}`);
    }
    return {
      title: o.title,
      start: o.start,
      end: typeof o.end === "string" ? o.end : null,
      venue: typeof o.venue === "string" ? o.venue : null,
      url: o.url,
      cost: typeof o.cost === "string" ? o.cost : null,
      blurb: o.blurb,
    };
  });
}

export async function generateSuggestions(
  env: Env,
  events: CalendarEvent[],
  today: Date
): Promise<{ intro: string; picks: Pick[] }> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const userMessage = `## My taste profile

${taste}

## My calendar, next 3 weeks

${formatCalendar(events)}

## Today's date

${today.toISOString().slice(0, 10)}

Please suggest 3-5 things for this week.`;

  // Stream, don't buffer. A non-streaming messages.create with web_search at
  // max_uses=12 holds the connection open with no bytes flowing while Claude runs
  // its searches; the response routinely exceeds the ~100s upstream (Cloudflare)
  // proxy limit and comes back as a 524 before our own SDK timeout even fires.
  // Streaming keeps the connection alive with incremental SSE events, so the edge
  // never times out; finalMessage() reassembles the same Message shape we parse below.
  // Headroom: the model spends output tokens on tool-use blocks as well as the
  // final <intro>+<picks>. 4096 left it borderline; a clean run uses ~3k.
  const response = await retryOnce(() =>
    client.messages
      .stream(
        {
          model: "claude-sonnet-4-6",
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          tools: [
            { type: WEB_SEARCH_TOOL_TYPE as any, name: "web_search", max_uses: 12 } as any,
          ],
          messages: [{ role: "user", content: userMessage }],
        },
        // Backstop only — streaming should prevent the long hangs that forced this.
        { timeout: 8 * 60 * 1000 }
      )
      .finalMessage()
  );

  // With server-side tools (web_search), Claude often packs interim narration and the final
  // output into a single text block. Block-level slicing can't separate them, so we ask the
  // model to wrap each output in named tags and extract only those.
  const fullText = (response.content as Array<{ type: string; text?: string }>)
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n\n");

  const introMatch = fullText.match(/<intro>([\s\S]*?)<\/intro>/i);
  if (!introMatch) throw new Error("No <intro> block in Anthropic response");
  const intro = introMatch[1].trim();
  if (!intro) throw new Error("Empty <intro> block in Anthropic response");

  const picks = parsePicks(fullText);

  return { intro, picks };
}
