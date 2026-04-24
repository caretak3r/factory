import { Hono } from "hono";
import type { Env, DispatchMessage, ResultMessage } from "./types";
import { parsePipelineYaml, validatePipelineConfig } from "./schema";

export { Agent } from "./agent";
export { Supervisor } from "./supervisor";

const app = new Hono<{ Bindings: Env }>();

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
  const supervisorId = c.env.SUPERVISOR.idFromName(runId);
  const supervisor = c.env.SUPERVISOR.get(supervisorId);

  const result = await (supervisor as any).initializeRun({
    runId,
    pipelineYaml: yaml,
    input: body.input,
  });

  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  // Index the run in KV for listing
  await c.env.PIPELINE_KV.put(
    `run:${runId}`,
    JSON.stringify({ pipeline: body.pipeline, created_at: new Date().toISOString(), status: "started" })
  );

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
  const supervisorId = c.env.SUPERVISOR.idFromName(runId);
  const supervisor = c.env.SUPERVISOR.get(supervisorId);
  const state = await (supervisor as any).getState();
  return c.json(state);
});

app.get("/api/runs/:id/events", async (c) => {
  const runId = c.req.param("id");
  const supervisorId = c.env.SUPERVISOR.idFromName(runId);
  const supervisor = c.env.SUPERVISOR.get(supervisorId);
  const events = await (supervisor as any).getEvents();
  return c.json({ events });
});

app.get("/api/runs/:id/artifacts/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const obj = await c.env.ARTIFACT_STORE.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  return c.text(await obj.text(), 200, { "Content-Type": "application/json" });
});

// ─── Worker Export ─────────────────────────────────
export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch, env: Env) {
    for (const msg of batch.messages) {
      const data = msg.body as DispatchMessage | ResultMessage | { type: string };

      if (data.type === "dispatch") {
        const dispatch = data as DispatchMessage;
        const agentDoId = env.AGENT.idFromName(
          `${dispatch.envelope.pipeline_run}:${dispatch.envelope.to.agent}`
        );
        const agent = env.AGENT.get(agentDoId);

        try {
          await (agent as any).handleTask({
            runId: dispatch.envelope.pipeline_run,
            agentConfig: dispatch.agent_config,
            modelDefaults: dispatch.model_defaults,
            inputRefs: dispatch.envelope.context_window.parent_refs,
            supervisorDoId: dispatch.envelope.from.do_id,
            retryCount: dispatch.envelope.metadata.retry_count,
          });
          msg.ack();
        } catch (e) {
          console.error(`Agent task failed: ${e}`);
          msg.retry();
        }
      } else if (data.type === "result") {
        const result = data as ResultMessage;
        const supervisorId = env.SUPERVISOR.idFromName(
          result.envelope.pipeline_run
        );
        const supervisor = env.SUPERVISOR.get(supervisorId);

        try {
          await (supervisor as any).handleAgentCompletion(result.envelope);
          msg.ack();
        } catch (e) {
          console.error(`Supervisor completion handling failed: ${e}`);
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
