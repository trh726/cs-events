import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAccessToken } from "../src/google-auth";
import type { Env } from "../src/types";

const baseEnv: Env = {
  ANTHROPIC_API_KEY: "x",
  GOOGLE_CLIENT_ID: "client",
  GOOGLE_CLIENT_SECRET: "secret",
  GOOGLE_REFRESH_TOKEN: "refresh",
  RECIPIENT_EMAIL: "me@gmail.com",
  TRIGGER_SECRET: "trigger",
  RESEND_API_KEY: "re_test_key",
  FROM_EMAIL_DOMAIN: "example.com",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAccessToken", () => {
  it("exchanges refresh token for access token", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "abc123" }), { status: 200 })
    );

    const token = await getAccessToken(baseEnv);
    expect(token).toBe("abc123");

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(init.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh");
    expect(body.get("client_id")).toBe("client");
    expect(body.get("client_secret")).toBe("secret");
  });

  it("throws on 401 from token endpoint", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response("invalid_grant", { status: 401 })
    );

    await expect(getAccessToken(baseEnv)).rejects.toThrow(/401/);
  });

  it("throws when 200 response has no access_token", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );

    await expect(getAccessToken(baseEnv)).rejects.toThrow(/no access_token/);
  });
});
