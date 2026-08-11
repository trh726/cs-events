# Things-to-Do Suggester — v1 Spec

A weekly email digest of personalized suggestions for things to do, scoped tight on purpose. One Cloudflare Worker, one Cron Trigger, one hand-edited taste profile. No database, no app, no auth. The goal is to ship in an evening and use it for a month before deciding what to build next.

## What it does

Every Friday at 7am Phoenix time, a Cloudflare Worker:

1. Pulls the next 7 days of events from Google Calendar
2. Reads a `taste.md` file bundled with the Worker
3. Calls the Anthropic API with web search enabled, providing taste profile + calendar context, asking for 3-5 suggestions for things to do this week
4. Sends the formatted suggestions to a configured email address via Resend

That's the entire scope. No history tracking, no feedback capture, no watchlist, no budget logic, no app UI. Complexity is absorbed by the human (me) editing `taste.md` over time as I notice the suggestions drifting wrong.

## Architecture

- **Runtime:** Cloudflare Workers (Paid plan, $5/mo)
- **Schedule:** Cron Trigger, `0 14 * * 5` (Friday 14:00 UTC = 7am Phoenix; manually adjust for DST)
- **Language:** TypeScript
- **Dependencies:** `@anthropic-ai/sdk`, `googleapis` (or direct fetch to Calendar REST API), `resend` (or direct fetch to Resend API)
- **Storage:** None. `taste.md` is checked into the repo and bundled at deploy time.
- **Secrets:** Stored as Wrangler secrets, not in code.

## File structure

```
things-to-do/
  wrangler.toml
  package.json
  tsconfig.json
  src/
    index.ts          # main worker, scheduled handler
    calendar.ts       # Google Calendar fetch
    suggest.ts        # Anthropic API call
    email.ts          # Resend send
    taste.md          # editable taste profile (imported as text)
  README.md
```

## Secrets needed

Set via `wrangler secret put`:

- `ANTHROPIC_API_KEY`
- `GOOGLE_CALENDAR_REFRESH_TOKEN` — long-lived OAuth refresh token for my Google account
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `RESEND_API_KEY`
- `RECIPIENT_EMAIL` — where the digest goes
- `FROM_EMAIL` — verified sender on Resend

## Calendar fetch

Use the Google Calendar API `events.list` endpoint on the primary calendar. Time window: now → now + 7 days. Use the OAuth refresh token to mint an access token at runtime (no user-facing OAuth flow needed since this is a single-user tool).

Return a simplified array: `{ start, end, title, location }` for each event. Skip all-day events and declined events.

## Anthropic call

Single `messages.create` call to `claude-sonnet-4-5` (or whatever's current — verify model string).

Tools: `web_search_20250305` enabled, `max_uses: 5`.

System prompt outline:

> You are helping me find things to do this week in the Phoenix/Tempe area. I'll give you my taste profile and my calendar for the next 7 days. Suggest 3-5 specific events, activities, or outings happening this week that fit my taste and the open time on my calendar. Use web search to find current, real events with dates, venues, and links. Don't suggest things I've already got on my calendar. Don't make things up — if you can't verify an event is real and happening this week, leave it out. Format the response as a short markdown email body with each suggestion as: **Title** (date/time, venue, ~cost) — one or two sentences on why this fits, then the link.

User message structure:

```
## My taste profile

[contents of taste.md]

## My calendar, next 7 days

[bulleted list of events from calendar.ts]

## Today's date

[ISO date]

Please suggest 3-5 things for this week.
```

Read `data.content` blocks, concatenate text blocks, that's the email body.

## Email send

Resend API. Subject: `Things to do this week — {Mon DD}`. Body: the markdown the model returned, rendered as plain text or lightly converted to HTML (a markdown-to-html one-liner is fine; it doesn't have to be pretty).

If the Anthropic call or calendar fetch fails, send an email saying so rather than silently failing — the absence of a Friday email shouldn't be the only signal that something broke.

## taste.md

This is the only "config" the system has and the main lever for tuning quality. It's prose, not structured data. Starter content I'll write by hand and edit as needed:

```markdown
# Taste profile — Tim & Jess

## Who we are

Tim and Jess, married, no kids, in Tempe AZ. Cat at home. Both work from home most days. We like going out together, but a quiet weekend at home is also a real win — don't pack the calendar.

## Things we genuinely like

- Live music, especially smaller venues. Indie, alternative, rock, maybe some stadium pop.
- Craft beer and good cocktail bars. We've been around the Phoenix scene; surprise us with new openings or one-offs.
- Food events: chef collabs, pop-ups, single-night menus, charcuterie/salumi-related anything.
- Sports: Jayhawks (CFB/CBB) viewing parties, ASU (CFB/CBB) occasional D-backs or Suns game. Spring Training. Phoenix Open.
- Cultural one-offs: author talks, film screenings (especially Tempe-area indie theaters), gallery openings, new museum galleries
- Under the radar regional things: hikes we may not have done (seasonal and weather dependant), parks we may not have visited, smaller cultural sites (think Taliesin West or S'edav Va'aki Museum). These can be good fallback options for lighter weeks.
- Parts of town we may not frequent: What's up-and-coming or has new openings. Downtown Chandler, Downtown Mesa, etc.

## Things we don't want

- Generic "nightlife." Clubs, bottle service, etc. — never.
- Stadium concerts unless it's literally a once-in-a-lifetime act.
- Anything requiring more than ~45 min drive on a weeknight.
- Outdoor stuff in summer (June–Sept) unless it's after 8pm or indoor-adjacent.
- Three "going out" nights in a row. Pace matters.

## Cadence preferences

- Maybe one "big" outing per week (concert, ticketed event, destination dinner).
- Plus one or two "small" things (neighborhood bar, a tasting, a viewing party).
- Some weeks: very light or nothing. That's fine. Don't manufacture urgency. A walk around a nearby park works. A James Turrell skyspace and dinner is great.

## Budget vibe

- Casual outings: under $50 for the two of us is the sweet spot.
- Big outings: up to ~$200 is fine for something genuinely special.
- Ticket prices over $150/person need a real "why" — only suggest if it clearly clears that bar.

## Things to push us on

- New restaurants we haven't tried, especially non-chain, non-obvious neighborhoods.
- Anything regional beyond the usual.
- Indoor things in summer when we're climate-prisoners.

## Geographic notes

We're in Tempe. Scottsdale, Phoenix proper, Mesa, Chandler all fine. Anything past about Glendale or Gilbert needs to be worth the drive. Casual/lazy/light weeks should be nearby or downtown Tempe. Consider those homebase.
```

This file gets edited freely. No schema, no validation. If a suggestion lands wrong, the fix is to add a sentence to taste.md saying so.

## Deployment

```
npm install
wrangler secret put ANTHROPIC_API_KEY
# (repeat for each secret)
wrangler deploy
```

Test the scheduled handler locally:

```
npx wrangler dev --test-scheduled
# then visit http://localhost:8787/__scheduled to fire it manually
```

## What this v1 deliberately does NOT do

Listed so it doesn't get scope-crept in the build:

- No history of past suggestions (the model has none, and that's fine for a month)
- No feedback capture (no thumbs up/down, no "I bought tickets" links)
- No long-horizon "Scout" for things 3+ months out (concerts that just got announced, etc.)
- No watchlist or saved items
- No budget tracking
- No second user / Jess as her own account
- No web UI
- No D1 database
- No interview flow to bootstrap taste.md (I'll write it by hand)
- No automatic taste.md learning or diff proposals

These are all explicitly v2 territory, to be considered after a month of real use shows which of them are actually load-bearing.

## Success criteria

After 4 weeks:

1. Did I get a digest every Friday without manual intervention?
2. Did the suggestions feel like they understood me, or generic?
3. Which limits did I actually hit? (Repeats? Stale calendar awareness? Wishing I could save something for later? Wishing Jess saw it too?)

The answers to #3 are the v2 backlog. Don't pre-build for them.

## Known gotchas

- **DST:** Cron Triggers run on UTC only. Phoenix doesn't observe DST, so this is actually simpler for me than for most — `0 14 * * 5` is always 7am Phoenix year-round. (One of the perks of Arizona.)
- **Cron reliability:** Cloudflare Cron Triggers occasionally have incidents. The Friday email is the canary — if it doesn't show up, check the Workers dashboard.
- **Web search hallucination risk:** The model can invent events. The system prompt explicitly tells it not to, and to omit anything it can't verify. Worth spot-checking links the first few weeks.
- **Calendar OAuth refresh token:** Generate this once locally with a small script, then store as a Worker secret. Refresh tokens for installed-app OAuth don't expire unless revoked or unused for 6 months — the weekly cron will keep it alive.
- **Resend sender verification:** The `FROM_EMAIL` domain has to be verified in Resend before sends will work.

```

```
