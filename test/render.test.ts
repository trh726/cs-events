import { describe, it, expect } from "vitest";
import { googleCalendarUrl, buildDigestEmail } from "../src/render";
import type { Pick } from "../src/types";

const basePick: Pick = {
  title: "First Friday Art Walk",
  start: "2026-08-14T19:00:00-07:00",
  end: "2026-08-14T21:00:00-07:00",
  venue: "Roosevelt Row",
  url: "https://example.com/artwalk",
  cost: "free",
  blurb: "Your kind of low-key evening, and it's free.",
};

describe("googleCalendarUrl", () => {
  it("builds a template URL with Phoenix-local floating times and ctz", () => {
    const url = new URL(googleCalendarUrl(basePick));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("First Friday Art Walk");
    expect(url.searchParams.get("dates")).toBe("20260814T190000/20260814T210000");
    expect(url.searchParams.get("ctz")).toBe("America/Phoenix");
    expect(url.searchParams.get("location")).toBe("Roosevelt Row");
    expect(url.searchParams.get("details")).toContain("Your kind of low-key evening");
    expect(url.searchParams.get("details")).toContain("https://example.com/artwalk");
  });

  it("defaults a null end to start + 2 hours", () => {
    const url = new URL(googleCalendarUrl({ ...basePick, end: null }));
    expect(url.searchParams.get("dates")).toBe("20260814T190000/20260814T210000");
  });

  it("omits location when venue is null", () => {
    const url = new URL(googleCalendarUrl({ ...basePick, venue: null }));
    expect(url.searchParams.has("location")).toBe(false);
  });

  it("renders Phoenix wall time even if the model used a Z offset", () => {
    // 2026-08-15T02:00:00Z === 2026-08-14T19:00:00-07:00
    const url = new URL(
      googleCalendarUrl({ ...basePick, start: "2026-08-15T02:00:00Z", end: null })
    );
    expect(url.searchParams.get("dates")).toBe("20260814T190000/20260814T210000");
  });

  it("URL-encodes special characters in fields", () => {
    const raw = googleCalendarUrl({ ...basePick, title: "Dine & Dash?" });
    const url = new URL(raw);
    expect(url.searchParams.get("text")).toBe("Dine & Dash?");
    expect(raw).not.toContain("Dine & Dash?"); // must not appear un-encoded
  });
});

describe("buildDigestEmail", () => {
  it("renders header, intro markdown, and one card per pick", async () => {
    const { html } = await buildDigestEmail("A **packed** week.", [basePick]);
    expect(html).toContain("Things to do this week");
    expect(html).toContain("<strong>packed</strong>");
    expect(html).toContain("First Friday Art Walk");
    expect(html).toContain("Your kind of low-key evening");
    expect(html).toContain('href="https://example.com/artwalk"');
    expect(html).toContain("calendar.google.com/calendar/render");
    // Metadata line: Phoenix-local weekday/time, venue, cost
    expect(html).toContain("Fri");
    expect(html).toContain("7:00");
    expect(html).toContain("Roosevelt Row");
    expect(html).toContain("free");
  });

  it("HTML-escapes model-controlled fields", async () => {
    const { html } = await buildDigestEmail("intro", [
      { ...basePick, title: '<script>alert("x")</script>', blurb: "a & b < c" },
    ]);
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a &amp; b &lt; c");
  });

  it("builds a text part from the same data", async () => {
    const { text } = await buildDigestEmail("A quiet week.", [basePick]);
    expect(text).toContain("Things to do this week");
    expect(text).toContain("A quiet week.");
    expect(text).toContain("First Friday Art Walk");
    expect(text).toContain("https://example.com/artwalk");
    expect(text).toContain("calendar.google.com/calendar/render");
  });

  it("omits venue and cost from the meta line when both are null", async () => {
    const { html } = await buildDigestEmail("intro", [{ ...basePick, venue: null, cost: null }]);
    expect(html).not.toContain("Roosevelt Row");
    expect(html).not.toContain("·");
  });

  it("uses only inline styles (no style/link tags)", async () => {
    const { html } = await buildDigestEmail("intro", [basePick]);
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toMatch(/<link[\s>]/);
  });
});
