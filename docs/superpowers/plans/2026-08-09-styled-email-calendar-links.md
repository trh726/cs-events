# Styled Email + Calendar Links + 21-Day Lookahead Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the weekly digest as a styled HTML email built from the structured `picks` array (one card per pick with a Google Calendar add-link), and widen the calendar feed to 21 days so the model stops suggesting events already planned in a future week.

**Architecture:** The model's output contract changes from `<picks>` + `<email>` to `<intro>` + `<picks>` (each pick gains a required `blurb`). A new pure module `src/render.ts` builds `{ html, text }` deterministically from `intro` + `picks`; `email.ts` stays a thin Resend transport. Extraction remains tag-based regex over joined text blocks — that pattern is a guarded contract (see CLAUDE.md "Anthropic output extraction"), only the tag names change.

**Tech Stack:** Cloudflare Workers (TypeScript), vitest via `@cloudflare/vitest-pool-workers` (real workerd runtime), `marked` for markdown → HTML, Resend HTTP API.

## Global Constraints

- Model stays `claude-sonnet-4-6`; web search tool type stays `web_search_20250305` with `max_uses: 12`. Do not touch either.
- Extraction must remain tag-based regex over **joined text blocks** — never filter `response.content` by block type or slice around `web_search_tool_result` (CLAUDE.md: "do not regress").
- The Anthropic call must remain **streamed** (`client.messages.stream(...).finalMessage()`), never `messages.create`.
- Phoenix doesn't observe DST: all Phoenix-time math may use a fixed UTC-7 offset; never add DST adjustment logic.
- All HTML styles must be **inline** (email clients strip stylesheets). Light theme only.
- Model output (title, venue, cost, blurb, url) landing in HTML must be HTML-escaped; all calendar-URL params URL-encoded.
- Tests run with `npm test` (vitest under workerd). Single file: `npm test -- test/render.test.ts`.
- **Do not deploy mid-plan.** Intermediate commits are green under tests but the prompt/parser/renderer only line up again at Task 5. Deploy happens in Task 6.

---

### Task 1: Widen calendar lookahead to 21 days

**Files:**
- Modify: `src/calendar.ts:83-88` (window constant in `fetchUpcomingEvents`)
- Modify: `src/suggest.ts:127` (user-message heading "My calendar, next 7 days")
- Test: `test/calendar.test.ts`, `test/suggest.test.ts:92`

**Interfaces:**
- Consumes: nothing new.
- Produces: `fetchUpcomingEvents(accessToken: string): Promise<CalendarEvent[]>` — signature unchanged, now returns 21 days of events. User message heading becomes `## My calendar, next 3 weeks`.

- [ ] **Step 1: Write the failing test**

Add to `test/calendar.test.ts` inside `describe("fetchUpcomingEvents")`:

```ts
it("requests a 21-day window", async () => {
  let spanDays: number | null = null;
  routeFetch(async (url) => {
    if (url.includes("/users/me/calendarList")) {
      return new Response(
        JSON.stringify({
          items: [{ id: "primary-id", primary: true, selected: true, accessRole: "owner", summary: "tim" }],
        }),
        { status: 200 }
      );
    }
    const params = new URL(url).searchParams;
    spanDays =
      (Date.parse(params.get("timeMax")!) - Date.parse(params.get("timeMin")!)) / 86_400_000;
    return new Response(JSON.stringify({}), { status: 200 });
  });

  await fetchUpcomingEvents("token");
  expect(spanDays).toBeCloseTo(21, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/calendar.test.ts -t "21-day window"`
Expected: FAIL — `spanDays` is 7, not close to 21.

- [ ] **Step 3: Implement the window change**

In `src/calendar.ts`, replace the window lines in `fetchUpcomingEvents`:

```ts
  const now = new Date();
  // 21 days: suggestions target the next 7, but the wider feed lets the model
  // skip events the couple already has planned in a later week.
  const lookaheadEnd = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000);
  const timeMin = now.toISOString();
  const timeMax = lookaheadEnd.toISOString();
```

In `src/suggest.ts`, change the user-message heading:

```ts
## My calendar, next 3 weeks
```

(replacing `## My calendar, next 7 days`).

- [ ] **Step 4: Update the suggest test expectation**

In `test/suggest.test.ts` (first test, ~line 92), change:

```ts
    expect(call.messages[0].content).toContain("My calendar, next 3 weeks");
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/calendar.ts src/suggest.ts test/calendar.test.ts test/suggest.test.ts
git commit -m "Widen calendar lookahead to 21 days"
```

---

### Task 2: Add required `blurb` to the pick schema

**Files:**
- Modify: `src/types.ts:21-28` (`Pick` interface)
- Modify: `src/suggest.ts` (`SYSTEM_PROMPT` picks field list; `parsePicks` validation)
- Test: `test/suggest.test.ts`

**Interfaces:**
- Consumes: existing `Pick` from `src/types.ts`.
- Produces: `Pick` gains `blurb: string` (required). `parsePicks` throws `"<picks>[i] missing required fields title/start/url/blurb"` when blurb is absent or not a string. Tasks 3–5 rely on `pick.blurb: string` existing.

- [ ] **Step 1: Update existing fixtures so only the new test fails**

In `test/suggest.test.ts`:

1. Add a blurb to `samplePicks`:

```ts
const samplePicks = [
  {
    title: "Show",
    start: "2026-04-30T19:30:00-07:00",
    end: null,
    venue: "Crescent Ballroom",
    url: "https://example.com/show",
    cost: "$45",
    blurb: "You two loved the last show here.",
  },
];
```

2. In the test `"normalizes optional fields to null when the model returns invalid types"`, add `"blurb":"why not"` to the inline pick JSON and `blurb: "why not"` to the expected object:

```ts
            `<picks>[{"title":"X","start":"2026-05-02T19:00:00-07:00","url":"https://x","blurb":"why not"}]</picks>` +
```

```ts
    expect(result.picks[0]).toEqual({
      title: "X",
      start: "2026-05-02T19:00:00-07:00",
      end: null,
      venue: null,
      url: "https://x",
      cost: null,
      blurb: "why not",
    });
```

- [ ] **Step 2: Write the failing test**

Add to `test/suggest.test.ts`:

```ts
  it("throws when a pick is missing blurb", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: `<picks>[{"title":"X","start":"2026-05-02T19:00:00-07:00","url":"https://x"}]</picks><email>body</email>`,
        },
      ],
    });

    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow(
      /missing required fields/i
    );
  });
```

- [ ] **Step 3: Run tests to verify the new test fails**

Run: `npm test -- test/suggest.test.ts`
Expected: `"throws when a pick is missing blurb"` FAILS (the pick currently parses fine without blurb; the promise resolves). The normalize test may also fail until Step 4.

- [ ] **Step 4: Implement schema + validation**

In `src/types.ts`, extend `Pick`:

```ts
export interface Pick {
  title: string;
  start: string;          // ISO 8601 datetime, Phoenix offset (-07:00); model is asked to provide this even when only date is known
  end: string | null;
  venue: string | null;
  url: string;
  cost: string | null;    // free-form: "$30-45", "free", null if unknown
  blurb: string;          // 1-2 sentences on why it fits; rendered as the card body in the email
}
```

In `src/suggest.ts` `parsePicks`, update the required-field check and returned object:

```ts
    if (
      typeof o.title !== "string" ||
      typeof o.start !== "string" ||
      typeof o.url !== "string" ||
      typeof o.blurb !== "string"
    ) {
      throw new Error(`<picks>[${i}] missing required fields title/start/url/blurb`);
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
```

In `SYSTEM_PROMPT`, add a `blurb` line to the picks field list (after `"cost"`):

```
     "cost":  string (e.g. "$30-45", "free") or null,
     "blurb": string — one or two sentences on why this fits them. Voice: a friend who knows them, not a tour guide. Plain text, no markdown.
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/suggest.ts test/suggest.test.ts
git commit -m "Add required blurb field to pick schema"
```

---

### Task 3: `src/render.ts` — calendar URLs and the email template

**Files:**
- Create: `src/render.ts`
- Test: create `test/render.test.ts`

**Interfaces:**
- Consumes: `Pick` (with `blurb`) from `src/types.ts`; `marked` (already a dependency).
- Produces:
  - `googleCalendarUrl(pick: Pick): string` — Google Calendar template URL.
  - `buildDigestEmail(intro: string, picks: Pick[]): Promise<{ html: string; text: string }>` — async because `marked()` is awaited (matches existing `email.ts` usage). Task 4 calls this from `sendDigest`.

- [ ] **Step 1: Write the failing tests**

Create `test/render.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { googleCalendarUrl, buildDigestEmail } from "../src/render";
import type { Pick } from "../src/types";

const basePick: Pick = {
  title: "First Friday Art Walk",
  start: "2026-08-14T19:00:00-07:00",
  end: "2026-08-14T21:00:00-07:00",
  venue: "Roosevelt Row",
  url: "https://example.com/artwalk",
  cost: "free",
  blurb: "Your kind of low-key evening, and it's free.",
};

describe("googleCalendarUrl", () => {
  it("builds a template URL with Phoenix-local floating times and ctz", () => {
    const url = new URL(googleCalendarUrl(basePick));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("First Friday Art Walk");
    expect(url.searchParams.get("dates")).toBe("20260814T190000/20260814T210000");
    expect(url.searchParams.get("ctz")).toBe("America/Phoenix");
    expect(url.searchParams.get("location")).toBe("Roosevelt Row");
    expect(url.searchParams.get("details")).toContain("Your kind of low-key evening");
    expect(url.searchParams.get("details")).toContain("https://example.com/artwalk");
  });

  it("defaults a null end to start + 2 hours", () => {
    const url = new URL(googleCalendarUrl({ ...basePick, end: null }));
    expect(url.searchParams.get("dates")).toBe("20260814T190000/20260814T210000");
  });

  it("omits location when venue is null", () => {
    const url = new URL(googleCalendarUrl({ ...basePick, venue: null }));
    expect(url.searchParams.has("location")).toBe(false);
  });

  it("renders Phoenix wall time even if the model used a Z offset", () => {
    // 2026-08-15T02:00:00Z === 2026-08-14T19:00:00-07:00
    const url = new URL(
      googleCalendarUrl({ ...basePick, start: "2026-08-15T02:00:00Z", end: null })
    );
    expect(url.searchParams.get("dates")).toBe("20260814T190000/20260814T210000");
  });

  it("URL-encodes special characters in fields", () => {
    const raw = googleCalendarUrl({ ...basePick, title: "Dine & Dash?" });
    const url = new URL(raw);
    expect(url.searchParams.get("text")).toBe("Dine & Dash?");
    expect(raw).not.toContain("Dine & Dash?"); // must not appear un-encoded
  });
});

describe("buildDigestEmail", () => {
  it("renders header, intro markdown, and one card per pick", async () => {
    const { html } = await buildDigestEmail("A **packed** week.", [basePick]);
    expect(html).toContain("Things to do this week");
    expect(html).toContain("<strong>packed</strong>");
    expect(html).toContain("First Friday Art Walk");
    expect(html).toContain("Your kind of low-key evening");
    expect(html).toContain('href="https://example.com/artwalk"');
    expect(html).toContain("calendar.google.com/calendar/render");
    // Metadata line: Phoenix-local weekday/time, venue, cost
    expect(html).toContain("Fri");
    expect(html).toContain("7:00");
    expect(html).toContain("Roosevelt Row");
    expect(html).toContain("free");
  });

  it("HTML-escapes model-controlled fields", async () => {
    const { html } = await buildDigestEmail("intro", [
      { ...basePick, title: '<script>alert("x")</script>', blurb: "a & b < c" },
    ]);
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a &amp; b &lt; c");
  });

  it("builds a text part from the same data", async () => {
    const { text } = await buildDigestEmail("A quiet week.", [basePick]);
    expect(text).toContain("Things to do this week");
    expect(text).toContain("A quiet week.");
    expect(text).toContain("First Friday Art Walk");
    expect(text).toContain("https://example.com/artwalk");
    expect(text).toContain("calendar.google.com/calendar/render");
  });

  it("uses only inline styles (no style/link tags)", async () => {
    const { html } = await buildDigestEmail("intro", [basePick]);
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toMatch(/<link[\s>]/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/render.test.ts`
Expected: FAIL — `Cannot find module '../src/render'` (or equivalent resolve error).

- [ ] **Step 3: Implement `src/render.ts`**

```ts
import { marked } from "marked";
import type { Pick } from "./types";

const HOUR_MS = 60 * 60 * 1000;
// Phoenix doesn't observe DST, so a fixed UTC-7 offset is always correct.
const PHOENIX_UTC_OFFSET_MS = 7 * HOUR_MS;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Epoch ms → Google Calendar local floating stamp (YYYYMMDDTHHMMSS) in Phoenix wall time.
function gcalStamp(ms: number): string {
  return new Date(ms - PHOENIX_UTC_OFFSET_MS).toISOString().slice(0, 19).replace(/[-:]/g, "");
}

export function googleCalendarUrl(pick: Pick): string {
  const startMs = Date.parse(pick.start);
  const endMs = pick.end ? Date.parse(pick.end) : startMs + 2 * HOUR_MS;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: pick.title,
    dates: `${gcalStamp(startMs)}/${gcalStamp(endMs)}`,
    ctz: "America/Phoenix",
    details: `${pick.blurb}\n\n${pick.url}`,
  });
  if (pick.venue) params.set("location", pick.venue);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// "Fri, Aug 14, 7:00 PM · Roosevelt Row · free" — venue/cost omitted when null.
function metaLine(pick: Pick): string {
  const when = new Date(pick.start).toLocaleString("en-US", {
    timeZone: "America/Phoenix",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return [when, pick.venue, pick.cost].filter(Boolean).join(" · ");
}

const LINK_STYLE =
  "display:inline-block;padding:8px 14px;border-radius:6px;font-size:13px;text-decoration:none;";

function card(pick: Pick): string {
  return `<div style="background:#ffffff;border:1px solid #e2e0da;border-radius:8px;padding:16px;margin-bottom:12px;">
  <div style="font-size:17px;font-weight:600;color:#1a1a1a;">${escapeHtml(pick.title)}</div>
  <div style="font-size:13px;color:#777777;margin:2px 0 8px;">${escapeHtml(metaLine(pick))}</div>
  <div style="font-size:14px;line-height:1.5;color:#333333;margin-bottom:12px;">${escapeHtml(pick.blurb)}</div>
  <a href="${escapeHtml(pick.url)}" style="${LINK_STYLE}background:#f0efe9;color:#1a1a1a;">Details</a>
  <a href="${escapeHtml(googleCalendarUrl(pick))}" style="${LINK_STYLE}background:#1a73e8;color:#ffffff;margin-left:8px;">＋ Add to Calendar</a>
</div>`;
}

function textBlock(pick: Pick): string {
  return [
    `* ${pick.title} — ${metaLine(pick)}`,
    `  ${pick.blurb}`,
    `  Details: ${pick.url}`,
    `  Add to calendar: ${googleCalendarUrl(pick)}`,
  ].join("\n");
}

export async function buildDigestEmail(
  intro: string,
  picks: Pick[]
): Promise<{ html: string; text: string }> {
  const introHtml = await marked(intro);
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#f5f4f0;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <h1 style="font-size:22px;margin:0 0 8px;color:#1a1a1a;">Things to do this week</h1>
    <div style="font-size:15px;line-height:1.5;color:#444444;margin-bottom:20px;">${introHtml}</div>
    ${picks.map(card).join("\n")}
  </div>
</body>
</html>`;

  const text = ["Things to do this week", "", intro, "", ...picks.map(textBlock)].join("\n");
  return { html, text };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/render.test.ts`
Expected: all PASS. If the `metaLine` assertions fail on exact strings, check workerd's `toLocaleString` output format ("Fri, Aug 14, 7:00 PM") — the tests only assert substrings ("Fri", "7:00") to stay locale-format tolerant; do not tighten them.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test` — all PASS.

```bash
git add src/render.ts test/render.test.ts
git commit -m "Add render module: digest email template + Google Calendar links"
```

---

### Task 4: Rewire `sendDigest` to render from picks

**Files:**
- Modify: `src/email.ts` (`sendDigest` signature + body)
- Modify: `src/index.ts:40-54` (suggest result handling + `sendDigest` call)
- Test: `test/email.test.ts`, `test/index.test.ts`

**Interfaces:**
- Consumes: `buildDigestEmail(intro, picks)` from Task 3.
- Produces: `sendDigest(env: Env, intro: string, picks: Pick[], weekOf: Date): Promise<void>`. `sendFailure` unchanged. Task 5 relies on this exact signature.
- Interim note: until Task 5, `index.ts` passes the model's old full `<email>` body as `intro` — types line up; the semantics finish switching in Task 5.

- [ ] **Step 1: Update the email tests to the new signature**

Replace the `sendDigest` describe block in `test/email.test.ts` (keep `sendFailure` block untouched). Add the pick fixture near `baseEnv`:

```ts
import type { Env, Pick } from "../src/types";

const samplePick: Pick = {
  title: "First Friday Art Walk",
  start: "2026-08-14T19:00:00-07:00",
  end: null,
  venue: "Roosevelt Row",
  url: "https://example.com/artwalk",
  cost: "free",
  blurb: "Low-key and free.",
};
```

```ts
describe("sendDigest", () => {
  it("posts JSON to Resend with rendered html and text built from intro + picks", async () => {
    await sendDigest(baseEnv, "Hello **world**", [samplePick], new Date("2026-04-26T14:00:00Z"));

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body);
    expect(body.from).toBe('"Things to do" <digest@example.com>');
    expect(body.to).toBe("me@gmail.com");
    expect(body.subject).toMatch(/^Things to do this week — /);
    // text part carries intro + pick data
    expect(body.text).toContain("Hello **world**");
    expect(body.text).toContain("First Friday Art Walk");
    expect(body.text).toContain("calendar.google.com/calendar/render");
    // html part is the rendered template
    expect(body.html).toMatch(/<strong>world<\/strong>/);
    expect(body.html).toContain("First Friday Art Walk");
    expect(body.html).toContain("calendar.google.com/calendar/render");
  });

  it("throws on non-2xx response from Resend", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 })
    );
    await expect(
      sendDigest(baseEnv, "x", [samplePick], new Date())
    ).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/email.test.ts`
Expected: FAIL — `sendDigest` still has the old `(env, markdown, weekOf)` signature; text/html assertions don't match.

- [ ] **Step 3: Implement the new `sendDigest`**

In `src/email.ts`, replace the imports and `sendDigest`:

```ts
import type { Env, Pick, Stage } from "./types";
import { buildDigestEmail } from "./render";
```

(remove the now-unused `import { marked } from "marked";`)

```ts
export async function sendDigest(
  env: Env,
  intro: string,
  picks: Pick[],
  weekOf: Date
): Promise<void> {
  const subject = `Things to do this week — ${weekOf.toLocaleDateString("en-US", {
    timeZone: "America/Phoenix",
    month: "short",
    day: "numeric",
  })}`;
  const { html, text } = await buildDigestEmail(intro, picks);
  await send(env, { subject, text, html });
}
```

- [ ] **Step 4: Update `index.ts` and its tests**

In `src/index.ts`, change the types import to include `Pick`:

```ts
import type { Env, Pick, Stage } from "./types";
```

then replace the suggest + email stages of `runDigest`:

```ts
  let suggestions: { body: string; picks: Pick[] };
  try {
    suggestions = await generateSuggestions(env, events, new Date());
    console.log(
      `generated suggestions, ${suggestions.body.length} chars, ${suggestions.picks.length} picks`
    );
  } catch (e) {
    throw new StageError("suggest", e);
  }

  try {
    await sendDigest(env, suggestions.body, suggestions.picks, new Date());
    console.log("digest sent");
  } catch (e) {
    throw new StageError("email", e);
  }
```

In `test/index.test.ts`, update the happy-path assertion:

```ts
    expect(sendDigest).toHaveBeenCalledWith(env, "# digest", [], expect.any(Date));
```

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test` — all PASS.

```bash
git add src/email.ts src/index.ts test/email.test.ts test/index.test.ts
git commit -m "Render digest email from intro + picks via render module"
```

---

### Task 5: Switch the model contract to `<intro>` + `<picks>`

**Files:**
- Modify: `src/suggest.ts` (`SYSTEM_PROMPT`, extraction, return type)
- Modify: `src/index.ts` (`suggestions.body` → `suggestions.intro`)
- Test: `test/suggest.test.ts`, `test/index.test.ts`

**Interfaces:**
- Consumes: `sendDigest(env, intro, picks, weekOf)` from Task 4.
- Produces: `generateSuggestions(env, events, today): Promise<{ intro: string; picks: Pick[] }>` — the `body` field is gone. Errors: `"No <intro> block in Anthropic response"`, `"Empty <intro> block in Anthropic response"` (suggest-stage failures, existing `StageError` routing unchanged).

- [ ] **Step 1: Rewrite the suggest tests for the new contract**

In `test/suggest.test.ts`, apply these changes:

1. Every mock payload that contains `<email>...</email>` switches to `<intro>...</intro>`; every `result.body` assertion becomes `result.intro`. E.g. the first test's final text block becomes:

```ts
        {
          type: "text",
          text:
            "Here's everything:\n" +
            `<picks>\n${JSON.stringify(samplePicks)}\n</picks>\n` +
            "<intro>\nA packed week ahead.\n</intro>\n" +
            "And some trailing chatter.",
        },
```

with assertions:

```ts
    expect(result.intro).toBe("A packed week ahead.");
    expect(result.intro).not.toContain("interim narration");
    expect(result.intro).not.toContain("trailing chatter");
    expect(result.picks).toEqual(samplePicks);
```

2. System-prompt assertions in the first test:

```ts
    expect(call.system).toContain("<intro>");
    expect(call.system).toContain("<picks>");
    expect(call.system).toContain("next 7 days");
    expect(call.system).toContain("3 weeks");
```

(replacing `expect(call.system).toContain("<email>")`).

3. The cross-block spanning test:

```ts
  it("extracts tags even when they span across joined text blocks", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [
        { type: "text", text: `<picks>${JSON.stringify(samplePicks)}</picks>` },
        { type: "text", text: "narration <intro>start of intro" },
        { type: "text", text: "rest of intro</intro> trailing" },
      ],
    });

    const result = await generateSuggestions(baseEnv, [], new Date());
    expect(result.intro).toBe("start of intro\n\nrest of intro");
    expect(result.picks).toHaveLength(1);
  });
```

4. Error tests renamed and re-targeted:

```ts
  it("throws when <intro> is missing", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [{ type: "text", text: `<picks>${JSON.stringify(samplePicks)}</picks> nothing else` }],
    });

    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow(/<intro>/);
  });

  it("throws when <intro> is empty", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [
        { type: "text", text: `<picks>${JSON.stringify(samplePicks)}</picks><intro>   </intro>` },
      ],
    });

    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow(/empty/i);
  });
```

5. Remaining `<email>body</email>` fragments in the picks-error tests (missing picks, malformed JSON, missing required fields, missing blurb) become `<intro>body</intro>`. The retry tests' payloads use `<intro>ok</intro>` and assert `result.intro`. The `"no text content"` test expects `/​<intro>/`:

```ts
    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow(/<intro>/);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/suggest.test.ts`
Expected: widespread FAIL — extraction still looks for `<email>`, return shape still `{ body, picks }`.

- [ ] **Step 3: Implement the contract switch in `src/suggest.ts`**

Replace `SYSTEM_PROMPT` in full:

```ts
const SYSTEM_PROMPT = `You pick this week's activities for Tim & Jess in the Phoenix/Tempe area. Given their taste profile and their calendar, suggest 3-5 specific events you can verify via web search.

Suggest only events happening in the NEXT 7 DAYS. The calendar feed covers the next 3 weeks so you can see what's already planned: skip anything already on the calendar, including equivalents of a future-week entry (same show, exhibit, or event on a different date). If you can't verify something is real and happening this week, drop it.

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
```

Replace the extraction block at the end of `generateSuggestions`:

```ts
  const introMatch = fullText.match(/<intro>([\s\S]*?)<\/intro>/i);
  if (!introMatch) throw new Error("No <intro> block in Anthropic response");
  const intro = introMatch[1].trim();
  if (!intro) throw new Error("Empty <intro> block in Anthropic response");

  const picks = parsePicks(fullText);

  return { intro, picks };
```

and update the function's return type to `Promise<{ intro: string; picks: Pick[] }>`.

- [ ] **Step 4: Update `index.ts` and its tests**

In `src/index.ts`:

```ts
  let suggestions: { intro: string; picks: Pick[] };
  try {
    suggestions = await generateSuggestions(env, events, new Date());
    console.log(
      `generated suggestions, ${suggestions.intro.length} chars intro, ${suggestions.picks.length} picks`
    );
  } catch (e) {
    throw new StageError("suggest", e);
  }

  try {
    await sendDigest(env, suggestions.intro, suggestions.picks, new Date());
    console.log("digest sent");
  } catch (e) {
    throw new StageError("email", e);
  }
```

In `test/index.test.ts`, update the mock default:

```ts
  vi.mocked(generateSuggestions).mockReset().mockResolvedValue({ intro: "# digest", picks: [] });
```

(the happy-path `sendDigest` assertion from Task 4 — `(env, "# digest", [], expect.any(Date))` — still holds).

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test` — all PASS.

```bash
git add src/suggest.ts src/index.ts test/suggest.test.ts test/index.test.ts
git commit -m "Switch model contract to <intro> + <picks> with blurbs"
```

---

### Task 6: Docs, typecheck, deploy, live E2E

**Files:**
- Modify: `CLAUDE.md` (pipeline + extraction + spec-deltas sections)
- No new tests; this is the verification gate.

**Interfaces:**
- Consumes: everything above.
- Produces: deployed Worker; CLAUDE.md matches reality.

- [ ] **Step 1: Update CLAUDE.md**

Three accuracy fixes (keep everything else, especially the do-not-regress framing):

1. Pipeline item 2 (`calendar.ts`): "fetches the next 7 days" → "fetches the next 21 days (suggestions target 7; the extra weeks let the model skip already-planned events)".
2. Pipeline item 3/4 and the "Anthropic output extraction" section: the tagged blocks are now `<intro>` (markdown opener) + `<picks>` (JSON incl. required `blurb`); `<email>` no longer exists. The tag-wrap + regex-over-joined-text-blocks contract statement stays verbatim. Item 4 (`email.ts`): body is built by `src/render.ts` (`buildDigestEmail`) — inline-styled cards from picks with Google Calendar template links; `marked` renders only the intro.
3. "Spec deltas" → Output contract bullet: `<intro>` + `<picks>` (with `blurb`), Worker renders the email deterministically; add a bullet for the 21-day calendar window and per-pick add-to-calendar links.

- [ ] **Step 2: Full verification**

```bash
npm test
npx tsc --noEmit
```

Expected: all tests PASS; zero type errors.

- [ ] **Step 3: Commit docs**

```bash
git add CLAUDE.md
git commit -m "Update CLAUDE.md for intro+picks contract, render module, 21-day window"
```

- [ ] **Step 4: Deploy and live E2E**

```bash
npm run deploy
```

Then trigger a real run (TRIGGER_SECRET is in `.dev.vars`):

```bash
source .dev.vars 2>/dev/null || true
curl -s "https://<worker-url>/run?key=$TRIGGER_SECRET"
```

Expected: `Started` (202). Verify with the user (they check Gmail): styled card email arrived, Details links work, an Add-to-Calendar link opens a prefilled Google Calendar event at the right Phoenix time. If the model fails the new contract (e.g. `No <intro> block`), diagnose with `tsx scripts/test-suggest.ts` per CLAUDE.md.

- [ ] **Step 5: Final commit/push if user approves**

```bash
git push
```
