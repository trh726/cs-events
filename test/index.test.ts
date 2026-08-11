import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/google-auth", () => ({ getAccessToken: vi.fn() }));
vi.mock("../src/calendar", () => ({ fetchUpcomingEvents: vi.fn() }));
vi.mock("../src/suggest", () => ({ generateSuggestions: vi.fn() }));
vi.mock("../src/email", () => ({ sendDigest: vi.fn(), sendFailure: vi.fn() }));

import { getAccessToken } from "../src/google-auth";
import { fetchUpcomingEvents } from "../src/calendar";
import { generateSuggestions } from "../src/suggest";
import { sendDigest, sendFailure } from "../src/email";
import worker from "../src/index";
import type { Env } from "../src/types";

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

function makeCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => {
      promises.push(p);
    },
    passThroughOnException: () => {},
    promises,
  };
}

beforeEach(() => {
  vi.mocked(getAccessToken).mockReset().mockResolvedValue("access-token");
  vi.mocked(fetchUpcomingEvents).mockReset().mockResolvedValue([]);
  vi.mocked(generateSuggestions).mockReset().mockResolvedValue({ intro: "# digest", picks: [] });
  vi.mocked(sendDigest).mockReset().mockResolvedValue();
  vi.mocked(sendFailure).mockReset().mockResolvedValue();
});

describe("scheduled handler", () => {
  it("happy path: calls sendDigest with intro, picks, and a Date", async () => {
    const ctx = makeCtx();
    await worker.scheduled?.({} as any, env, ctx as any);
    await Promise.all(ctx.promises);
    expect(sendDigest).toHaveBeenCalledWith(env, "# digest", [], expect.any(Date));
    expect(sendFailure).not.toHaveBeenCalled();
  });

  it("failure path: tags suggest failures and sends failure email", async () => {
    vi.mocked(generateSuggestions).mockRejectedValueOnce(new Error("boom"));
    const ctx = makeCtx();
    await worker.scheduled?.({} as any, env, ctx as any);
    await Promise.all(ctx.promises);
    expect(sendFailure).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ message: "boom" }),
      "suggest"
    );
  });
});

describe("fetch handler", () => {
  it("returns 401 on bad key", async () => {
    const req = new Request("https://w/run?key=wrong");
    const res = await worker.fetch?.(req, env, makeCtx() as any);
    expect(res?.status).toBe(401);
    expect(sendDigest).not.toHaveBeenCalled();
  });

  it("returns 200 and streams progress on good key, running the digest", async () => {
    const ctx = makeCtx();
    const req = new Request("https://w/run?key=secret-key");
    const res = await worker.fetch?.(req, env, ctx as any);
    expect(res?.status).toBe(200);
    const body = await res!.text();
    expect(body).toContain("started");
    expect(body).toContain("done");
    await Promise.all(ctx.promises);
    expect(sendDigest).toHaveBeenCalled();
  });

  it("returns 405 on POST", async () => {
    const req = new Request("https://w/run?key=secret-key", { method: "POST" });
    const res = await worker.fetch?.(req, env, makeCtx() as any);
    expect(res?.status).toBe(405);
  });

  it("returns 404 on unknown path", async () => {
    const req = new Request("https://w/other");
    const res = await worker.fetch?.(req, env, makeCtx() as any);
    expect(res?.status).toBe(404);
  });

  it("streams a failure message and sends failure email when a stage throws", async () => {
    vi.mocked(generateSuggestions).mockRejectedValueOnce(new Error("boom"));
    const ctx = makeCtx();
    const req = new Request("https://w/run?key=secret-key");
    const res = await worker.fetch?.(req, env, ctx as any);
    expect(res?.status).toBe(200);
    const body = await res!.text();
    expect(body).toContain("failed");
    await Promise.all(ctx.promises);
    expect(sendFailure).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ message: "boom" }),
      "suggest"
    );
  });
});
