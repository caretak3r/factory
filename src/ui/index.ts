import { Hono } from "hono";
import type { Env } from "../types";
import { getSupervisor, writeRunIndex } from "../do-stubs";
import { page } from "./layouts";
import {
  home,
  runList,
  runDetail,
  pipelineList,
  pipelineDetail,
  dagMermaid,
} from "./components";

interface RunIndexEntry {
  pipeline?: string;
  created_at?: string;
  status?: string;
}

export const ui = new Hono<{ Bindings: Env }>();

ui.get("/", (c) => c.html(page({ title: "Home", body: home() })));

ui.get("/runs", async (c) => {
  const list = await c.env.PIPELINE_KV.list({ prefix: "run:" });
  const runs = await Promise.all(
    list.keys.map(async (k) => {
      const data = await c.env.PIPELINE_KV.get(k.name);
      const parsed: RunIndexEntry = data ? JSON.parse(data) : {};
      return { run_id: k.name.replace("run:", ""), ...parsed };
    })
  );
  // Newest first
  runs.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return c.html(page({ title: "Runs", body: runList(runs) }));
});

ui.get("/runs/:id", async (c) => {
  const runId = c.req.param("id");
  const sup = getSupervisor(c.env, runId);
  const dag = await sup.getState();
  const events = await sup.getEvents();
  return c.html(page({ title: `Run ${runId.slice(0, 8)}`, body: runDetail(runId, dag, events) }));
});

ui.get("/pipelines", async (c) => {
  const list = await c.env.PIPELINE_KV.list({ prefix: "pipeline:" });
  const names = list.keys.map((k) => k.name.replace("pipeline:", ""));
  return c.html(page({ title: "Pipelines", body: pipelineList(names) }));
});

ui.get("/pipelines/:name", async (c) => {
  const name = c.req.param("name");
  const yaml = await c.env.PIPELINE_KV.get(`pipeline:${name}`);
  if (!yaml) return c.html(page({ title: "Not found", body: pipelineList([]) }), 404);
  return c.html(page({ title: name, body: pipelineDetail(name, yaml) }));
});

// ─── HTMX partials ─────────────────────────────────

ui.get("/ui/runs/:id/dag", async (c) => {
  const runId = c.req.param("id");
  const dag = await getSupervisor(c.env, runId).getState();
  return c.html(dagMermaid(dag));
});

ui.post("/ui/runs/start", async (c) => {
  const form = await c.req.parseBody();
  const pipeline = String(form.pipeline ?? "");
  let input: unknown = {};
  try {
    input = JSON.parse(String(form.input ?? "{}"));
  } catch {
    return c.html(`<p style="color:#ff7a7a">Invalid JSON input</p>`);
  }

  const yaml = await c.env.PIPELINE_KV.get(`pipeline:${pipeline}`);
  if (!yaml) return c.html(`<p style="color:#ff7a7a">Pipeline not found</p>`);

  const runId = crypto.randomUUID();
  const result = await getSupervisor(c.env, runId).initializeRun({
    runId,
    pipelineYaml: yaml,
    input,
  });

  if (!result.success) {
    return c.html(`<p style="color:#ff7a7a">Error: ${String(result.error)}</p>`);
  }
  await writeRunIndex(c.env, runId, pipeline);
  return c.html(
    `<p style="color:#3ad28b">Started run <a href="/runs/${runId}">${runId}</a></p>`
  );
});
