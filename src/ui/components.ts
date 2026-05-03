import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { DagState, PipelineEvent } from "../types";

interface RunSummary {
  run_id: string;
  pipeline?: string;
  created_at?: string;
  status?: string;
}

export function home(): HtmlEscapedString {
  return html`
    <h1>AgentX Factory</h1>
    <p>Multi-agent pipeline orchestration on Cloudflare. Pick a section above.</p>
    <ul>
      <li><a href="/runs">View pipeline runs</a></li>
      <li><a href="/pipelines">Manage pipelines</a></li>
    </ul>
  `;
}

export function runList(runs: RunSummary[]): HtmlEscapedString {
  if (runs.length === 0) {
    return html`<h1>Runs</h1><p>No runs yet. Trigger one via <code>POST /api/runs</code>.</p>`;
  }
  return html`
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
  `;
}

/**
 * Render the DAG as Mermaid flowchart syntax.
 * Returns a <pre class="mermaid"> block ready for client-side rendering.
 *
 * Inputs are user-controlled (agent ids, pipeline name) so we sanitize node labels:
 * agent ids are restricted to alphanumeric+_- (validated upstream by Zod), but defense
 * in depth: we also strip non-safe chars before insertion.
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

  // Sort step indices ascending
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

  return html`<pre class="mermaid">${raw(lines.join("\n"))}</pre>`;
}

export function eventLog(events: PipelineEvent[]): HtmlEscapedString {
  return html`
    <div class="event-log" id="event-log">
      ${events.map((e) => eventRow(e))}
    </div>
  `;
}

export function eventRow(e: PipelineEvent): HtmlEscapedString {
  const t = e.timestamp.replace("T", " ").replace("Z", "");
  return html`<div class="ev ev-${e.event_type}">
    <span class="t">${t}</span>
    <span class="type">${e.event_type}</span>
    ${e.agent_role ? html`<span class="role">${e.agent_role}</span>` : raw("")}
    <span class="kv">${JSON.stringify(e.details)}</span>
  </div>`;
}

export function runDetail(
  runId: string,
  dag: DagState,
  events: PipelineEvent[]
): HtmlEscapedString {
  const lastId = events.length > 0 ? events[events.length - 1].id : "0";
  return html`
    <h1>Run <span class="pill">${runId}</span> <span class="pill status-${dag.status}">${dag.status}</span></h1>
    <p>
      Pipeline: <strong>${dag.pipeline_name}</strong> ·
      Step ${dag.current_step + 1} of ${dag.steps.length} ·
      ${dag.total_tokens} tokens ·
      ${dag.total_duration_ms} ms
    </p>

    <h2>DAG</h2>
    <div id="dag" hx-get="/ui/runs/${runId}/dag" hx-trigger="every 3s" hx-swap="innerHTML">
      ${dagMermaid(dag)}
    </div>

    <h2>Events</h2>
    <div
      hx-ext="sse"
      sse-connect="/api/runs/${runId}/stream?since=${lastId}"
      sse-swap="event"
      hx-swap="afterbegin"
      id="event-log-stream"
      class="event-log"
    >
      ${events.slice().reverse().map((e) => eventRow(e))}
    </div>

    <h2>Per-agent</h2>
    <table>
      <thead><tr><th>Agent</th><th>Status</th><th>Tokens</th><th>Duration</th><th>Retries</th><th>Model</th></tr></thead>
      <tbody>
        ${Object.values(dag.nodes).map(
          (n) => html`<tr>
            <td>${n.agent_id}</td>
            <td class="status-${n.status}">${n.status}</td>
            <td>${n.tokens_used}</td>
            <td>${n.duration_ms} ms</td>
            <td>${n.retry_count}</td>
            <td>${n.model ?? "—"}</td>
          </tr>`
        )}
      </tbody>
    </table>

    <p><a href="/api/runs/${runId}">Raw JSON</a> · <a href="/api/runs/${runId}/metrics">Metrics</a></p>
  `;
}

export function pipelineList(names: string[]): HtmlEscapedString {
  return html`
    <h1>Pipelines</h1>
    ${names.length === 0
      ? html`<p>No pipelines yet. Upload one via <code>POST /api/pipelines</code>.</p>`
      : html`<ul>
          ${names.map(
            (n) => html`<li><a href="/pipelines/${n}">${n}</a></li>`
          )}
        </ul>`}
  `;
}

export function pipelineDetail(name: string, yaml: string): HtmlEscapedString {
  return html`
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
  `;
}

// ─── Internal sanitizers ───────────────────────────

const SAFE_ID = /[^A-Za-z0-9_]/g;
function safeId_(s: string): string {
  return s.replace(SAFE_ID, "_");
}

const LABEL_DROP = /["<>{}|\\]/g;
function safeLabel(s: string): string {
  return s.replace(LABEL_DROP, "");
}
