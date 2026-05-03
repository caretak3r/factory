import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

interface PageOpts {
  title: string;
  body: HtmlEscapedString;
  /** Inject extra <head> content (e.g. per-page styles) */
  head?: HtmlEscapedString;
  /** Page-specific scripts to run after Mermaid initializes */
  bodyScripts?: HtmlEscapedString;
}

const HTMX_SRC = "https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js";
const HTMX_SSE_SRC = "https://unpkg.com/htmx-ext-sse@2.2.2/sse.js";
const MERMAID_SRC = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";

/** Render a full HTML page. Body and other inputs must be already-escaped HTML. */
export function page(opts: PageOpts): HtmlEscapedString {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${opts.title} — AgentX Factory</title>
    <style>
      :root {
        --bg: #0f1115;
        --fg: #e6e6e6;
        --muted: #8a8f98;
        --accent: #6dd6ff;
        --border: #1f242c;
        --good: #3ad28b;
        --bad: #ff7a7a;
        --warn: #ffcc66;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font: 14px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        background: var(--bg);
        color: var(--fg);
      }
      header {
        padding: 12px 24px;
        border-bottom: 1px solid var(--border);
        display: flex;
        gap: 24px;
        align-items: center;
      }
      header a { color: var(--fg); text-decoration: none; }
      header a:hover { color: var(--accent); }
      header .brand { font-weight: 700; color: var(--accent); }
      main { padding: 24px; max-width: 1200px; margin: 0 auto; }
      h1 { font-size: 18px; margin: 0 0 16px; }
      h2 { font-size: 14px; margin: 24px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
      th { color: var(--muted); font-weight: 500; }
      tr:hover td { background: rgba(109, 214, 255, 0.04); }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .status-completed { color: var(--good); }
      .status-failed { color: var(--bad); }
      .status-running, .status-dispatching, .status-dispatched { color: var(--accent); }
      .status-awaiting_human { color: var(--warn); }
      .status-pending { color: var(--muted); }
      .pill {
        display: inline-block;
        padding: 1px 8px;
        border-radius: 10px;
        font-size: 11px;
        background: var(--border);
      }
      pre.mermaid {
        background: #0a0c10;
        padding: 16px;
        border-radius: 6px;
        border: 1px solid var(--border);
        overflow-x: auto;
      }
      .event-log {
        font-size: 12px;
        max-height: 480px;
        overflow-y: auto;
      }
      .event-log .ev {
        padding: 4px 8px;
        border-bottom: 1px dashed var(--border);
      }
      .event-log .ev .t { color: var(--muted); margin-right: 8px; }
      .event-log .ev .type { color: var(--accent); margin-right: 8px; }
      .event-log .ev .role { color: var(--warn); margin-right: 8px; }
      .ev-error .type, .ev-circuit_trip .type { color: var(--bad); }
      .ev-completion .type, .ev-state_transition .type { color: var(--good); }
      pre.kv { white-space: pre-wrap; word-break: break-word; margin: 0; }
      form button {
        background: var(--accent);
        color: var(--bg);
        border: 0;
        padding: 6px 14px;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-weight: 600;
      }
      input, textarea {
        background: #0a0c10;
        color: var(--fg);
        border: 1px solid var(--border);
        padding: 6px 8px;
        font: inherit;
        border-radius: 4px;
        width: 100%;
      }
      textarea { font-family: inherit; min-height: 200px; }
      .grid { display: grid; gap: 24px; grid-template-columns: 1fr 1fr; }
      @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
    </style>
    ${opts.head ?? raw("")}
  </head>
  <body>
    <header>
      <a class="brand" href="/">AgentX Factory</a>
      <a href="/runs">Runs</a>
      <a href="/pipelines">Pipelines</a>
      <a href="/api/health" target="_blank">Health</a>
    </header>
    <main>${opts.body}</main>
    <script src="${HTMX_SRC}"></script>
    <script src="${HTMX_SSE_SRC}"></script>
    <script src="${MERMAID_SRC}"></script>
    <script>
      mermaid.initialize({ startOnLoad: true, theme: "dark" });
      document.body.addEventListener("htmx:afterSwap", () => {
        // Re-render any newly-swapped Mermaid blocks
        const blocks = document.querySelectorAll("pre.mermaid:not([data-processed])");
        if (blocks.length) mermaid.run({ nodes: blocks });
      });
    </script>
    ${opts.bodyScripts ?? raw("")}
  </body>
</html>`;
}
