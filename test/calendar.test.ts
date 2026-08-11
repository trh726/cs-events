import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchUpcomingEvents } from "../src/calendar";

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function routeFetch(handler: FetchHandler) {
  const mock = vi.fn(handler);
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchUpcomingEvents", () => {
  it("lists calendars, filters to selected+owner/writer, and merges events from each", async () => {
    const calendarList = {
      items: [
        { id: "tim@example.com", primary: true, summary: "tim@example.com", selected: true, accessRole: "owner" },
        { id: "jess-and-tim", summary: "Jess and Tim", selected: true, accessRole: "owner" },
        { id: "family", summary: "Family", selected: true, accessRole: "writer" },
        { id: "holidays", summary: "Holidays in US", selected: true, accessRole: "reader" },
        { id: "suns", summary: "Phoenix Suns", selected: true, accessRole: "reader" },
        { id: "unselected-owned", summary: "Local Events", selected: false, accessRole: "owner" },
      ],
    };

    const primaryEvents = {
      items: [
        // timed
        {
          status: "confirmed",
          summary: "Standup",
          start: { dateTime: "2026-04-28T09:00:00-07:00" },
          end: { dateTime: "2026-04-28T09:30:00-07:00" },
        },
        // all-day on primary — should now be included
        {
          status: "confirmed",
          summary: "Holiday",
          start: { date: "2026-05-01" },
          end: { date: "2026-05-02" },
        },
        // cancelled — drop
        {
          status: "cancelled",
          summary: "Cancelled meeting",
          start: { dateTime: "2026-04-29T10:00:00-07:00" },
          end: { dateTime: "2026-04-29T11:00:00-07:00" },
        },
        // declined by self — drop
        {
          status: "confirmed",
          summary: "Skip this",
          start: { dateTime: "2026-04-30T10:00:00-07:00" },
          end: { dateTime: "2026-04-30T11:00:00-07:00" },
          attendees: [{ self: true, responseStatus: "declined" }],
        },
      ],
    };
    const jessAndTimEvents = {
      items: [
        {
          status: "confirmed",
          summary: "Dinner",
          location: "Pizzeria Bianco",
          start: { dateTime: "2026-04-28T19:30:00-07:00" },
          end: { dateTime: "2026-04-28T21:00:00-07:00" },
        },
      ],
    };
    const familyEvents = {
      items: [
        {
          status: "confirmed",
          summary: "Brunch with parents",
          start: { dateTime: "2026-05-02T11:00:00-07:00" },
          end: { dateTime: "2026-05-02T13:00:00-07:00" },
        },
      ],
    };

    const fetchedUrls: string[] = [];
    const mock = routeFetch(async (url) => {
      fetchedUrls.push(url);
      if (url.includes("/users/me/calendarList")) {
        return new Response(JSON.stringify(calendarList), { status: 200 });
      }
      if (url.includes("calendars/tim%40example.com/events")) {
        return new Response(JSON.stringify(primaryEvents), { status: 200 });
      }
      if (url.includes("calendars/jess-and-tim/events")) {
        return new Response(JSON.stringify(jessAndTimEvents), { status: 200 });
      }
      if (url.includes("calendars/family/events")) {
        return new Response(JSON.stringify(familyEvents), { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const events = await fetchUpcomingEvents("token");

    // Three writable+selected calendars hit; readers (holidays, suns) and unselected (Local Events) skipped.
    const eventCallUrls = fetchedUrls.filter((u) => u.includes("/events?"));
    expect(eventCallUrls).toHaveLength(3);
    expect(fetchedUrls.some((u) => u.includes("calendars/holidays/events"))).toBe(false);
    expect(fetchedUrls.some((u) => u.includes("calendars/suns/events"))).toBe(false);
    expect(fetchedUrls.some((u) => u.includes("calendars/unselected-owned/events"))).toBe(false);

    // 1 standup + 1 all-day holiday + 1 dinner + 1 brunch = 4 (skip cancelled and declined).
    expect(events).toHaveLength(4);

    // Sorted by start. Standup 04-28T09 → Dinner 04-28T19:30 → Holiday all-day 05-01 → Brunch 05-02T11.
    expect(events.map((e) => e.title)).toEqual([
      "Standup",
      "Dinner",
      "Holiday",
      "Brunch with parents",
    ]);

    expect(events[0]).toEqual({
      start: "2026-04-28T09:00:00-07:00",
      end: "2026-04-28T09:30:00-07:00",
      title: "Standup",
      location: null,
      allDay: false,
      calendar: "primary",
    });
    expect(events[1].calendar).toBe("Jess and Tim");
    expect(events[1].location).toBe("Pizzeria Bianco");
    expect(events[2]).toEqual({
      start: "2026-05-01",
      end: "2026-05-02",
      title: "Holiday",
      location: null,
      allDay: true,
      calendar: "primary",
    });
    expect(events[3].calendar).toBe("Family");

    // Auth header propagated on every call.
    for (const call of mock.mock.calls) {
      expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer token" });
    }
  });

  it("returns [] and warns when no selected+writable calendars exist", async () => {
    routeFetch(async (url) => {
      if (url.includes("/users/me/calendarList")) {
        return new Response(
          JSON.stringify({
            items: [
              { id: "h", summary: "Holidays", selected: true, accessRole: "reader" },
              { id: "u", summary: "Owned but hidden", selected: false, accessRole: "owner" },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = await fetchUpcomingEvents("token");
      expect(events).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("throws when calendarList returns non-2xx", async () => {
    routeFetch(async () => new Response("Forbidden", { status: 403 }));
    await expect(fetchUpcomingEvents("token")).rejects.toThrow(/CalendarList.*403/);
  });

  it("throws when an events fetch fails for a single calendar", async () => {
    routeFetch(async (url) => {
      if (url.includes("/users/me/calendarList")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "primary-id", primary: true, selected: true, accessRole: "owner", summary: "tim" }],
          }),
          { status: 200 }
        );
      }
      return new Response("nope", { status: 500 });
    });
    await expect(fetchUpcomingEvents("token")).rejects.toThrow(/Events fetch failed.*500/);
  });

  it("returns an empty array when calendars exist but have no events", async () => {
    routeFetch(async (url) => {
      if (url.includes("/users/me/calendarList")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "primary-id", primary: true, selected: true, accessRole: "owner", summary: "tim" }],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const events = await fetchUpcomingEvents("token");
    expect(events).toEqual([]);
  });

  it("requests a 21-day window", async () => {
    let spanDays: number | null = null;
    routeFetch(async (url) => {
      if (url.includes("/users/me/calendarList")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "primary-id", primary: true, selected: true, accessRole: "owner", summary: "tim" }],
          }),
          { status: 200 }
        );
      }
      const params = new URL(url).searchParams;
      spanDays =
        (Date.parse(params.get("timeMax")!) - Date.parse(params.get("timeMin")!)) / 86_400_000;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await fetchUpcomingEvents("token");
    expect(spanDays).toBeCloseTo(21, 5);
  });
});
