import type { Env, PipelineEvent, DagState } from "./types";
import { eventRow, oobUpdate } from "./ui/components";

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
 * Emits two named events:
 *   - `event` : an HTML fragment for one new pipeline event (appended client-side)
 *   - `state` : an OOB-only HTML payload with hx-swap-oob fragments for the run
 *               status pill, header counters, live DAG, and per-agent rows.
 *               Only emitted when the dag state hash actually changes — so a
 *               quiescent run won't spam the client.
 */
export async function streamRun(
  env: Env,
  runId: string,
  sinceId: string | number,
  opts: StreamOpts = {}
): Promise<Response> {
  const pollMs = opts.pollMs ?? 500;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const maxDurationMs = opts.maxDurationMs ?? 5 * 60_000;

  const supervisorId = env.SUPERVISOR.idFromName(runId);
  const supervisor = env.SUPERVISOR.get(supervisorId);

  let cursor = Number(sinceId) || 0;
  let lastHeartbeat = Date.now();
  let lastStateHash = "";
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

          // Always pull state — emit only when changed (cheap diff via hash).
          const state = (await (supervisor as any).getState()) as DagState | null;
          if (state) {
            const h = stateHash(state);
            if (h !== lastStateHash) {
              lastStateHash = h;
              const payload = String(oobUpdate(state)).replace(/\n/g, " ");
              send(`event: state\ndata: ${payload}\n\n`);
            }

            // Stop early when terminal AND no new events streamed in this tick.
            if (
              events.length === 0 &&
              (state.status === "completed" ||
                state.status === "failed" ||
                state.status === "awaiting_human")
            ) {
              send(`event: end\ndata: ${state.status}\n\n`);
              break;
            }
          }

          if (Date.now() - lastHeartbeat >= heartbeatMs) {
            send(`: keepalive\n\n`);
            lastHeartbeat = Date.now();
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

/**
 * Cheap structural hash of the DAG state — we only need to detect changes,
 * not produce a cryptographic digest. Captures status, current step, totals,
 * and per-node status/tokens/duration/retry/model.
 */
function stateHash(s: DagState): string {
  const parts: string[] = [
    s.status,
    String(s.current_step),
    String(s.total_tokens),
    String(s.total_duration_ms),
  ];
  for (const id of Object.keys(s.nodes).sort()) {
    const n = s.nodes[id];
    parts.push(
      `${id}:${n.status}:${n.tokens_used}:${n.duration_ms}:${n.retry_count}:${n.model ?? ""}`
    );
  }
  return parts.join("|");
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
