import { Hono } from "hono";
import type {
  Env,
  DispatchMessage,
  ResultMessage,
  FailureMessage,
} from "./types";
import { parsePipelineYaml, validatePipelineConfig } from "./schema";
import { ui } from "./ui";
import { streamRun } from "./sse";
import { resolveArtifactKey } from "./tools/sandbox";
import { getSupervisor, getAgent, getBreaker, writeRunIndex } from "./do-stubs";

export { Agent } from "./agent";
export { Supervisor } from "./supervisor";
export { CircuitBreaker } from "./circuit-breaker";

const app = new Hono<{ Bindings: Env }>();

// Mount the dashboard UI at the root (also handles /ui/* HTMX partials)
app.route("/", ui);

// ─── Health ────────────────────────────────────────
app.get("/api/health", (c) => c.json({ status: "ok", service: "agentx-factory" }));

// ─── Pipeline CRUD ─────────────────────────────────
app.post("/api/pipelines", async (c) => {
  const body = await c.req.text();
  const parsed = parsePipelineYaml(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid YAML", details: parsed.errors }, 400);
  }
  const errors = validatePipelineConfig(parsed.data);
  if (errors.length > 0) {
    return c.json({ error: "Validation failed", details: errors }, 400);
  }
  await c.env.PIPELINE_KV.put(`pipeline:${parsed.data.name}`, body);
  return c.json({ name: parsed.data.name, status: "saved" }, 201);
});

app.get("/api/pipelines", async (c) => {
  const list = await c.env.PIPELINE_KV.list({ prefix: "pipeline:" });
  const names = list.keys.map((k) => k.name.replace("pipeline:", ""));
  return c.json({ pipelines: names });
});

app.get("/api/pipelines/:name", async (c) => {
  const name = c.req.param("name");
  const yaml = await c.env.PIPELINE_KV.get(`pipeline:${name}`);
  if (!yaml) return c.json({ error: "Not found" }, 404);
  return c.text(yaml, 200, { "Content-Type": "text/yaml" });
});

app.delete("/api/pipelines/:name", async (c) => {
  const name = c.req.param("name");
  await c.env.PIPELINE_KV.delete(`pipeline:${name}`);
  return c.json({ status: "deleted" });
});

// ─── Pipeline Runs ─────────────────────────────────
app.post("/api/runs", async (c) => {
  const body = await c.req.json<{ pipeline: string; input: unknown }>();
  const yaml = await c.env.PIPELINE_KV.get(`pipeline:${body.pipeline}`);
  if (!yaml) {
    return c.json({ error: `Pipeline "${body.pipeline}" not found` }, 404);
  }

  const runId = crypto.randomUUID();
  const supervisor = getSupervisor(c.env, runId);
  const result = await supervisor.initializeRun({
    runId,
    pipelineYaml: yaml,
    input: body.input,
  });

  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  // Index the run in KV for listing
  await writeRunIndex(c.env, runId, body.pipeline);

  return c.json({ run_id: runId, status: "started" }, 201);
});

app.get("/api/runs", async (c) => {
  const list = await c.env.PIPELINE_KV.list({ prefix: "run:" });
  const runs = await Promise.all(
    list.keys.map(async (k) => {
      const data = await c.env.PIPELINE_KV.get(k.name);
      return { run_id: k.name.replace("run:", ""), ...JSON.parse(data ?? "{}") };
    })
  );
  return c.json({ runs });
});

app.get("/api/runs/:id", async (c) => {
  const runId = c.req.param("id");
  const state = await getSupervisor(c.env, runId).getState();
  return c.json(state);
});

app.get("/api/runs/:id/events", async (c) => {
  const runId = c.req.param("id");
  const events = await getSupervisor(c.env, runId).getEvents();
  return c.json({ events });
});

app.get("/api/runs/:id/stream", (c) => {
  const runId = c.req.param("id");
  const since = c.req.query("since") ?? "0";
  return streamRun(c.env, runId, since);
});

app.get("/api/runs/:id/metrics", async (c) => {
  const runId = c.req.param("id");
  const metrics = await getSupervisor(c.env, runId).getMetrics();
  return c.json(metrics);
});

app.get("/api/circuit-breaker", async (c) => {
  if (!c.env.CIRCUIT_BREAKER) {
    return c.json({ error: "Circuit breaker not configured" }, 503);
  }
  const breaker = getBreaker(c.env);
  const all = await breaker!.getAll();
  return c.json({ breakers: all });
});

app.get("/api/runs/:id/artifacts/:key{.+}", async (c) => {
  const runId = c.req.param("id");
  const requested = c.req.param("key");
  let key: string;
  try {
    key = resolveArtifactKey(runId, requested);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "invalid artifact key" },
      400
    );
  }
  const obj = await c.env.ARTIFACT_STORE.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  return c.text(await obj.text(), 200, { "Content-Type": "application/json" });
});

// ─── Worker Export ─────────────────────────────────
export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch, env: Env) {
    for (const msg of batch.messages) {
      const data = msg.body as
        | DispatchMessage
        | ResultMessage
        | FailureMessage
        | { type: string };

      if (data.type === "dispatch") {
        const dispatch = data as DispatchMessage;
        const agent = getAgent(
          env,
          dispatch.envelope.pipeline_run,
          dispatch.envelope.to.agent
        );

        try {
          await agent.handleTask({
            runId: dispatch.envelope.pipeline_run,
            agentConfig: dispatch.agent_config,
            modelDefaults: dispatch.model_defaults,
            inputRefs: dispatch.envelope.context_window.parent_refs,
            supervisorDoId: dispatch.envelope.from.do_id,
            retryCount: dispatch.envelope.metadata.retry_count,
            peers: dispatch.peers,
            priorRuns: dispatch.prior_runs,
          });
          msg.ack();
        } catch (e) {
          console.error(`Agent task failed: ${e}`);
          msg.retry();
        }
      } else if (data.type === "result") {
        const result = data as ResultMessage;

        try {
          await getSupervisor(env, result.envelope.pipeline_run).handleAgentCompletion(
            result.envelope
          );
          msg.ack();
        } catch (e) {
          console.error(`Supervisor completion handling failed: ${e}`);
          msg.retry();
        }
      } else if (data.type === "failure") {
        const failure = data as FailureMessage;

        try {
          await getSupervisor(env, failure.run_id).handleAgentFailure(
            failure.agent_id,
            failure.error,
            { retryCount: failure.retry_count }
          );
          msg.ack();
        } catch (e) {
          console.error(`Supervisor failure handling failed: ${e}`);
          msg.retry();
        }
      } else {
        // DLQ or unknown message type
        console.error(`Unknown queue message type: ${data.type}`);
        msg.ack();
      }
    }
  },
};
