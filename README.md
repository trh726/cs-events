# cs-events — a weekly "things to do" digest, personalized by Claude

[![tests](https://github.com/trh726/cs-events/actions/workflows/test.yml/badge.svg)](https://github.com/trh726/cs-events/actions/workflows/test.yml)

Every Friday at 7am, my wife and I get an email with 3–5 real, verified
events happening near us that week — picked to match our taste, aware of
what's already on our calendar, each with a one-click "add to Google
Calendar" button.

It's a single Cloudflare Worker. No database, no UI, no framework. One
cron trigger, four pipeline stages, and a markdown file describing what
we like.

```
cron (Fri 7am Phoenix)
  │
  ▼
Google Calendar ──► next 21 days of events, every writable calendar
  │
  ▼
Claude (web_search tool) ──► 3–5 picks it can verify actually exist,
  │                          skipping days we're already booked
  ▼
Resend ──► styled HTML email with per-pick add-to-calendar links
```

## Why it's interesting (the engineering bits)

- **Structured output from a tool-using model.** When Claude runs web
  searches, its narration and final answer can land in the *same* text
  block, so you can't slice `response.content` by block type. The
  contract instead asks the model to wrap output in `<intro>` (markdown)
  and `<picks>` (JSON) tags, extracted by regex from the joined text.
  The Worker then renders the email deterministically from that JSON —
  the model never authors raw HTML.
- **Streaming to survive the edge.** Web search keeps the connection
  silent for a minute-plus, which 524s at Cloudflare's ~100s idle limit
  if you buffer the response. The Anthropic call streams SSE the whole
  time (`messages.stream(...).finalMessage()`), and the manual-trigger
  endpoint likewise streams heartbeats so the run isn't cancelled when
  the response would otherwise close.
- **Failure routing.** Each pipeline stage re-throws as
  `StageError(stage, cause)`, so when something breaks, the failure
  email says *which stage* — auth, calendar, suggest, or email.
- **Tests run in the real Workers runtime.** Vitest via
  `@cloudflare/vitest-pool-workers` executes the suite under workerd,
  not Node, so runtime quirks show up in tests instead of production.
- **A cron with no DST logic**, because Phoenix doesn't observe DST.
  `0 14 * * 5` is 7am local, forever.

## Taste is a markdown file

The only "personalization engine" is [`src/taste.example.md`](src/taste.example.md):
plain markdown describing what you like, what you don't, pacing, and
budget. It's bundled into the Worker at build time and pasted into the
prompt. Copy it to `src/taste.md` (gitignored — mine is personal) and
edit by hand.

## Running your own

You'll need: a Cloudflare account, an Anthropic API key, a
[Resend](https://resend.com) account with a verified domain, and a
Google Cloud OAuth client (Desktop type) with the Calendar API enabled.

```sh
npm install
cp src/taste.example.md src/taste.md   # then make it yours
cp .dev.vars.example .dev.vars         # fill in the values below
npm run bootstrap                      # mints the Google refresh token via local browser
npm test
npm run push-secrets                   # pushes .dev.vars to Cloudflare as Worker secrets
npm run deploy
```

Secrets (in `.dev.vars`, pushed to Cloudflare by `push-secrets`):

| Key | What it is |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client for Calendar read access |
| `GOOGLE_REFRESH_TOKEN` | Minted by `npm run bootstrap` |
| `RECIPIENT_EMAIL` | Where the digest goes |
| `RESEND_API_KEY` | Resend API key |
| `FROM_EMAIL_DOMAIN` | Verified sending domain (bare domain; sender is `digest@` it) |
| `TRIGGER_SECRET` | Guards the manual-trigger endpoint |

### Day-to-day

- `npm run dev` then hit `http://localhost:8787/__scheduled` to fire the
  cron handler locally.
- `curl "https://<your-worker>/run?key=$TRIGGER_SECRET"` triggers a real
  run without waiting for Friday (constant-time key compare; streams
  progress until the run finishes).
- `tsx scripts/test-suggest.ts` streams the Anthropic response
  event-by-event with timestamps — the diagnostic for when the suggest
  stage misbehaves.

## License

MIT
