import type { Env } from "./types";

export async function getAccessToken(env: Env): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error(`Google token exchange returned no access_token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}
