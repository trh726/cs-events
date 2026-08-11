# Styled Email, Add-to-Calendar Links, and 21-Day Lookahead — Design

**Date:** 2026-08-09
**Status:** Approved

## Goal

Three improvements to the weekly digest Worker:

1. **Styled HTML email** — replace the bare `marked` output with an inline-styled template that renders each suggestion as a card.
2. **Add-to-Calendar links** — give the currently-unused `picks` JSON a consumer: each card gets a Google Calendar template link built from structured pick data.
3. **21-day calendar lookahead** — fetch 3 weeks of calendar events (suggestions still target the next 7 days) so the model stops suggesting events the couple already has planned in a future week.

Explicitly out of scope: model change (stays `claude-sonnet-4-6`), dark-mode email styling, KV/dedup state, failure-email styling.

## 1. Model contract: `<intro>` + richer `<picks>` (replaces `<email>`)

The system prompt in `src/suggest.ts` changes to request two tagged blocks:

- `<intro>` — 1–2 sentences on the shape of the week, markdown allowed.
- `<picks>` — the same JSON array as today, plus one new **required** field per pick:
  - `"blurb"`: string — one or two sentences on why this pick fits, in the same
    friend-who-knows-you voice. Treated as plain text downstream (no markdown).

The `<email>` block and the "Honorable mention" special case are removed. Every
recommendation is a pick; 3–5 picks total.

Extraction remains **tag-based regex over joined text blocks** — the guarded
contract from CLAUDE.md ("Anthropic output extraction — do not regress") is
preserved; only the tag names change. `parsePicks` additionally requires
`blurb` to be a string. `generateSuggestions` returns `{ intro: string,
picks: Pick[] }` instead of `{ body, picks }`. A missing/empty `<intro>` or
`<picks>` block is a suggest-stage failure (existing `StageError("suggest")`
routing).

`Pick` in `src/types.ts` gains `blurb: string`.

## 2. Calendar lookahead: fetch 21 days, suggest for 7

`fetchUpcomingEvents` in `src/calendar.ts` widens `timeMax` from 7 to 21 days
(one constant). Merge/sort/format code is range-agnostic and unchanged.

The prompt states explicitly: suggest only events happening in the **next 7
days**; the calendar feed covers the next **3 weeks** so the model can see
what's already planned. If an event (or its equivalent — same show, different
date) appears anywhere in the 21-day window, skip it, even when the calendar
entry is in a later week.

## 3. Email rendering: template built from picks

New module `src/render.ts` exposing a pure function (keeps `email.ts` a thin
transport; rendering/escaping/URL-building get their own testable unit):

```ts
buildDigestEmail(intro: string, picks: Pick[]): { html: string; text: string }
```

### HTML

- Single centered column (~600px max-width), system font stack, **all styles
  inline** (email clients strip stylesheets). Light theme only.
- Structure: header ("Things to do this week"), intro rendered through
  `marked`, then one card per pick:
  - Title
  - Muted metadata line built from structured fields:
    `Fri Aug 14 · 7:00 PM · Crescent Ballroom · $30-45`
    (weekday/date/time formatted in `America/Phoenix`; venue and cost omitted
    when null)
  - Blurb (plain text)
  - Two links: **Details** → pick `url`, **＋ Add to Calendar** → Google
    Calendar template URL

### Google Calendar template URL

`https://calendar.google.com/calendar/render?action=TEMPLATE&…` with:

- `text` = title
- `dates` = local floating times `YYYYMMDDTHHMMSS/YYYYMMDDTHHMMSS` plus
  `ctz=America/Phoenix` (no DST math — Phoenix doesn't observe DST, matching
  the project rule). Null `end` → start + 2 hours.
- `location` = venue (when present)
- `details` = blurb + source URL

No Google API calls, no write scopes — pure link construction. Opens in
whichever Google account taps it.

### Escaping

Title, venue, cost, and blurb are model output landing in HTML: HTML-escape
all of them. All calendar-URL params are URL-encoded
(`URLSearchParams`-style). Blurb is never rendered as markdown.

### Plain-text part

Generated from the same data: intro, then each pick as a short block (title,
metadata line, blurb, both URLs). `text` and `html` cannot drift because they
share one source.

### Wiring

- `sendDigest(env, intro, picks, weekOf)` builds `{ html, text }` via
  `buildDigestEmail` and sends via Resend as today.
- `src/index.ts` passes `{ intro, picks }` from the suggest stage through.
- Failure emails stay plain text. Stage boundaries unchanged.

## Error handling

No new stages. Contract violations (missing tags, bad JSON, missing blurb)
fail in the suggest stage; rendering is deterministic and runs inside the
email stage.

## Testing

- `test/suggest.test.ts` — mocks emit `<intro>`/`<picks>`; assert blurb
  validation, missing-`<intro>` error, unchanged retry/streaming behavior.
- Email/render tests — card rendering, HTML escaping of model fields,
  calendar-URL builder cases: timed event with end, null end (+2h default),
  URL encoding of special characters, null venue/cost omission.
- `test/index.test.ts` — happy path updated to new `sendDigest` signature;
  StageError routing cases unchanged.

## Verification

`npm test` (31+ tests), then a live E2E via `/run?key=$TRIGGER_SECRET` to
eyeball the styled email in Gmail and tap an Add-to-Calendar link.
