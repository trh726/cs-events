import { describe, it, expect, vi, beforeEach } from "vitest";

// generateSuggestions streams the request (client.messages.stream) and awaits
// stream.finalMessage(). The mock mirrors that: stream() returns an object whose
// finalMessage() resolves/rejects with whatever the test queues on `finalMessage`.
const finalMessage = vi.fn();
const messagesStream = vi.fn((..._args: any[]) => ({ finalMessage }));

vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status?: number;
    constructor(msg: string, status?: number) {
      super(msg);
      this.status = status;
    }
  }
  const Anthropic: any = vi.fn(function (this: any) {
    this.messages = { stream: messagesStream };
  });
  Anthropic.APIError = APIError;
  return { default: Anthropic, APIError };
});

vi.mock("../src/taste.md", () => ({ default: "# Test taste profile\n\nLikes: testing." }));

import { generateSuggestions } from "../src/suggest";
import { APIError } from "@anthropic-ai/sdk";
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

const samplePicks = [
  {
    title: "Show",
    start: "2026-04-30T19:30:00-07:00",
    end: null,
    venue: "Crescent Ballroom",
    url: "https://example.com/show",
    cost: "$45",
    blurb: "You two loved the last show here.",
  },
];

beforeEach(() => {
  finalMessage.mockReset();
  messagesStream.mockClear();
});

describe("generateSuggestions", () => {
  it("builds the right message and returns intro + picks parsed from tagged blocks", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [
        { type: "text", text: "interim narration\nbullet summary list" },
        { type: "server_tool_use", name: "web_search", input: {} },
        { type: "web_search_tool_result", content: [] },
        {
          type: "text",
          text:
            "Here's everything:\n" +
            `<picks>\n${JSON.stringify(samplePicks)}\n</picks>\n` +
            "<intro>\nA packed week ahead.\n</intro>\n" +
            "And some trailing chatter.",
        },
      ],
    });

    const events = [
      { start: "2026-04-28T20:00:00-07:00", end: "2026-04-28T22:00:00-07:00", title: "Show", location: "X", allDay: false, calendar: "primary" },
    ];
    const result = await generateSuggestions(baseEnv, events, new Date("2026-04-26T00:00:00Z"));

    expect(result.intro).toBe("A packed week ahead.");
    expect(result.intro).not.toContain("interim narration");
    expect(result.intro).not.toContain("trailing chatter");
    expect(result.picks).toEqual(samplePicks);

    const call = messagesStream.mock.calls[0][0];
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(call.system).toContain("Phoenix/Tempe area");
    expect(call.system).toContain("<intro>");
    expect(call.system).toContain("<picks>");
    expect(call.system).toContain("next 7 days");
    expect(call.system).toContain("3 weeks");
    expect(call.messages[0].content).toContain("My taste profile");
    expect(call.messages[0].content).toContain("Test taste profile");
    expect(call.messages[0].content).toContain("My calendar, next 3 weeks");
    expect(call.messages[0].content).toContain("Show");
    expect(call.tools[0].max_uses).toBe(12);
    // Basic web search variant on purpose — the dynamic-filtering web_search_20260209
    // runs unbounded code_execution loops and starves the <intro> output. See suggest.ts.
    expect(call.tools[0].type).toBe("web_search_20250305");
  });

  it("extracts tags even when they span across joined text blocks", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [
        { type: "text", text: `<picks>${JSON.stringify(samplePicks)}</picks>` },
        { type: "text", text: "narration <intro>start of intro" },
        { type: "text", text: "rest of intro</intro> trailing" },
      ],
    });

    const result = await generateSuggestions(baseEnv, [], new Date());
    expect(result.intro).toBe("start of intro\n\nrest of intro");
    expect(result.picks).toHaveLength(1);
  });

  it("strips ```json fences if the model adds them inside <picks>", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text:
            `<picks>\n\`\`\`json\n${JSON.stringify(samplePicks)}\n\`\`\`\n</picks>\n` +
            "<intro>body</intro>",
        },
      ],
    });

    const result = await generateSuggestions(baseEnv, [], new Date());
    expect(result.picks).toEqual(samplePicks);
  });

  it("normalizes optional fields to null when the model returns invalid types", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text:
            `<picks>[{"title":"X","start":"2026-05-02T19:00:00-07:00","url":"https://x","blurb":"why not"}]</picks>` +
            "<intro>body</intro>",
        },
      ],
    });

    const result = await generateSuggestions(baseEnv, [], new Date());
    expect(result.picks[0]).toEqual({
      title: "X",
      start: "2026-05-02T19:00:00-07:00",
      end: null,
      venue: null,
      url: "https://x",
      cost: null,
      blurb: "why not",
    });
  });

  it("throws when <intro> is missing", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [{ type: "text", text: `<picks>${JSON.stringify(samplePicks)}</picks> nothing else` }],
    });

    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow(/<intro>/);
  });

  it("throws when <intro> is empty", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: `<picks>${JSON.stringify(samplePicks)}</picks><intro>   </intro>`,
        },
      ],
    });

    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow(/empty/i);
  });

  it("throws when <picks> is missing", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [{ type: "text", text: "<intro>body</intro>" }],
    });

    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow(/<picks>/);
  });

  it("throws when <picks> JSON is malformed", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [{ type: "text", text: "<picks>not json</picks><intro>body</intro>" }],
    });

    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow(/parse failed/i);
  });

  it("throws when a pick is missing required fields", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: `<picks>[{"title":"X","start":"2026-05-02T19:00:00-07:00"}]</picks><intro>body</intro>`,
        },
      ],
    });

    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow(/missing required fields/i);
  });

  it("throws when <picks> is an empty array", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [{ type: "text", text: "<picks>[]</picks><intro>body</intro>" }],
    });

    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow(/empty/i);
  });

  it("throws when a pick has a date-only start", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: `<picks>[{"title":"X","start":"2026-08-14","url":"https://x","blurb":"why not"}]</picks><intro>body</intro>`,
        },
      ],
    });

    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow(/invalid start/i);
  });

  it("throws when a pick has an unparseable start", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: `<picks>[{"title":"X","start":"soonish","url":"https://x","blurb":"why not"}]</picks><intro>body</intro>`,
        },
      ],
    });

    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow(/invalid start/i);
  });

  it("retries once on a transient error and succeeds the second time", async () => {
    vi.useFakeTimers();
    finalMessage
      .mockRejectedValueOnce(new (APIError as any)("overloaded", 529))
      .mockResolvedValueOnce({
        content: [{ type: "text", text: `<picks>${JSON.stringify(samplePicks)}</picks><intro>ok</intro>` }],
      });

    const promise = generateSuggestions(baseEnv, [], new Date());
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.intro).toBe("ok");
    expect(result.picks).toHaveLength(1);
    expect(finalMessage).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("throws after the second failure", async () => {
    vi.useFakeTimers();
    finalMessage
      .mockRejectedValueOnce(new (APIError as any)("overloaded", 529))
      .mockRejectedValueOnce(new (APIError as any)("overloaded", 529));

    // Attach the .rejects handler before flushing timers so the outer rejection
    // never sits unhandled in the microtask gap between runAllTimersAsync resolving
    // and the next await (vitest flags that as an unhandled rejection otherwise).
    const expectation = expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow();
    await vi.runAllTimersAsync();
    await expectation;
    expect(finalMessage).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("throws when a pick is missing blurb", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: `<picks>[{"title":"X","start":"2026-05-02T19:00:00-07:00","url":"https://x"}]</picks><intro>body</intro>`,
        },
      ],
    });

    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow(
      /missing required fields/i
    );
  });

  it("throws immediately on a non-retryable 4xx", async () => {
    finalMessage.mockRejectedValueOnce(new (APIError as any)("bad request", 400));

    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow();
    expect(finalMessage).toHaveBeenCalledTimes(1);
  });

  it("throws if the response has no text content", async () => {
    finalMessage.mockResolvedValueOnce({
      content: [{ type: "tool_use", name: "web_search", input: {} }],
    });

    await expect(generateSuggestions(baseEnv, [], new Date())).rejects.toThrow(/<intro>/);
  });
});
