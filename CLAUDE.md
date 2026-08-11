# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single Cloudflare Worker that emails Tim & Jess a weekly digest of personalized "things to do this week" suggestions. One cron, no database, no UI. The only tunable is `src/taste.md`, edited by hand. See `plan.md` for the original v1 spec — note that the implementation has diverged from it (see "Spec deltas" below).

## Commands

- `npm test` — vitest, run via `@cloudflare/vitest-pool-workers` (real Workers runtime, not Node).
- `npm test -- test/suggest.test.ts` — single file. Append `-t "name fragment"` for one test.
- `npm run dev` — `wrangler dev --test-scheduled`. Hit `http://localhost:8787/__scheduled` to fire the cron handler. The `/run?key=$TRIGGER_SECRET` endpoint is the production manual-trigger path.
- `npm run deploy` — `wrangler deploy`.
- `npm run bootstrap` — one-shot interactive flow that mints the Google OAuth refresh token (Calendar read + Gmail send scopes) via local browser redirect to `localhost:53682`.
- `npm run push-secrets` — pushes every `KEY=VALUE` from `.dev.vars` into Wrangler secrets in bulk. Safe to re-run after rotating.
- `tsx scripts/test-suggest.ts` — diagnostic that streams the Anthropic response event-by-event with timestamps. Use this when `generateSuggestions` hangs or behaves oddly; it bypasses the Worker and reads `ANTHROPIC_API_KEY` straight from `.dev.vars`.

`.dev.vars` is the source of truth for local secrets. Don't commit it. New secrets: add to `.dev.vars`, then `npm run push-secrets`.

## Pipeline architecture

`src/index.ts` is a thin orchestrator. The interesting code lives in the four stage modules. Each stage is wrapped in a `try/catch` that re-throws as `StageError(stage, cause)` (see `src/types.ts`) so `handleFailure` can route a failure email tagged with which stage broke. Every change to the pipeline shape needs to preserve this:

1. `google-auth.ts` — exchanges the long-lived refresh token for a short-lived access token used for Calendar (read); minted once per run.
2. `calendar.ts` — `fetchUpcomingEvents` lists every **selected, writable** calendar (`owner` or `writer`), then fetches the next 21 days (suggestions target 7; the extra weeks let the model skip already-planned events) from each in parallel and merges. Keeps timed *and* all-day events. Sort relies on the lexicographic property that `"YYYY-MM-DD"` (all-day) sorts before `"YYYY-MM-DDTHH:..."` on the same day — don't break this by reformatting.
3. `suggest.ts` — single Anthropic call with the `web_search` server tool. **Critical**: extraction is tag-based, not block-slicing — see "Anthropic output extraction" below.
4. `email.ts` / `render.ts` — `render.ts`'s `buildDigestEmail` builds the email body: inline-styled cards from the `picks` array (each with a Google Calendar template add-to-calendar link), with `marked` rendering only the `<intro>` markdown. `email.ts` sends via the Resend HTTP API (`POST https://api.resend.com/emails`) with JSON `{from, to, subject, text, html}`. `from` is built from `FROM_EMAIL_DOMAIN`; auth is `RESEND_API_KEY`. No MIME assembly — Resend handles header encoding.

`scheduled` runs the pipeline inside `ctx.waitUntil`. `fetch` exposes `/run?key=...` for manual triggers, gated by a constant-time compare against `env.TRIGGER_SECRET`; it returns a streaming response that stays open for the run's duration (with periodic heartbeats) rather than a fire-and-forget 202, since `waitUntil` alone gets cancelled once the fetch response completes. Both paths funnel into `runDigest` and share the same failure-email mechanism.

## Anthropic output extraction (do not regress)

The model is asked to wrap its output in `<intro>...</intro>` (markdown opener) and `<picks>...</picks>` (JSON for downstream consumers, each pick now including a required `blurb`). Extraction in `suggest.ts` joins all text blocks and runs regex against them. **Do not rewrite this to filter `response.content` by block type or "text after last `web_search_tool_result`"** — when `web_search` runs, Claude routinely packs running narration *and* the final answer into a single text block, so block boundaries can't separate them. The tag-wrap pattern is the contract. See `feedback_anthropic_tool_output_extraction.md` in the user's auto-memory for the incident history.

The web search tool type is pinned to the **basic** dated constant (`WEB_SEARCH_TOOL_TYPE = "web_search_20250305"`), deliberately **not** the dynamic-filtering `web_search_20260209`. The dynamic variant runs `code_execution` under the hood in loops that `max_uses` does not bound; in testing it never converged within the turn and the model exhausted its output budget on tool calls before writing `<intro>`/`<picks>` (surfaced as `No <intro> block in Anthropic response`). The basic variant respects `max_uses`, converges in ~60s with `stop_reason=end_turn`, and returns the same `web_search_tool_result` content-block shape. Don't switch back without re-checking convergence via `scripts/test-suggest.ts`.

The single Anthropic call is **streamed** (`client.messages.stream(...).finalMessage()`), not buffered (`messages.create`). Buffering this request 524'd at the ~100s Cloudflare edge limit because web search keeps the connection silent while it runs; streaming flows SSE events the whole time. Don't revert to `messages.create` here.

## taste.md is bundled as text, and gitignored

`wrangler.toml` has a `[[rules]]` entry that makes `**/*.md` import as a string at build time. `src/suggest.ts` imports it with `// @ts-expect-error` because TypeScript doesn't know about the rule. If you move or rename `taste.md`, update both the import path and the `vi.mock("../src/taste.md", ...)` line in `test/suggest.test.ts`.

`src/taste.md` is **gitignored** (it's personal); `src/taste.example.md` is the committed template. Wrangler bundles from disk, so deploys work fine with the file untracked — but a fresh clone has no `src/taste.md` and both `wrangler deploy` and the test suite fail without it (the workers test pool force-loads the real file even though the test mocks it). The `pretest` script seeds it from the example when missing; for dev/deploy, `cp src/taste.example.md src/taste.md` first. Don't `git add -f src/taste.md`.

## Tests

`vitest.config.ts` plugs in `@cloudflare/vitest-pool-workers`, so tests run under workerd. Practical implications:

- `vi.mock("@anthropic-ai/sdk", ...)` uses the vitest 4 factory form (returns the mocked module). Don't switch to the older auto-mock pattern — it doesn't compose with the workers pool the same way.
- Pure-JS modules like `marked` work fine. Anything that pokes Node-only APIs needs to be either mocked or guarded by `nodejs_compat` (already enabled in `wrangler.toml`).
- Tests cover the happy path *and* the StageError routing in `index.test.ts` — when adding a new pipeline stage, mirror the `StageError("<stage>", e)` wrap and add a coverage case.

## Spec deltas

`plan.md` is the original spec but the implementation has diverged in ways worth knowing before changing things:

- **Email transport**: Resend HTTP API (`POST https://api.resend.com/emails`). Secrets: `RESEND_API_KEY`, `FROM_EMAIL_DOMAIN` (bare domain; the `digest@` local-part is fixed in code). Calendar still uses the Google OAuth token; the Gmail send scope on that token is currently unused and can be dropped on the next bootstrap.
- **Model**: `claude-sonnet-4-6`, not `claude-sonnet-4-5`.
- **Web search `max_uses`**: 12, not 5. (Was bisected upward — too few caused thin suggestions.)
- **Calendar scope**: every selected writable calendar, not just primary; all-day events are kept, not skipped; the fetch window is 21 days (see "Pipeline architecture" above).
- **Output contract**: tagged blocks (`<intro>` markdown + `<picks>` JSON, each pick including a required `blurb`), not "concatenate text blocks" and not the earlier `<email>` markdown block. The Worker renders the email deterministically from these via `render.ts`, rather than trusting model-authored HTML/markdown for the whole body.
- **Per-pick calendar links**: each rendered pick card includes a Google Calendar template link (prefilled event, correct Phoenix time) so recipients can add it with one click.
- **HTTP trigger**: `/run?key=$TRIGGER_SECRET` exists in addition to the cron — useful for ad-hoc sends without waiting until Friday.

Phoenix doesn't observe DST, so the `0 14 * * 5` cron is always 7am local — don't add DST adjustment logic.
