import { marked } from "marked";
import type { Pick } from "./types";

const HOUR_MS = 60 * 60 * 1000;
// Phoenix doesn't observe DST, so a fixed UTC-7 offset is always correct.
const PHOENIX_UTC_OFFSET_MS = 7 * HOUR_MS;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Epoch ms → Google Calendar local floating stamp (YYYYMMDDTHHMMSS) in Phoenix wall time.
function gcalStamp(ms: number): string {
  return new Date(ms - PHOENIX_UTC_OFFSET_MS).toISOString().slice(0, 19).replace(/[-:]/g, "");
}

export function googleCalendarUrl(pick: Pick): string {
  const startMs = Date.parse(pick.start);
  const endMs = pick.end ? Date.parse(pick.end) : startMs + 2 * HOUR_MS;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: pick.title,
    dates: `${gcalStamp(startMs)}/${gcalStamp(endMs)}`,
    ctz: "America/Phoenix",
    details: `${pick.blurb}\n\n${pick.url}`,
  });
  if (pick.venue) params.set("location", pick.venue);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// "Fri, Aug 14, 7:00 PM · Roosevelt Row · free" — venue/cost omitted when null.
function metaLine(pick: Pick): string {
  const when = new Date(pick.start).toLocaleString("en-US", {
    timeZone: "America/Phoenix",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return [when, pick.venue, pick.cost].filter(Boolean).join(" · ");
}

const LINK_STYLE =
  "display:inline-block;padding:8px 14px;border-radius:6px;font-size:13px;text-decoration:none;";

function card(pick: Pick): string {
  return `<div style="background:#ffffff;border:1px solid #e2e0da;border-radius:8px;padding:16px;margin-bottom:12px;">
  <div style="font-size:17px;font-weight:600;color:#1a1a1a;">${escapeHtml(pick.title)}</div>
  <div style="font-size:13px;color:#777777;margin:2px 0 8px;">${escapeHtml(metaLine(pick))}</div>
  <div style="font-size:14px;line-height:1.5;color:#333333;margin-bottom:12px;">${escapeHtml(pick.blurb)}</div>
  <a href="${escapeHtml(pick.url)}" style="${LINK_STYLE}background:#f0efe9;color:#1a1a1a;">Details</a>
  <a href="${escapeHtml(googleCalendarUrl(pick))}" style="${LINK_STYLE}background:#1a73e8;color:#ffffff;margin-left:8px;">＋ Add to Calendar</a>
</div>`;
}

function textBlock(pick: Pick): string {
  return [
    `* ${pick.title} — ${metaLine(pick)}`,
    `  ${pick.blurb}`,
    `  Details: ${pick.url}`,
    `  Add to calendar: ${googleCalendarUrl(pick)}`,
  ].join("\n");
}

export async function buildDigestEmail(
  intro: string,
  picks: Pick[]
): Promise<{ html: string; text: string }> {
  const introHtml = await marked(intro);
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#f5f4f0;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <h1 style="font-size:22px;margin:0 0 8px;color:#1a1a1a;">Things to do this week</h1>
    <div style="font-size:15px;line-height:1.5;color:#444444;margin-bottom:20px;">${introHtml}</div>
    ${picks.map(card).join("\n")}
  </div>
</body>
</html>`;

  const text = ["Things to do this week", "", intro, "", ...picks.map(textBlock)].join("\n");
  return { html, text };
}
