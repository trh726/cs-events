# Things-to-Do Suggester — v1 Design

**Date:** 2026-04-26
**Status:** Approved, ready for implementation planning
**Supersedes:** `plan.md` (the original v1 sketch)

This document is the consolidated v1 design. It is the authoritative input to the implementation plan. `plan.md` remains in the repo as the original sketch and is referenced where the prose still applies (notably `taste.md` content and the v1 / v2 scope fence).

---

## 1. Goal & scope

A weekly email digest of personalized "things to do this week" suggestions for Tim & Jess in the Phoenix/Tempe area. One Cloudflare Worker, one Cron Trigger, one hand-edited `taste.md`. No database, no app, no auth (beyond a shared secret on a manual trigger).

**Non-goals for v1** (carried verbatim from `plan.md` — these stay fenced out):
- No history of past suggestions
- No feedback capture
- No long-horizon "Scout"
- No watchlist or saved items
- No budget tracking
- No second user
- No web UI
- No D1 or other database
- No interview flow to bootstrap `taste.md`
- No automatic `taste.md` learning

**Success criteria** (also from `plan.md`): after 4 weeks, did the digest arrive every Friday without intervention; did suggestions feel personalized; which limits did real use expose?

---

## 2. Architecture

| | |
|---|---|
| Runtime | Cloudflare Workers, Workers Paid plan ($5/mo) |
| Schedule | Cron Trigger `0 14 * * 5` (Fri 14:00 UTC = Fri 7:00 Phoenix; Arizona doesn't observe DST so this is year-round) |
| Language | TypeScript |
| Bundler | Wrangler default (esbuild) |
| Storage | None. `taste.md` is bundled at deploy time via Wrangler text rule. |
| Secrets | Wrangler secrets in production; `.dev.vars` locally. |
| Observability | Workers Logs (`[observability] enabled = true`), 100% sampling, ~7-day retention. |

**Locked dependency picks:**
- `@anthropic-ai/sdk` — handles `messages.create` and the `web_search` tool-use response shape
- `marked` — markdown→HTML for the email body (~30kb, runs in Workers)
- `fetch` for Google APIs (Calendar, Gmail, OAuth token endpoint) — **not `googleapis`**, which depends on Node APIs and is painful in Workers
- Dev: `wrangler`, `vitest`, `@cloudflare/vitest-pool-workers`, `typescript`, `tsx` (for the bootstrap script)

**Email transport: Gmail API.** Sends from your Gmail account to itself, using the same OAuth refresh token as the calendar fetch (just with a wider scope). Removes the Resend account, the `RESEND_API_KEY` secret, and the `FROM_EMAIL` secret. Gmail's free-tier send quota is 500/day; we send ~1/week.

**Model & web-search tool versions:**
- Default model: `claude-sonnet-4-6`
- Tool: `web_search` with `max_uses: 12` (we ask for 3–5 suggestions, and each one may need multiple searches: find candidates → verify the event is real and current → grab venue / date / link)
- Implementation must verify both strings against current Anthropic docs at build time — model IDs and tool versions drift. Haiku 4.5 is a viable cost-saver if synthesis quality is acceptable.

---

## 3. File structure

```
cutie-spout-events/
  wrangler.toml
  package.json
  tsconfig.json
  vitest.config.ts
  .dev.vars                  # gitignored, local secrets
  .gitignore
  README.md
  plan.md                    # original v1 sketch (kept for taste.md content)
  scripts/
    get-refresh-token.ts     # one-time OAuth bootstrap (Node, not Worker)
  src/
    index.ts                 # scheduled() + fetch() handlers, top-level error catch
    google-auth.ts           # refresh-token → access-token exchange (shared by calendar + email)
    calendar.ts              # Google Calendar fetch
    suggest.ts               # Anthropic call, returns markdown body
    email.ts                 # Gmail API send (success + failure variants)
    taste.md                 # editable taste profile, imported as text
    types.ts                 # shared types (Env, CalendarEvent, StageError)
  test/
    calendar.test.ts
    suggest.test.ts
    email.test.ts
    index.test.ts
    fixtures/                # canned API responses
  docs/
    superpowers/
      specs/
        2026-04-26-things-to-do-suggester-design.md   # this file
```

---

## 4. Secrets

All six, set via `wrangler secret put` for production and present in `.dev.vars` for local dev:

| Secret | Source |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `GOOGLE_CLIENT_ID` | Google Cloud console, OAuth client ID (Desktop app type) |
| `GOOGLE_CLIENT_SECRET` | same |
| `GOOGLE_REFRESH_TOKEN` | output of `scripts/get-refresh-token.ts` (grants both `calendar.readonly` and `gmail.send` scopes) |
| `RECIPIENT_EMAIL` | the inbox where the digest goes — also the authenticated Gmail account that will be the sender |
| `TRIGGER_SECRET` | `openssl rand -hex 32` — protects the manual HTTP trigger |

`.gitignore` must include `.dev.vars` and `node_modules`.

The `from` address on outgoing email is implicitly the authenticated Gmail account (Gmail API fills it in automatically when no `From:` header is provided in the raw message). For v1 this is the same address as `RECIPIENT_EMAIL`; the email arrives as "from yourself, to yourself."

---

## 5. Module-by-module design

### `src/types.ts`
```ts
export interface Env {
  ANTHROPIC_API_KEY: string;
  GOOGLE_REFRESH_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  RECIPIENT_EMAIL: string;
  TRIGGER_SECRET: string;
}

export interface CalendarEvent {
  start: string;   // ISO datetime
  end: string;     // ISO datetime
  title: string;
  location: string | null;
}

export type Stage = 'calendar' | 'suggest' | 'email';

export class StageError extends Error {
  constructor(public stage: Stage, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
    this.stack = cause instanceof Error ? cause.stack : this.stack;
  }
}
```

### `src/google-auth.ts`
One export:
- `getAccessToken(env): Promise<string>` — POST to `https://oauth2.googleapis.com/token` with `grant_type=refresh_token`, `refresh_token=env.GOOGLE_REFRESH_TOKEN`, `client_id`, `client_secret`. Returns the short-lived access token. The returned token grants both `calendar.readonly` and `gmail.send` scopes (whichever scopes the refresh token was minted with). Called once per `runDigest` invocation; the token is then passed into both `fetchUpcomingEvents` and the email module so we don't double-exchange.

### `src/calendar.ts`
One export:
- `fetchUpcomingEvents(accessToken): Promise<CalendarEvent[]>` — GET `https://www.googleapis.com/calendar/v3/calendars/primary/events` with `timeMin=now`, `timeMax=now+7d`, `singleEvents=true`, `orderBy=startTime`. Authorization header uses the access token. Filters out: all-day events (no `start.dateTime`), declined events (own `attendees[]` entry with `responseStatus === 'declined'`), and `status === 'cancelled'` events.

### `src/suggest.ts`
One export: `generateSuggestions(env, events, today): Promise<string>`.

- Imports `taste` from `./taste.md` as a string (Wrangler `Text` rule on `**/*.md`).
- System prompt: verbatim from `plan.md` § "Anthropic call" (the prose starting "You are helping me find things to do this week...").
- User message: three sections — taste profile, calendar bullets, today's date — per `plan.md`.
- Calls `anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 4096, tools: [{ type: '<verified-web-search-tool-id>', name: 'web_search', max_uses: 12 }], system, messages })`. The `<verified-web-search-tool-id>` placeholder must be replaced with the current versioned tool string from Anthropic's docs at implementation time (e.g. `web_search_20250305` was an earlier version; the current one may differ).
- **Retry once** on 429, 5xx, or network errors with ~2s backoff (per § 6 below). Helper `retryOnce(fn, isRetryable)` is local to this file — not a generic abstraction.
- Concatenates all `text` blocks from `response.content`, returns the markdown string. Throws if no text content.

### `src/email.ts`
Two exports, both POST to `https://gmail.googleapis.com/gmail/v1/users/me/messages/send` with `Authorization: Bearer <accessToken>` and `Content-Type: application/json`. Body shape: `{ raw: <base64url-encoded RFC 2822 message> }`.

- `sendDigest(env, accessToken, markdown, weekOf)` — subject `Things to do this week — {Mon DD}`. Constructs a `multipart/alternative` MIME message with two parts: `text/plain` (raw markdown) and `text/html` (`marked(markdown)`). Headers: `To: ${env.RECIPIENT_EMAIL}`, `Subject: ...`, `MIME-Version: 1.0`, `Content-Type: multipart/alternative; boundary="..."`. No `From:` header — Gmail fills it in from the authenticated account.

- `sendFailure(env, accessToken, error, stage)` — subject `Things to do — FAILED {YYYY-MM-DD}`. Single `text/plain` part. Body:
  ```
  Stage: <stage>
  Time: <ISO>

  Error: <message>

  Stack:
  <stack>
  ```

A small internal helper `buildMimeMessage({ to, subject, parts })` handles header assembly + base64url encoding (replace `+` → `-`, `/` → `_`, strip `=` padding, per Gmail API requirements). This helper is not exported.

### `src/index.ts`
Three functions:

- `scheduled(event, env, ctx)` — wraps `runDigest(env)` in try/catch; on throw, calls `sendFailure`. Uses `ctx.waitUntil` to extend the handler's lifetime past the immediate return.

- `fetch(req, env, ctx)` — GET `/run?key=$TRIGGER_SECRET`. Compares the key in constant time. The Workers runtime exposes `crypto.subtle.timingSafeEqual` as a non-standard extension; if its availability changes, fall back to a manual constant-time XOR loop over the bytes (no early return). Verify at implementation time. Returns 401 on mismatch, 405 on non-GET, 404 on unknown path. On success, runs `runDigest(env)`, returns 200 OK or 500 with the error message.

- `runDigest(env)` — the shared pipeline:
  ```
  const accessToken = await getAccessToken(env).catch(e => { throw new StageError('calendar', e) })
  const events     = await fetchUpcomingEvents(accessToken).catch(e => { throw new StageError('calendar', e) })
  const markdown   = await generateSuggestions(env, events, today).catch(e => { throw new StageError('suggest', e) })
  await sendDigest(env, accessToken, markdown, weekOf).catch(e => { throw new StageError('email', e) })
  ```
  Note: token-fetch failures are tagged `calendar` (it's part of the calendar stage in spirit — the same auth covers both, and this keeps the failure-stage taxonomy at three values).

---

## 6. Error handling

**Retry policy:**
- `calendar` → no retry; first failure throws.
- `suggest` → one retry with 2s sleep on 429, 5xx, or network/`fetch` error. Anything else (other 4xx, malformed response) throws immediately.
- `email` → no retry; first failure throws.

**Failure path:**
- Top-level `scheduled` and `fetch` handlers catch the `StageError` and call `sendFailure(env, accessToken, error, error.stage)` via `ctx.waitUntil`. `accessToken` may be `null` if the failure happened before the token exchange — in that case, sendFailure attempts its own `getAccessToken` call.
- If `sendFailure` itself throws (Gmail or Google OAuth down): log to `console.error` and re-throw, so the Worker invocation is recorded as failed in the Cloudflare dashboard. Workers Logs is the last-resort signal in this case.
- Note: when the failure stage is `calendar` (which now also covers token-exchange failures), `sendFailure` may not be able to send either, since it shares the same auth. That's an acceptable degradation — Workers Logs + the missing Friday email are sufficient signals.

**Failure email recipient:** same as `RECIPIENT_EMAIL`. No separate ops address in v1.

---

## 7. Observability

- `[observability] enabled = true` and `head_sampling_rate = 1` in `wrangler.toml`. ~7-day retention on Workers Paid; effectively free at this volume.
- `console.log` at start of `runDigest` (`"digest run started, source=cron|http"`), end (`"digest sent, suggestions chars=N"`), and at each stage transition.
- `console.error` on any caught error, including the stage tag.
- `wrangler tail` for live debugging during local dev or post-deploy verification.
- No Logpush, no external sinks.

---

## 8. Security

- `TRIGGER_SECRET` is 32 random hex bytes (`openssl rand -hex 32`).
- The HTTP handler compares the supplied `key` query param to `TRIGGER_SECRET` with `crypto.subtle.timingSafeEqual` to prevent timing leaks.
- Only `GET /run` is accepted. Any other method/path is rejected without invoking the pipeline.
- `.dev.vars` is gitignored. Production secrets live only in Wrangler's secret store.
- **OAuth blast radius:** `GOOGLE_REFRESH_TOKEN` grants `gmail.send` (send-only — cannot read or modify the inbox) and `calendar.readonly`. If leaked, an attacker can send mail as you and read your calendar; they cannot read your email. Mitigations: token lives only in Wrangler secrets; revoke at <https://myaccount.google.com/permissions> if rotation is needed (then re-run the bootstrap script).

---

## 9. Testing strategy

Smoke tests + manual end-to-end. Not full TDD.

**Framework:** Vitest with `@cloudflare/vitest-pool-workers`. All external HTTP mocked at the `fetch` boundary using `vi.stubGlobal('fetch', ...)`. Reusable fixtures in `test/fixtures/`.

**Tests (~10 total):**

| File | Tests |
|---|---|
| `google-auth.test.ts` | (1) Refresh-token → access-token happy path. (2) 401 from token endpoint throws. |
| `calendar.test.ts` | (1) Events fetched with the supplied access token; declined / all-day / cancelled events filtered out. |
| `suggest.test.ts` | (1) Builds correct system + user message, parses text blocks, returns markdown. (2) Retries once on a transient error (e.g. 529 overloaded or 503); throws after the second failure. (3) Throws immediately on a non-retryable 4xx (e.g. 400 invalid request). |
| `email.test.ts` | (1) `sendDigest` POSTs to the Gmail send endpoint with a `multipart/alternative` MIME body containing both text and HTML parts, base64url-encoded correctly (no `+`, `/`, or `=`). (2) `sendFailure` POSTs a `text/plain` MIME body with stage + stack. |
| `index.test.ts` | (1) `scheduled` happy path — stubs `getAccessToken` + the three pipeline modules, asserts `sendDigest` called. (2) `scheduled` failure path — `suggest` throws, asserts `sendFailure` called with `stage: 'suggest'`. (3) `fetch` handler: 401 on bad key, 200 on good key, 405 on POST. |

**Not tested:** `scripts/get-refresh-token.ts`, real API responses, `marked` output, prompt quality.

**Manual verification before every deploy:**
1. `wrangler dev --test-scheduled` with `.dev.vars` populated.
2. Hit `http://localhost:8787/__scheduled` to fire the cron handler against real APIs.
3. Confirm the email arrived and looks right.
4. Then `wrangler deploy`.

**No CI in v1.** GitHub Actions is v2 territory.

---

## 10. OAuth bootstrap script — `scripts/get-refresh-token.ts`

Standalone Node script (~70 lines), run once locally to mint the long-lived refresh token.

**Steps performed:**
1. Reads `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from env (or prompts to paste).
2. Starts an HTTP server on `http://localhost:53682/callback` (fixed port — must be registered as the OAuth redirect URI in Google Cloud console).
3. Builds the consent URL with:
   - `scope=https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.send` (space-separated, both scopes minted into one refresh token)
   - `access_type=offline` (required to get a refresh token)
   - `prompt=consent` (forces consent screen so refresh token always returns)
   - `response_type=code`
   - random `state` for CSRF
4. Opens the consent URL in the default browser (`open` / `xdg-open` / `start`); falls back to printing the URL.
5. Receives the redirect, validates `state`, exchanges `code` for tokens via POST to `https://oauth2.googleapis.com/token`.
6. Prints the refresh token + a copy-pasteable `wrangler secret put GOOGLE_REFRESH_TOKEN` reminder.
7. Shuts down the server.

**Run command:**
```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npx tsx scripts/get-refresh-token.ts
```

**Dependencies:** `tsx` (dev) plus Node built-ins (`http`, `crypto`, `child_process`). No Express, no `googleapis`.

**Out of scope:** token storage, encryption, multi-account support. Token is printed once; user copies it to Wrangler. If lost, re-run the script.

**When to re-run:** token revoked in Google account settings, `GOOGLE_CLIENT_SECRET` rotated, or scopes changed (Google does not auto-grant new scopes to existing refresh tokens — adding/removing a scope requires re-running the consent flow). Inactivity expiry won't happen — the weekly cron keeps the token alive.

---

## 11. Local dev & deployment workflow

### One-time setup, in order
1. `npm install`
2. **Google Cloud project**: create project → **enable Calendar API and Gmail API** → OAuth consent (External, add yourself as test user, **scopes: `calendar.readonly` and `gmail.send`**) → create OAuth client ID (Desktop app type) → add `http://localhost:53682/callback` as authorized redirect URI → copy client ID + secret.
3. Run `scripts/get-refresh-token.ts` (see § 10) → get refresh token (covers both scopes).
4. **Anthropic**: console.anthropic.com → create API key.
5. **`TRIGGER_SECRET`**: `openssl rand -hex 32`.
6. Populate `.dev.vars` with all six secrets.

### Local dev loop
```bash
npm test                                          # vitest, ~1s
npx wrangler dev --test-scheduled                 # spin up local Worker
curl http://localhost:8787/__scheduled            # fire scheduled() (real APIs)
curl "http://localhost:8787/run?key=$TRIGGER_SECRET"  # fire fetch() handler
```

### Production deploy
```bash
# Per secret, one-time:
echo "<value>" | npx wrangler secret put ANTHROPIC_API_KEY
# repeat for all 6

# Per release:
npm test && npx wrangler deploy
```

### Post-deploy verification
1. Cloudflare dashboard → Workers → **Triggers** tab: confirm cron registered.
2. Hit production manual trigger: `curl "https://<worker-url>/run?key=$TRIGGER_SECRET"`. Confirm email arrives.
3. Check **Logs** tab to see the `console.log` output.

### Iteration
- Edit `taste.md` → `wrangler deploy` → manual trigger to preview.
- Edit prompt in `src/suggest.ts` → same.

---

## 12. `taste.md`

The starter content lives in `plan.md` § "taste.md" and is copied verbatim into `src/taste.md` at project setup. From then on, `src/taste.md` is the source of truth and is edited freely.

---

## 13. Known gotchas

(Carried from `plan.md` § "Known gotchas", still applicable):

- **DST:** Phoenix doesn't observe it; `0 14 * * 5` is always 7am Phoenix.
- **Cron reliability:** Cloudflare Cron Triggers occasionally have incidents. Missing Friday email is the canary; check the dashboard.
- **Web search hallucination:** the system prompt explicitly tells the model not to invent events; spot-check links the first few weeks anyway.
- **OAuth refresh token:** doesn't expire unless revoked or unused for 6 months. The weekly cron keeps it alive.
- **Gmail send quota:** 500 messages/day for personal Gmail accounts. Effectively unlimited at this volume.
- **Adding scopes later:** Google does not auto-grant new scopes to existing refresh tokens. If you add a third scope post-deploy, re-run `scripts/get-refresh-token.ts` and `wrangler secret put GOOGLE_REFRESH_TOKEN` with the new value.
- **Gmail API "from" header:** Gmail rejects raw messages whose `From:` doesn't match the authenticated account or one of its aliases. Easiest path is to omit `From:` entirely and let Gmail fill it in (this is what `email.ts` does).

---

## 14. Implementation plan

To be produced by the `superpowers:writing-plans` skill, taking this design as input. The plan will sequence the work as roughly:

1. Repo scaffold (`package.json`, `wrangler.toml`, `tsconfig.json`, `.gitignore`, `vitest.config.ts`)
2. Types module
3. OAuth bootstrap script + Google Cloud project setup + run script to mint the refresh token (covering both scopes)
4. `google-auth.ts` + tests
5. `calendar.ts` + tests
6. `suggest.ts` + tests
7. `email.ts` + tests (Gmail API, MIME assembly, base64url)
8. Scheduled / fetch handlers + tests
9. Local end-to-end verification via `wrangler dev --test-scheduled`
10. Production deploy + post-deploy verification
