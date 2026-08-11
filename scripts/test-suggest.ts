// Diagnostic: stream the response so we can see where it hangs.
// Run with: tsx scripts/test-suggest.ts

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";

const dev = readFileSync(".dev.vars", "utf8");
const apiKey = dev.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.replace(/^"(.*)"$/, "$1");
if (!apiKey) throw new Error("no ANTHROPIC_API_KEY in .dev.vars");
const client = new Anthropic({ apiKey });

// Mirror of the live SYSTEM_PROMPT in src/suggest.ts (kept as a copy because this
// script runs under tsx, where the wrangler taste.md text-import rule doesn't apply).
const SYSTEM_PROMPT_NEW = `You pick this week's activities for Tim & Jess in the Phoenix/Tempe area. Given their taste profile and their calendar, suggest 3-5 specific events you can verify via web search.

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

const userMessage = `## My taste profile

Tim & Jess like live music (indie/alt), good cocktail bars, theater, and chill outdoor stuff. Phoenix/Tempe area.

## My calendar, next 7 days

(nothing scheduled)

## Today's date

2026-08-09

Please suggest 3-5 things for this week.`;

const t0 = Date.now();
process.stdout.write(`STREAM start...\n`);

try {
  const stream = await client.messages.stream(
    {
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM_PROMPT_NEW,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 12 } as any],
      messages: [{ role: "user", content: userMessage }],
    },
    { timeout: 5 * 60 * 1000 }
  );

  let lastTickMs = Date.now();
  for await (const event of stream) {
    const now = Date.now();
    const dt = ((now - lastTickMs) / 1000).toFixed(1);
    const totalT = ((now - t0) / 1000).toFixed(1);
    lastTickMs = now;

    let detail = "";
    if (event.type === "content_block_start") {
      detail = `start block[${event.index}] type=${(event as any).content_block?.type}`;
    } else if (event.type === "content_block_delta") {
      const d: any = (event as any).delta;
      if (d?.type === "text_delta") detail = `text+${(d.text ?? "").length}c`;
      else if (d?.type === "input_json_delta") detail = `tool-input+${(d.partial_json ?? "").length}c`;
      else detail = d?.type ?? "delta?";
    } else if (event.type === "content_block_stop") {
      detail = `stop block[${event.index}]`;
    } else if (event.type === "message_delta") {
      detail = `stop_reason=${(event as any).delta?.stop_reason}`;
    } else if (event.type === "message_start" || event.type === "message_stop") {
      detail = "";
    } else {
      detail = JSON.stringify(event).slice(0, 80);
    }

    process.stdout.write(`[t=${totalT}s +${dt}s] ${event.type} ${detail}\n`);
  }

  const final = await stream.finalMessage();
  const totalT = ((Date.now() - t0) / 1000).toFixed(1);
  const fullText = (final.content as any[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n\n");
  const hasIntro = /<intro>[\s\S]*?<\/intro>/i.test(fullText);
  const hasPicks = /<picks>[\s\S]*?<\/picks>/i.test(fullText);
  process.stdout.write(`DONE in ${totalT}s. stop=${final.stop_reason} usage=${JSON.stringify(final.usage)}\n`);
  process.stdout.write(`EXTRACT: textChars=${fullText.length} hasIntro=${hasIntro} hasPicks=${hasPicks}\n`);
} catch (e: any) {
  const totalT = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`FAIL in ${totalT}s: ${e?.constructor?.name} ${e?.message}\n`);
}
