import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = "https://www.googleapis.com/auth/calendar.readonly";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in env, then re-run.");
  process.exit(1);
}

const state = crypto.randomBytes(16).toString("hex");

const consentUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.statusCode = 404;
    res.end();
    return;
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");

  if (returnedState !== state) {
    res.statusCode = 400;
    res.end("State mismatch");
    return;
  }
  if (!code) {
    res.statusCode = 400;
    res.end("No code in redirect");
    return;
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    }
    const data = (await tokenRes.json()) as { refresh_token?: string };
    if (!data.refresh_token) throw new Error("No refresh_token in response");

    res.end("Success! Check your terminal for the refresh token. You can close this tab.");

    console.log("\n=== REFRESH TOKEN ===");
    console.log(data.refresh_token);
    console.log("\nNext step:");
    console.log(`  echo "${data.refresh_token}" | npx wrangler secret put GOOGLE_REFRESH_TOKEN\n`);
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
    console.error(e);
  } finally {
    setTimeout(() => server.close(), 100);
  }
});

server.listen(PORT, () => {
  console.log(`Open this URL in your browser:\n\n${consentUrl}\n`);
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" :
    "xdg-open";
  exec(`${opener} "${consentUrl}"`);
});
