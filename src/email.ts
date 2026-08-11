import type { Env, Pick, Stage } from "./types";
import { buildDigestEmail } from "./render";

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
