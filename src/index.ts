import { getAccessToken } from "./google-auth";
import { fetchUpcomingEvents } from "./calendar";
import { generateSuggestions } from "./suggest";
import { sendDigest, sendFailure } from "./email";
import { StageError } from "./types";
import type { Env, Pick, Stage } from "./types";

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  const ts = (crypto.subtle as any).timingSafeEqual as
    | ((x: ArrayBufferView, y: ArrayBufferView) => boolean)
    | undefined;
  if (typeof ts === "function") return ts.call(crypto.subtle, aBytes, bBytes);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

async function runDigest(env: Env): Promise<void> {
  console.log("digest run started");

  let accessToken: string;
  try {
    accessToken = await getAccessToken(env);
  } catch (e) {
    throw new StageError("calendar", e);
  }

  let events;
  try {
    events = await fetchUpcomingEvents(accessToken);
    console.log(`fetched ${events.length} calendar events`);
  } catch (e) {
    throw new StageError("calendar", e);
  }

  let suggestions: { intro: string; picks: Pick[] };
  try {
    suggestions = await generateSuggestions(env, events, new Date());
    console.log(
      `generated suggestions, ${suggestions.intro.length} chars intro, ${suggestions.picks.length} picks`
    );
  } catch (e) {
    throw new StageError("suggest", e);
  }

  try {
    await sendDigest(env, suggestions.intro, suggestions.picks, new Date());
    console.log("digest sent");
  } catch (e) {
    throw new StageError("email", e);
  }
}

async function handleFailure(env: Env, error: unknown): Promise<void> {
  const stage: Stage = error instanceof StageError ? error.stage : "unknown";
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(`failure in stage=${stage}:`, err);

  try {
    await sendFailure(env, err, stage);
  } catch (sendErr) {
    console.error("could not send failure email:", sendErr);
    throw error;
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDigest(env).catch((e) => handleFailure(env, e)));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/run") return new Response("Not found", { status: 404 });
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

    const key = url.searchParams.get("key") ?? "";
    if (!(await constantTimeEqual(key, env.TRIGGER_SECRET))) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const run = (async () => {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        await writer.write(encoder.encode("started\n"));
        heartbeat = setInterval(() => {
          writer.write(encoder.encode(".")).catch(() => {});
        }, 10_000);
        try {
          await runDigest(env);
          await writer.write(encoder.encode("\ndone\n"));
        } catch (e) {
          try {
            await handleFailure(env, e);
          } catch (secondaryErr) {
            console.error("secondary error handling failure:", secondaryErr);
          }
          const stage = e instanceof StageError ? e.stage : e instanceof Error ? e.message : String(e);
          await writer.write(encoder.encode(`\nfailed: ${stage}\n`));
        }
      } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        try {
          await writer.close();
        } catch (closeErr) {
          console.error("could not close /run stream:", closeErr);
        }
      }
    })();

    ctx.waitUntil(run);

    return new Response(readable, { status: 200, headers: { "Content-Type": "text/plain" } });
  },
} satisfies ExportedHandler<Env>;
