# Switch email transport from Gmail API to Resend

## Goal

Replace the Gmail API send path in `src/email.ts` with Resend's HTTP API. The Worker still sends one weekly digest and one failure email per failure; only the transport changes.

## Why

- Smaller, dedicated transactional-email surface. No MIME assembly, no base64url, no RFC 2047 encoded-word wrapping — Resend takes JSON with `from`/`to`/`subject`/`text`/`html` and handles header encoding itself.
- Decouples email send from the Google OAuth token. Today if `getAccessToken` fails inside `handleFailure`, we can't send the failure email. With Resend, only the API key is needed.

## Non-goals

- No change to Calendar reads, the Anthropic suggest stage, the cron schedule, the `/run?key=…` trigger, the failure-routing semantics, or the StageError mechanism.
- No re-bootstrap of the Google refresh token to drop `gmail.send` scope. The over-scoped token still works for Calendar; dropping the scope is a cosmetic follow-up.
- No multi-recipient work. `RECIPIENT_EMAIL` stays a single address; Jess is not on the list yet.
- No `EMAIL_TRANSPORT` toggle. Full replacement only.

## Approach

Raw `fetch` to `https://api.resend.com/emails`. Matches the codebase's existing style (`calendar.ts`, `google-auth.ts`, current `email.ts` all use plain `fetch`). No new dependency. Tests stay on the `vi.mocked(fetch)` pattern already in use.

## Env & secrets

Add to `src/types.ts` `Env`:

- `RESEND_API_KEY: string`
- `FROM_EMAIL_DOMAIN: string` — bare domain (e.g. `yourdomain.com`). The full from address is constructed in code.

Already added by Tim to `.dev.vars`. `npm run push-secrets` pushes them to Wrangler in bulk; no `wrangler.toml` change.

Unchanged: `RECIPIENT_EMAIL`, `TRIGGER_SECRET`, `ANTHROPIC_API_KEY`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

### One-time setup (out of band, by Tim)

1. Create Resend account, add the chosen sending domain, paste the SPF TXT and DKIM CNAME records into the registrar, wait for verification. (DMARC optional but recommended.)
2. Create an API key in the Resend dashboard, copy into `.dev.vars` as `RESEND_API_KEY`.
3. Set `FROM_EMAIL_DOMAIN` in `.dev.vars` to the verified domain.
4. Run `npm run push-secrets`.

## `src/email.ts` shape

Whole module collapses to approximately:

```ts
import { marked } from "marked";
import type { Env, Stage } from "./types";

const RESEND_URL = "https://api.resend.com/emails";

function fromAddress(env: Env): string {
  return `"Things to do" <digest@${env.FROM_EMAIL_DOMAIN}>`;
}

async function send(env: Env, payload: {
  subject: string;
  text: string;
  html?: string;
}): Promise<void> {
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress(env),
      to: env.RECIPIENT_EMAIL,
      ...payload,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

export async function sendDigest(env: Env, markdown: string, weekOf: Date): Promise<void> {
  const subject = `Things to do this week — ${weekOf.toLocaleDateString("en-US", {
    timeZone: "America/Phoenix",
    month: "short",
    day: "numeric",
  })}`;
  const html = await marked(markdown);
  await send(env, { subject, text: markdown, html });
}

export async function sendFailure(env: Env, error: Error, stage: Stage): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const subject = `Things to do — FAILED ${today}`;
  const text = `Stage: ${stage}\nTime: ${new Date().toISOString()}\n\nError: ${error.message}\n\nStack:\n${error.stack ?? "(no stack)"}`;
  await send(env, { subject, text });
}
```

Deleted from the module: `base64url`, `encodeHeader`, `buildMimeMessage`, `sendRawEmail`, `GMAIL_SEND_URL`.

### Signature change

`sendDigest` and `sendFailure` lose the `accessToken: string` parameter. Two call sites in `src/index.ts` update accordingly:

- `runDigest`: `await sendDigest(env, body, new Date())`.
- `handleFailure`: drop the `getAccessToken(env)` call; `await sendFailure(env, err, stage)`. The outer try/catch around `sendFailure` stays (Resend can still fail), but the failure-email path no longer transitively depends on Google.

## Failure routing

Unchanged. `try/catch` in `runDigest` still wraps the email stage as `StageError("email", e)`. `handleFailure` still calls `sendFailure` and logs `"could not send failure email"` if that itself throws.

## Tests

`test/email.test.ts` and `test/index.test.ts`:

- Replace any `vi.mocked(fetch)` URL assertion of `gmail.googleapis.com/...` with `api.resend.com/emails`.
- Assert request body parses as JSON with `from`, `to`, `subject`, `text`, and (for digest) `html` fields. Assert `Authorization: Bearer …` and `Content-Type: application/json` headers.
- Drop tests/fixtures targeting the Gmail send response shape, MIME structure, `multipart/alternative` boundaries, base64url payload, or `=?UTF-8?B?…?=` subject encoding.
- Drop standalone tests for `buildMimeMessage`, `encodeHeader`, `base64url` (functions removed).
- Update `sendDigest`/`sendFailure` call sites in `index.test.ts` to the new signatures (no `accessToken` argument).
- Keep the `StageError("email", …)` coverage case. The wrap is unchanged; only the underlying error message text differs (`"Resend send failed: …"`).

No new test categories. The integration assertion shape ("right URL, right fields") stays the same.

## CLAUDE.md updates

In the "Spec deltas" section:

- **Email transport** bullet: change to reflect that Resend is now the transport. Remove the line claiming `RESEND_API_KEY` / `FROM_EMAIL` don't exist.
- Add `RESEND_API_KEY` and `FROM_EMAIL_DOMAIN` to any secret listing.

In the pipeline-architecture section: replace the Gmail-API description of `email.ts` with a one-liner about Resend HTTP. Drop the "RFC 2047 encoded-word wrapping" note (no longer applies).

`plan.md` left as-is — it's the historical spec; CLAUDE.md is the living doc.

## Bootstrap script

Left as-is. `npm run bootstrap` still mints a Google refresh token with Calendar + Gmail scopes. The Gmail scope becomes unused but doesn't break anything. Re-bootstrap to drop it is optional cleanup, not part of this change.

## Risks & mitigations

- **Domain not verified yet at deploy time.** First send 4xxs from Resend. Mitigation: spec calls out the verify-domain step before pushing secrets.
- **Wrong `FROM_EMAIL_DOMAIN`.** Resend rejects with a clear error; surfaces as a `StageError("email", …)` failure email — except that failure email also can't send. Mitigation: do a manual `/run?key=…` after first deploy to catch this synchronously rather than via cron.
- **API key leak.** Same surface as any other secret in `.dev.vars` / Wrangler secrets. No new exposure.
