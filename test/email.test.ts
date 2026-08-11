import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendDigest, sendFailure } from "../src/email";
import type { Env, Pick } from "../src/types";

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

const samplePick: Pick = {
  title: "First Friday Art Walk",
  start: "2026-08-14T19:00:00-07:00",
  end: null,
  venue: "Roosevelt Row",
  url: "https://example.com/artwalk",
  cost: "free",
  blurb: "Low-key and free.",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendDigest", () => {
  it("posts JSON to Resend with rendered html and text built from intro + picks", async () => {
    await sendDigest(baseEnv, "Hello **world**", [samplePick], new Date("2026-04-26T14:00:00Z"));

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body);
    expect(body.from).toBe('"Things to do" <digest@example.com>');
    expect(body.to).toBe("me@gmail.com");
    expect(body.subject).toMatch(/^Things to do this week — /);
    // text part carries intro + pick data
    expect(body.text).toContain("Hello **world**");
    expect(body.text).toContain("First Friday Art Walk");
    expect(body.text).toContain("calendar.google.com/calendar/render");
    // html part is the rendered template
    expect(body.html).toMatch(/<strong>world<\/strong>/);
    expect(body.html).toContain("First Friday Art Walk");
    expect(body.html).toContain("calendar.google.com/calendar/render");
  });

  it("throws on non-2xx response from Resend", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 })
    );
    await expect(
      sendDigest(baseEnv, "x", [samplePick], new Date())
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
