import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { DagState, DagNode, PipelineEvent, PipelineStep } from "../types";

interface RunSummary {
  run_id: string;
  pipeline?: string;
  created_at?: string;
  status?: string;
}

export function home(): HtmlEscapedString {
  return (html`
    <h1>AgentX Factory</h1>
    <p>Multi-agent pipeline orchestration on Cloudflare. Pick a section above.</p>
    <ul>
      <li><a href="/runs">View pipeline runs</a></li>
      <li><a href="/pipelines">Manage pipelines</a></li>
    </ul>
  `) as HtmlEscapedString;
}

export function runList(runs: RunSummary[]): HtmlEscapedString {
  if (runs.length === 0) {
    return (html`<h1>Runs</h1><p>No runs yet. Trigger one via <code>POST /api/runs</code>.</p>`) as HtmlEscapedString;
  }
  return (html`
    <h1>Runs</h1>
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>Pipeline</th>
          <th>Created</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${runs.map(
          (r) => html`<tr>
            <td><a href="/runs/${r.run_id}">${r.run_id.substring(0, 8)}…</a></td>
            <td>${r.pipeline ?? "?"}</td>
            <td>${r.created_at ?? ""}</td>
            <td><span class="pill status-${r.status ?? "pending"}">${r.status ?? "pending"}</span></td>
          </tr>`
        )}
      </tbody>
    </table>
  `) as HtmlEscapedString;
}

/**
 * Render the DAG as Mermaid flowchart syntax.
 * Kept for the "schema" view inside <details> and as a stable export for tests.
 * Live runtime view uses dagLive() instead.
 */
export function dagMermaid(dag: DagState): HtmlEscapedString {
  const lines: string[] = ["flowchart LR"];
  lines.push(`  start([${safeLabel(dag.pipeline_name || "input")}])`);

  const nodesByStep = new Map<number, string[]>();
  for (const node of Object.values(dag.nodes)) {
    const arr = nodesByStep.get(node.step_index) ?? [];
    arr.push(node.agent_id);
    nodesByStep.set(node.step_index, arr);
  }

  const stepIndices = [...nodesByStep.keys()].sort((a, b) => a - b);

  let prevNodes: string[] = ["start"];
  for (const idx of stepIndices) {
    const stepNodes = nodesByStep.get(idx)!;
    for (const agentId of stepNodes) {
      const node = dag.nodes[agentId];
      const safeId = safeId_(agentId);
      const label = `${safeLabel(agentId)}<br/><i>${safeLabel(node.status)}</i>`;
      lines.push(`  ${safeId}["${label}"]`);
      lines.push(`  class ${safeId} status-${safeLabel(node.status)}`);
      for (const prev of prevNodes) {
        lines.push(`  ${prev} --> ${safeId}`);
      }
    }
    prevNodes = stepNodes.map(safeId_);
  }

  lines.push("  classDef status-completed fill:#0a3a26,stroke:#3ad28b,color:#3ad28b;");
  lines.push("  classDef status-failed fill:#3a0a0a,stroke:#ff7a7a,color:#ff7a7a;");
  lines.push("  classDef status-running fill:#0a2638,stroke:#6dd6ff,color:#6dd6ff;");
  lines.push("  classDef status-dispatched fill:#0a2638,stroke:#6dd6ff,color:#6dd6ff;");
  lines.push("  classDef status-pending fill:#1a1d22,stroke:#8a8f98,color:#8a8f98;");

  return (html`<pre class="mermaid">${raw(lines.join("\n"))}</pre>`) as HtmlEscapedString;
}

/**
 * Custom DOM live-DAG: stable per-node IDs (`node-{agent}`), CSS-driven status
 * transitions and pulse animations. Designed to be patched in place via SSE OOB
 * swaps without re-rendering the whole graph (no Mermaid flicker).
 */
export function dagLive(dag: DagState): HtmlEscapedString {
  const nodesByStep = new Map<number, DagNode[]>();
  for (const n of Object.values(dag.nodes)) {
    const arr = nodesByStep.get(n.step_index) ?? [];
    arr.push(n);
    nodesByStep.set(n.step_index, arr);
  }
  const stepIndices = [...nodesByStep.keys()].sort((a, b) => a - b);

  return (html`<div class="dag-live" role="list" aria-label="Pipeline DAG">
    ${stepIndices.map((idx) => {
      const nodes = nodesByStep.get(idx)!;
      const stepDef: PipelineStep | undefined = dag.steps[idx];
      const stepLabel = stepDef ? stepLabelText(stepDef) : `step ${idx}`;
      const isCurrent = idx === dag.current_step;
      return html`<div
        class="dag-step ${isCurrent ? "is-current" : ""}"
        data-step="${idx}"
      >
        <div class="dag-step-label">${stepLabel}</div>
        <div class="dag-step-nodes">
          ${nodes.map((n) => agentNodeCard(n))}
        </div>
      </div>`;
    })}
  </div>`) as HtmlEscapedString;
}

function stepLabelText(step: PipelineStep): string {
  const name = step.step ?? "step";
  const mode = step.mode ? ` · ${step.mode}` : "";
  const type = step.type ? ` · ${step.type}` : "";
  return `${name}${mode}${type}`;
}

/** A single live node card. Stable id = `node-{agent_id}`. */
export function agentNodeCard(n: DagNode): HtmlEscapedString {
  const dur = formatDuration(n.duration_ms);
  const tokens = formatNumber(n.tokens_used);
  const isInflight = n.status === "running" || n.status === "dispatched";
  return (html`<article
    class="node status-${n.status} ${isInflight ? "is-inflight" : ""}"
    id="node-${n.agent_id}"
    role="listitem"
    aria-label="${n.agent_id} ${n.status}"
  >
    <header class="node-head">
      <span class="node-name">${n.agent_id}</span>
      <span class="node-pulse" aria-hidden="true"></span>
      <span class="node-status">${n.status}</span>
    </header>
    <div class="node-stats">
      <span title="tokens used">⊕ ${tokens}</span>
      <span title="duration">◷ ${dur}</span>
      ${n.retry_count > 0
        ? html`<span title="retries" class="warn">↻ ${n.retry_count}</span>`
        : raw("")}
    </div>
    <footer class="node-model">${n.model ?? "—"}</footer>
  </article>`) as HtmlEscapedString;
}

/** Header counters block. Stable id = `run-stats`. */
export function headerStats(dag: DagState): HtmlEscapedString {
  return (html`<p id="run-stats" class="run-stats">
    <span>Pipeline: <strong>${dag.pipeline_name}</strong></span>
    <span class="sep">·</span>
    <span>Step <strong>${dag.current_step + 1}</strong> of ${dag.steps.length}</span>
    <span class="sep">·</span>
    <span class="counter" data-metric="tokens"
      >${formatNumber(dag.total_tokens)} tokens</span
    >
    <span class="sep">·</span>
    <span class="counter" data-metric="duration"
      >${formatDuration(dag.total_duration_ms)}</span
    >
  </p>`) as HtmlEscapedString;
}

/** Status pill with stable id for OOB swaps. */
export function statusPill(dag: DagState): HtmlEscapedString {
  return (html`<span id="run-status-pill" class="pill status-${dag.status}"
    >${dag.status}</span
  >`) as HtmlEscapedString;
}

/** Per-agent table row. Stable id = `agent-row-{id}`. */
export function agentRow(n: DagNode): HtmlEscapedString {
  const isInflight = n.status === "running" || n.status === "dispatched";
  return (html`<tr
    id="agent-row-${n.agent_id}"
    class="agent-row status-${n.status} ${isInflight ? "is-inflight" : ""}"
  >
    <td>${n.agent_id}</td>
    <td class="status-${n.status}">${n.status}</td>
    <td>${formatNumber(n.tokens_used)}</td>
    <td>${formatDuration(n.duration_ms)}</td>
    <td>${n.retry_count}</td>
    <td>${n.model ?? "—"}</td>
  </tr>`) as HtmlEscapedString;
}

/**
 * OOB-only payload emitted by SSE on every state change. htmx-ext-sse extracts
 * each `hx-swap-oob="true"` element and patches it into the matching ID on the
 * page. The remaining (empty) content goes nowhere visible.
 *
 * Note: OOB <tr> fragments are wrapped in <template> so the browser's fragment
 * parser doesn't strip them when they arrive outside a <table> context.
 */
export function oobUpdate(dag: DagState): HtmlEscapedString {
  const pill = oobWrap(statusPill(dag));
  const stats = oobWrap(headerStats(dag));
  const liveDag = oobWrapElement(dagLive(dag), "dag-live-wrap");
  const rows = Object.values(dag.nodes).map((n) => oobTemplateWrap(agentRow(n)));
  return (html`${pill}${stats}${liveDag}${rows}`) as HtmlEscapedString;
}

/** Tag the OUTER element of an HTML fragment with hx-swap-oob="true". */
function oobWrap(node: HtmlEscapedString): HtmlEscapedString {
  // Inject hx-swap-oob="true" right after the first opening tag's name.
  // Safe: our generators emit a single root element with a known opening tag.
  const s = String(node);
  const patched = s.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9]*)\b/, '$1 hx-swap-oob="true"');
  return raw(patched);
}

/** Wrap a fragment in a stable wrapper id and mark it OOB. */
function oobWrapElement(node: HtmlEscapedString, id: string): HtmlEscapedString {
  return (html`<div id="${id}" hx-swap-oob="true">${node}</div>`) as HtmlEscapedString;
}

/**
 * Wrap an OOB fragment in <template> so the browser's HTML parser preserves
 * elements that need table context (<tr>, <td>, <thead>, etc.). htmx finds
 * OOB-tagged elements inside <template> and applies the swap correctly.
 */
function oobTemplateWrap(node: HtmlEscapedString): HtmlEscapedString {
  return (html`<template>${oobWrap(node)}</template>`) as HtmlEscapedString;
}

export function eventLog(events: PipelineEvent[]): HtmlEscapedString {
  return (html`
    <div class="event-log" id="event-log">
      ${events.map((e) => eventRow(e))}
    </div>
  `) as HtmlEscapedString;
}

export function eventRow(e: PipelineEvent): HtmlEscapedString {
  const t = e.timestamp.replace("T", " ").replace("Z", "");
  return (html`<div class="ev ev-${e.event_type}">
    <span class="t">${t}</span>
    <span class="type">${e.event_type}</span>
    ${e.agent_role ? html`<span class="role">${e.agent_role}</span>` : raw("")}
    <span class="kv">${JSON.stringify(e.details)}</span>
  </div>`) as HtmlEscapedString;
}

export function runDetail(
  runId: string,
  dag: DagState,
  events: PipelineEvent[]
): HtmlEscapedString {
  const lastId = events.length > 0 ? events[events.length - 1].id : "0";
  const isTerminal =
    dag.status === "completed" ||
    dag.status === "failed" ||
    dag.status === "awaiting_human";
  return (html`
    <div class="run-header">
      <h1>
        Run <span class="pill mono">${runId}</span> ${statusPill(dag)}
      </h1>
      <span
        class="conn-status ${isTerminal ? "is-terminal" : "is-live"}"
        id="conn-status"
        title="${isTerminal
          ? "Run finished — live updates stopped"
          : "Live updates connected"}"
      >
        <span class="conn-dot"></span>
        <span class="conn-label">${isTerminal ? "ended" : "live"}</span>
      </span>
    </div>

    ${headerStats(dag)}

    <h2>Pipeline</h2>
    <div id="dag-live-wrap">${dagLive(dag)}</div>

    <details class="dag-schema">
      <summary>View as flowchart (schema)</summary>
      <div id="dag" hx-get="/ui/runs/${runId}/dag" hx-trigger="none" hx-swap="innerHTML">
        ${dagMermaid(dag)}
      </div>
    </details>

    <h2>Events</h2>
    <div hx-ext="sse" sse-connect="/api/runs/${runId}/stream?since=${lastId}" id="sse-root">
      <div
        sse-swap="event"
        hx-swap="afterbegin"
        id="event-log-stream"
        class="event-log"
      >
        ${events.slice().reverse().map((e) => eventRow(e))}
      </div>
      <div sse-swap="state" hx-swap="none" id="state-sink" hidden></div>
    </div>

    <h2>Per-agent</h2>
    <div class="per-agent-wrap">
      <table class="per-agent">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Status</th>
            <th>Tokens</th>
            <th>Duration</th>
            <th>Retries</th>
            <th>Model</th>
          </tr>
        </thead>
        <tbody>
          ${Object.values(dag.nodes).map((n) => agentRow(n))}
        </tbody>
      </table>
    </div>

    <p>
      <a href="/api/runs/${runId}">Raw JSON</a> ·
      <a href="/api/runs/${runId}/metrics">Metrics</a>
    </p>
  `) as HtmlEscapedString;
}

export function pipelineList(names: string[]): HtmlEscapedString {
  return (html`
    <h1>Pipelines</h1>
    ${names.length === 0
      ? html`<p>No pipelines yet. Upload one via <code>POST /api/pipelines</code>.</p>`
      : html`<ul>
          ${names.map(
            (n) => html`<li><a href="/pipelines/${n}">${n}</a></li>`
          )}
        </ul>`}
  `) as HtmlEscapedString;
}

export function pipelineDetail(name: string, yaml: string): HtmlEscapedString {
  return (html`
    <h1>Pipeline: ${name}</h1>
    <pre style="background:#0a0c10;padding:16px;border:1px solid var(--border);border-radius:6px;overflow-x:auto;">${yaml}</pre>
    <h2>Run this pipeline</h2>
    <form hx-post="/ui/runs/start" hx-target="#run-result" hx-swap="innerHTML">
      <input type="hidden" name="pipeline" value="${name}" />
      <label>Input (JSON)</label>
      <textarea name="input" placeholder='{"diff": "..."}'>{}</textarea>
      <p><button type="submit">Start run</button></p>
    </form>
    <div id="run-result"></div>
  `) as HtmlEscapedString;
}

// ─── Internal sanitizers / formatters ───────────────────────────

const SAFE_ID = /[^A-Za-z0-9_]/g;
function safeId_(s: string): string {
  return s.replace(SAFE_ID, "_");
}

const LABEL_DROP = /["<>{}|\\]/g;
function safeLabel(s: string): string {
  return s.replace(LABEL_DROP, "");
}

function formatNumber(n: number): string {
  if (n === 0) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms === 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
