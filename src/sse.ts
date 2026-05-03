import type { Env, PipelineEvent } from "./types";
import { eventRow } from "./ui/components";

interface StreamOpts {
  /** Polling cadence in ms */
  pollMs?: number;
  /** Heartbeat cadence in ms */
  heartbeatMs?: number;
  /** Hard cap on stream duration in ms (client reconnects automatically) */
  maxDurationMs?: number;
}

const ENC = new TextEncoder();

/**
 * SSE handler for live event streaming on a single run.
 *
 * Pulls events from the Supervisor DO every `pollMs` using a numeric cursor,
 * emits each new event as `event: event\ndata: <html-fragment>\n\n` so HTMX's
 * `sse-swap="event"` directive can swap it into the DOM.
 */
export async function streamRun(
  env: Env,
  runId: string,
  sinceId: string | number,
  opts: StreamOpts = {}
): Promise<Response> {
  const pollMs = opts.pollMs ?? 1000;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const maxDurationMs = opts.maxDurationMs ?? 5 * 60_000;

  const supervisorId = env.SUPERVISOR.idFromName(runId);
  const supervisor = env.SUPERVISOR.get(supervisorId);

  let cursor = Number(sinceId) || 0;
  let lastHeartbeat = Date.now();
  const start = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (text: string) => controller.enqueue(ENC.encode(text));

      send(`: connected\n\n`);

      try {
        while (Date.now() - start < maxDurationMs) {
          const events = (await (supervisor as any).getEvents(cursor)) as PipelineEvent[];

          for (const ev of events) {
            cursor = Math.max(cursor, Number(ev.id));
            const fragment = String(eventRow(ev)).replace(/\n/g, " ");
            send(`event: event\ndata: ${fragment}\n\n`);
          }

          if (Date.now() - lastHeartbeat >= heartbeatMs) {
            send(`: keepalive\n\n`);
            lastHeartbeat = Date.now();
          }

          // Stop early if the run is in a terminal state and we have no new events
          if (events.length === 0) {
            const state = await (supervisor as any).getState();
            if (
              state?.status === "completed" ||
              state?.status === "failed" ||
              state?.status === "awaiting_human"
            ) {
              // Drain one more poll cycle then close
              send(`event: end\ndata: ${state.status}\n\n`);
              break;
            }
          }

          await sleep(pollMs);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        send(`event: error\ndata: ${msg}\n\n`);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
