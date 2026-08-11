export interface Env {
  ANTHROPIC_API_KEY: string;
  GOOGLE_REFRESH_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  RECIPIENT_EMAIL: string;
  TRIGGER_SECRET: string;
  RESEND_API_KEY: string;
  FROM_EMAIL_DOMAIN: string;
}

export interface CalendarEvent {
  start: string;          // ISO datetime for timed events; YYYY-MM-DD for all-day
  end: string;            // same format as start
  title: string;
  location: string | null;
  allDay: boolean;
  calendar: string;       // source calendar display name; "primary" for the user's primary
}

export interface Pick {
  title: string;
  start: string;          // ISO 8601 datetime, Phoenix offset (-07:00); model is asked to provide this even when only date is known
  end: string | null;
  venue: string | null;
  url: string;
  cost: string | null;    // free-form: "$30-45", "free", null if unknown
  blurb: string;          // 1-2 sentences on why it fits; rendered as the card body in the email
}

export type Stage = "calendar" | "suggest" | "email" | "unknown";

export class StageError extends Error {
  cause: unknown;
  constructor(public stage: Stage, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
    if (cause instanceof Error && cause.stack) this.stack = cause.stack;
  }
}
