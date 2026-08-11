import type { CalendarEvent } from "./types";

interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  selected?: boolean;
  accessRole?: string;
  primary?: boolean;
}

interface GoogleEvent {
  status?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
}

const WRITABLE_ROLES = new Set(["owner", "writer"]);

async function fetchCalendarList(
  accessToken: string
): Promise<{ id: string; name: string }[]> {
  const url =
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?fields=items(id,summary,selected,accessRole,primary)";
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`CalendarList fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { items?: GoogleCalendarListEntry[] };
  return (data.items ?? [])
    .filter((c) => c.selected === true && c.accessRole !== undefined && WRITABLE_ROLES.has(c.accessRole))
    .map((c) => ({ id: c.id, name: c.primary ? "primary" : (c.summary ?? c.id) }));
}

async function fetchEventsForCalendar(
  accessToken: string,
  calendarId: string,
  calendarName: string,
  timeMin: string,
  timeMax: string
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  if (!res.ok) {
    throw new Error(`Events fetch failed for ${calendarName}: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
  if (data.nextPageToken) {
    console.warn(
      `Calendar fetch truncated for ${calendarName}: ${data.items?.length ?? 0} events returned and more pages exist; suggestions may overlap with scheduled events.`
    );
  }

  return (data.items ?? [])
    .filter((e) => e.status !== "cancelled")
    .filter((e) => !e.attendees?.some((a) => a.self && a.responseStatus === "declined"))
    .map((e): CalendarEvent | null => {
      const title = e.summary ?? "(no title)";
      const location = e.location ?? null;
      if (e.start?.dateTime && e.end?.dateTime) {
        return { start: e.start.dateTime, end: e.end.dateTime, title, location, allDay: false, calendar: calendarName };
      }
      if (e.start?.date && e.end?.date) {
        return { start: e.start.date, end: e.end.date, title, location, allDay: true, calendar: calendarName };
      }
      return null;
    })
    .filter((e): e is CalendarEvent => e !== null);
}

export async function fetchUpcomingEvents(accessToken: string): Promise<CalendarEvent[]> {
  const now = new Date();
  // 21 days: suggestions target the next 7, but the wider feed lets the model
  // skip events the couple already has planned in a later week.
  const lookaheadEnd = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000);
  const timeMin = now.toISOString();
  const timeMax = lookaheadEnd.toISOString();

  const calendars = await fetchCalendarList(accessToken);
  if (calendars.length === 0) {
    console.warn("No selected calendars with owner/writer access — calendar feed will be empty");
    return [];
  }

  const eventLists = await Promise.all(
    calendars.map((c) => fetchEventsForCalendar(accessToken, c.id, c.name, timeMin, timeMax))
  );

  // Lexicographic sort works because timed ISO strings ("2026-04-28T20:00:00-07:00")
  // and all-day date strings ("2026-04-28") share the YYYY-MM-DD prefix; on the same
  // day, the all-day form sorts before any timed form, matching calendar UI convention.
  return eventLists.flat().sort((a, b) => a.start.localeCompare(b.start));
}
