# Switch Email Transport to Resend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Gmail API send path in `src/email.ts` with a single `fetch` to Resend's HTTP API. Remove all MIME/base64url/RFC-2047 plumbing and drop the `accessToken` parameter from the email functions.

**Architecture:** `email.ts` becomes a thin Resend client. `sendDigest`/`sendFailure` POST JSON to `https://api.resend.com/emails` with `{from, to, subject, text, html}`. Auth is the `RESEND_API_KEY` env var; sender is built from `FROM_EMAIL_DOMAIN`. The Calendar stage continues to use Google OAuth, but the email stage no longer touches Google at all.

**Tech Stack:** Cloudflare Workers, TypeScript, `vitest` with `@cloudflare/vitest-pool-workers`, `marked` (already a dep). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-30-switch-to-resend-design.md`

---

## File Map

- **Modify** `src/types.ts` — add `RESEND_API_KEY` and `FROM_EMAIL_DOMAIN` to `Env`.
- **Rewrite** `src/email.ts` — Resend HTTP send; drop `accessToken` param; delete `base64url`, `encodeHeader`, `buildMimeMessage`, `sendRawEmail`, `GMAIL_SEND_URL`.
- **Modify** `src/index.ts` — drop `accessToken` from the two email call sites; remove the `getAccessToken` call inside `handleFailure`.
- **Rewrite** `test/email.test.ts` — assert against Resend URL/JSON body shape; drop MIME helpers.
- **Modify** `test/index.test.ts` — drop `accessToken` from the two `sendDigest`/`sendFailure` call assertions.
- **Modify** `test/calendar.test.ts`, `test/google-auth.test.ts`, `test/suggest.test.ts` — only if they declare `Env` literals; add the two new fields so TypeScript stays happy. (Confirmed: `google-auth.test.ts`, `suggest.test.ts`, `index.test.ts`, `email.test.ts` all have Env literals; `calendar.test.ts` does not need a check — task verifies via grep.)
- **Modify** `CLAUDE.md` — update the email-transport bullet in "Spec deltas", update the pipeline-architecture description of `email.ts`, add the two new env vars to any secret listing, drop the "RFC 2047" sentence.

---

## Task 1: Extend `Env` type and test fixtures

**Files:**
- Modify: `src/types.ts`
- Modify: `test/email.test.ts`
- Modify: `test/index.test.ts`
- Modify: `test/google-auth.test.ts`
- Modify: `test/suggest.test.ts`

This is a TypeScript-only change. After this task, the project still builds and all existing tests still pass — we're just widening the env shape so subsequent tasks can reference the new vars without compile errors.

- [ ] **Step 1: Add the two new fields to `Env`**

In `src/types.ts`, replace the `Env` interface with:

```ts
export interface Env {
  ANTHROPIC_API_KEY: string;
  GOOGLE_REFRESH_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  RECIPIENT_EMAIL: string;
  TRIGGER_SECRET: string;
  RESEND_API_KEY: string;
  FROM_EMAIL_DOMAIN: string;
}
```

- [ ] **Step 2: Verify which test files have `Env` literals**

Run: `grep -n ": Env = {" test/*.ts`

Expected output lists `test/email.test.ts`, `test/google-auth.test.ts`, `test/index.test.ts`, `test/suggest.test.ts`. If any other file appears, add the new fields there too.

- [ ] **Step 3: Update `test/email.test.ts` env literal**

Replace the `baseEnv` literal (lines 5–12) with:

```ts
const baseEnv: Env = {
  ANTHROPIC_API_KEY: "x",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "s",
  GOOGLE_REFRESH_TOKEN: "r",
  RECIPIENT_EMAIL: "me@gmail.com",
  TRIGGER_SECRET: "t",
  RESEND_API_KEY: "re_test_key",
  FROM_EMAIL_DOMAIN: "example.com",
};
```

- [ ] **Step 4: Update `test/index.test.ts` env literal**

Replace the `env` literal (lines 15–22) with:

```ts
const env: Env = {
  ANTHROPIC_API_KEY: "x",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "s",
  GOOGLE_REFRESH_TOKEN: "r",
  RECIPIENT_EMAIL: "me@gmail.com",
  TRIGGER_SECRET: "secret-key",
  RESEND_API_KEY: "re_test_key",
  FROM_EMAIL_DOMAIN: "example.com",
};
```

- [ ] **Step 5: Update `test/google-auth.test.ts` env literal**

Add the two new keys to the `baseEnv` literal. Open the file, find the literal starting at line 5, and add at the end (inside the braces, before the closing `}`):

```ts
  RESEND_API_KEY: "re_test_key",
  FROM_EMAIL_DOMAIN: "example.com",
```

- [ ] **Step 6: Update `test/suggest.test.ts` env literal**

Add the same two keys to the `baseEnv` literal starting at line 26.

```ts
  RESEND_API_KEY: "re_test_key",
  FROM_EMAIL_DOMAIN: "example.com",
```

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass (same as before — we haven't changed any behavior).

- [ ] **Step 8: Commit**

```bash
git add src/types.ts test/email.test.ts test/index.test.ts test/google-auth.test.ts test/suggest.test.ts
git commit -m "Add RESEND_API_KEY and FROM_EMAIL_DOMAIN to Env type"
```

---

## Task 2: Rewrite `test/email.test.ts` for Resend (red)

**Files:**
- Modify: `test/email.test.ts`

Replace the entire body of the file so it asserts against the Resend contract instead of the Gmail MIME contract. The source still has the old Gmail signatures at this point, so the test file will fail to compile — that's the expected "red" state for this TDD step.

- [ ] **Step 1: Replace the file**

Write the following as the full contents of `test/email.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendDigest, sendFailure } from "../src/email";
import type { Env } from "../src/types";

const baseEnv: Env = {
  ANTHROPIC_API_KEY: "x",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "s",
  GOOGLE_REFRESH_TOKEN: "r",
  RECIPIENT_EMAIL: "me@gmail.com",
  TRIGGER_SECRET: "t",
  RESEND_API_KEY: "re_test_key",
  FROM_EMAIL_DOMAIN: "example.com",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendDigest", () => {
  it("posts JSON to Resend with from, to, subject, text, and html", async () => {
    await sendDigest(baseEnv, "Hello **world**", new Date("2026-04-26T14:00:00Z"));

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body);
    expect(body.from).toBe('"Things to do" <digest@example.com>');
    expect(body.to).toBe("me@gmail.com");
    expect(body.subject).toMatch(/^Things to do this week — /);
    expect(body.text).toBe("Hello **world**");
    expect(body.html).toMatch(/<strong>world<\/strong>/);
  });

  it("throws on non-2xx response from Resend", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 })
    );
    await expect(
      sendDigest(baseEnv, "x", new Date())
    ).rejects.toThrow(/403/);
  });
});

describe("sendFailure", () => {
  it("posts plain-text JSON to Resend with stage and stack", async () => {
    const err = new Error("boom");
    err.stack = "stack-trace-here";

    await sendFailure(baseEnv, err, "suggest");

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");

    const body = JSON.parse(init.body);
    expect(body.from).toBe('"Things to do" <digest@example.com>');
    expect(body.to).toBe("me@gmail.com");
    expect(body.subject).toMatch(/^Things to do — FAILED /);
    expect(body.text).toContain("Stage: suggest");
    expect(body.text).toContain("Error: boom");
    expect(body.text).toContain("stack-trace-here");
    expect(body.html).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- test/email.test.ts`
Expected: failure. Likely a TypeScript compile error because `sendDigest`/`sendFailure` still have the old signature (they take `accessToken: string` as the second arg). The error will mention argument count or type mismatch. Either failure mode confirms we're in the red state.

- [ ] **Step 3: Commit the failing tests**

```bash
git add test/email.test.ts
git commit -m "Rewrite email tests for Resend transport (red)"
```

---

## Task 3: Rewrite `src/email.ts` and update `src/index.ts` call sites (green)

**Files:**
- Modify: `src/email.ts` (full rewrite)
- Modify: `src/index.ts`

These two changes are mechanically linked — changing the `email.ts` signatures breaks the `index.ts` callers. Do both in one task so the project compiles end-to-end at the commit boundary.

- [ ] **Step 1: Replace `src/email.ts`**

Write the following as the full contents of `src/email.ts`:

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

export async function sendDigest(
  env: Env,
  markdown: string,
  weekOf: Date
): Promise<void> {
  const subject = `Things to do this week — ${weekOf.toLocaleDateString("en-US", {
    timeZone: "America/Phoenix",
    month: "short",
    day: "numeric",
  })}`;
  const html = await marked(markdown);
  await send(env, { subject, text: markdown, html });
}

export async function sendFailure(
  env: Env,
  error: Error,
  stage: Stage
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const subject = `Things to do — FAILED ${today}`;
  const text = `Stage: ${stage}\nTime: ${new Date().toISOString()}\n\nError: ${error.message}\n\nStack:\n${error.stack ?? "(no stack)"}`;
  await send(env, { subject, text });
}
```

- [ ] **Step 2: Update the `sendDigest` call site in `src/index.ts`**

Find this block in `src/index.ts` (around line 49–54):

```ts
  try {
    await sendDigest(env, accessToken, body, new Date());
    console.log("digest sent");
  } catch (e) {
    throw new StageError("email", e);
  }
```

Replace with:

```ts
  try {
    await sendDigest(env, body, new Date());
    console.log("digest sent");
  } catch (e) {
    throw new StageError("email", e);
  }
```

- [ ] **Step 3: Update `handleFailure` in `src/index.ts`**

Find the entire `handleFailure` function (around line 57–69):

```ts
async function handleFailure(env: Env, error: unknown): Promise<void> {
  const stage: Stage = error instanceof StageError ? error.stage : "unknown";
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(`failure in stage=${stage}:`, err);

  try {
    const accessToken = await getAccessToken(env);
    await sendFailure(env, accessToken, err, stage);
  } catch (sendErr) {
    console.error("could not send failure email:", sendErr);
    throw error;
  }
}
```

Replace with:

```ts
async function handleFailure(env: Env, error: unknown): Promise<void> {
  const stage: Stage = error instanceof StageError ? error.stage : "unknown";
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(`failure in stage=${stage}:`, err);

  try {
    await sendFailure(env, err, stage);
  } catch (sendErr) {
    console.error("could not send failure email:", sendErr);
    throw error;
  }
}
```

- [ ] **Step 4: Run the email tests to confirm they pass**

Run: `npm test -- test/email.test.ts`
Expected: all tests in `test/email.test.ts` pass.

- [ ] **Step 5: Run the full suite (index tests will fail, that's expected)**

Run: `npm test`
Expected: `test/email.test.ts` passes; `test/index.test.ts` fails because its `sendDigest`/`sendFailure` mock-call assertions still expect the old `accessToken` argument. We'll fix index tests in Task 4. Other test files (`calendar`, `google-auth`, `suggest`) should still pass.

- [ ] **Step 6: Commit**

```bash
git add src/email.ts src/index.ts
git commit -m "Switch email transport to Resend HTTP API

Drops accessToken from sendDigest/sendFailure signatures. handleFailure
no longer mints a Google access token to send the failure email."
```

---

## Task 4: Update `test/index.test.ts` for new signatures (green)

**Files:**
- Modify: `test/index.test.ts`

- [ ] **Step 1: Update the happy-path assertion**

Find this assertion in `test/index.test.ts` (around line 48):

```ts
    expect(sendDigest).toHaveBeenCalledWith(env, "access-token", "# digest", expect.any(Date));
```

Replace with:

```ts
    expect(sendDigest).toHaveBeenCalledWith(env, "# digest", expect.any(Date));
```

- [ ] **Step 2: Update the scheduled-handler failure assertion**

Find this assertion (around line 57–62):

```ts
    expect(sendFailure).toHaveBeenCalledWith(
      env,
      "access-token",
      expect.objectContaining({ message: "boom" }),
      "suggest"
    );
```

Replace with:

```ts
    expect(sendFailure).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ message: "boom" }),
      "suggest"
    );
```

- [ ] **Step 3: Update the fetch-handler failure assertion**

Find the second occurrence of the same assertion (around line 100–105) and apply the same change — drop the `"access-token"` line so the call becomes:

```ts
    expect(sendFailure).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ message: "boom" }),
      "suggest"
    );
```

- [ ] **Step 4: Run the index tests**

Run: `npm test -- test/index.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests across all files pass.

- [ ] **Step 6: Commit**

```bash
git add test/index.test.ts
git commit -m "Update index tests for sendDigest/sendFailure signatures without accessToken"
```

---

## Task 5: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

CLAUDE.md describes the codebase as it actually exists. After the previous tasks, the "Gmail API" claims are wrong and need updating.

- [ ] **Step 1: Update the pipeline-architecture description of `email.ts`**

Find this bullet (item 4 under "Pipeline architecture"):

```
4. `email.ts` — Gmail API send (`gmail.googleapis.com/.../messages/send`), `multipart/alternative` with text + HTML rendered via `marked`. Subject uses RFC 2047 encoded-word wrapping for non-ASCII.
```

Replace with:

```
4. `email.ts` — Resend HTTP API send (`POST https://api.resend.com/emails`) with JSON `{from, to, subject, text, html}`. `from` is built from `FROM_EMAIL_DOMAIN`; auth is `RESEND_API_KEY`. HTML body rendered via `marked`. No MIME assembly — Resend handles header encoding.
```

- [ ] **Step 2: Update the Spec deltas "Email transport" bullet**

Find this bullet under "Spec deltas":

```
- **Email transport**: Gmail API (via the same Google OAuth token), not Resend. No `RESEND_API_KEY` / `FROM_EMAIL` secrets exist.
```

Replace with:

```
- **Email transport**: Resend HTTP API (`POST https://api.resend.com/emails`). Secrets: `RESEND_API_KEY`, `FROM_EMAIL_DOMAIN` (bare domain; the `digest@` local-part is fixed in code). Calendar still uses the Google OAuth token; the Gmail send scope on that token is currently unused and can be dropped on the next bootstrap.
```

- [ ] **Step 3: Run the test suite once more as a final sanity check**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Update CLAUDE.md to reflect Resend email transport"
```

---

## Task 6: Manual verification (out of harness)

**Files:** none (operational steps)

This task isn't code — it's the steps Tim runs once to validate the deployed Worker. List them so they're not forgotten; the agent reports back what was run and what the outcome was.

- [ ] **Step 1: Confirm `.dev.vars` has the new secrets**

Run: `grep -E "^(RESEND_API_KEY|FROM_EMAIL_DOMAIN)=" .dev.vars`
Expected: both keys present with non-empty values. If missing, Tim needs to add them before continuing.

- [ ] **Step 2: Confirm the sending domain is verified in Resend**

This is a Tim-side check in the Resend dashboard. Confirm the domain in `FROM_EMAIL_DOMAIN` shows as "Verified" with green checks on SPF and DKIM. If not, do not proceed — sends will 4xx.

- [ ] **Step 3: Push secrets to Wrangler**

Run: `npm run push-secrets`
Expected: the script reports each `KEY=VALUE` from `.dev.vars` being uploaded, including `RESEND_API_KEY` and `FROM_EMAIL_DOMAIN`.

- [ ] **Step 4: Deploy**

Run: `npm run deploy`
Expected: `wrangler deploy` completes successfully and prints the Worker URL.

- [ ] **Step 5: Trigger a manual digest run**

Run (substitute the actual `TRIGGER_SECRET` value from `.dev.vars`):

```bash
curl -i "https://<worker-url>/run?key=$TRIGGER_SECRET"
```

Expected: `HTTP/2 200` with body `OK`. Within a few seconds, an email arrives at `RECIPIENT_EMAIL` from `"Things to do" <digest@<your domain>>`. If the response is `500`, check Wrangler tail logs (`wrangler tail`) for the StageError and the underlying Resend error message.

- [ ] **Step 6: Spot-check the email**

Open the email in Gmail (or whichever client). Confirm:
- Subject reads `Things to do this week — <Mon> <D>` and renders cleanly (no `=?UTF-8?B?…?=`).
- From shows the friendly name "Things to do".
- HTML body renders (bold/links work).
- No spam/junk routing on a verified-domain send.

- [ ] **Step 7: Report**

Report back to the user: deploy URL, the manual trigger HTTP status, whether the email arrived, and anything anomalous.

---

## Self-review notes (for the writer, not for execution)

- All spec sections covered: Env additions (Task 1), `email.ts` rewrite (Task 3), `index.ts` call-site updates (Task 3), test rewrites (Tasks 2, 4), CLAUDE.md updates (Task 5), manual verification (Task 6). No spec section missing a task.
- Out-of-scope per spec and correctly absent here: bootstrap re-mint, `plan.md` edits, `EMAIL_TRANSPORT` toggle, multi-recipient changes.
- Signature consistency: `sendDigest(env, markdown, weekOf)` and `sendFailure(env, error, stage)` are used identically in Task 3 source, Task 2 tests, and Task 4 test assertions.
- No placeholders, no "similar to Task N" — every code change spelled out.
