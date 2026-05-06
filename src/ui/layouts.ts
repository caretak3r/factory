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
        --bg-2: #0a0c10;
        --fg: #e6e6e6;
        --muted: #8a8f98;
        --accent: #6dd6ff;
        --accent-soft: rgba(109, 214, 255, 0.18);
        --border: #1f242c;
        --border-strong: #2a3038;
        --good: #3ad28b;
        --good-soft: rgba(58, 210, 139, 0.16);
        --bad: #ff7a7a;
        --bad-soft: rgba(255, 122, 122, 0.16);
        --warn: #ffcc66;
        --radius: 8px;
        --radius-sm: 4px;
        --shadow-glow-accent: 0 0 0 1px var(--accent), 0 0 16px var(--accent-soft);
        --shadow-glow-good: 0 0 0 1px var(--good), 0 0 16px var(--good-soft);
        --shadow-glow-bad: 0 0 0 1px var(--bad), 0 0 16px var(--bad-soft);
        --t-fast: 160ms cubic-bezier(0.4, 0, 0.2, 1);
        --t-mid: 320ms cubic-bezier(0.4, 0, 0.2, 1);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font: 14px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        background: var(--bg);
        color: var(--fg);
        -webkit-font-smoothing: antialiased;
      }
      header {
        padding: 12px 24px;
        border-bottom: 1px solid var(--border);
        display: flex;
        gap: 24px;
        align-items: center;
        position: sticky;
        top: 0;
        background: rgba(15, 17, 21, 0.92);
        backdrop-filter: blur(8px);
        z-index: 10;
      }
      header a { color: var(--fg); text-decoration: none; transition: color var(--t-fast); }
      header a:hover { color: var(--accent); }
      header .brand { font-weight: 700; color: var(--accent); }
      main { padding: 24px; max-width: 1200px; margin: 0 auto; }
      h1 { font-size: 18px; margin: 0 0 8px; }
      h2 { font-size: 12px; margin: 24px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
      th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
      tr { transition: background var(--t-fast); }
      tr:hover td { background: rgba(109, 214, 255, 0.04); }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }

      /* ─── Status colors with smooth transitions ───────────────────── */
      .status-completed { color: var(--good); }
      .status-failed { color: var(--bad); }
      .status-running, .status-dispatching, .status-dispatched { color: var(--accent); }
      .status-awaiting_human { color: var(--warn); }
      .status-pending { color: var(--muted); }
      .status-completed, .status-failed, .status-running,
      .status-dispatching, .status-dispatched, .status-awaiting_human,
      .status-pending { transition: color var(--t-mid); }

      .pill {
        display: inline-block;
        padding: 2px 10px;
        border-radius: 999px;
        font-size: 11px;
        background: var(--border);
        transition: background var(--t-mid), color var(--t-mid), box-shadow var(--t-mid);
      }
      .pill.mono { font-family: ui-monospace, monospace; font-size: 10px; opacity: 0.7; }
      .pill.status-running, .pill.status-dispatching, .pill.status-dispatched {
        background: var(--accent-soft);
        color: var(--accent);
        animation: pulse-soft 1.6s ease-in-out infinite;
      }
      .pill.status-completed {
        background: var(--good-soft);
        color: var(--good);
      }
      .pill.status-failed {
        background: var(--bad-soft);
        color: var(--bad);
      }

      /* ─── Run header layout (title row + connection status) ────── */
      .run-header {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      .run-header h1 { flex: 1; min-width: 0; }
      .run-header h1 .pill { vertical-align: middle; margin-left: 6px; }

      .conn-status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: 11px;
        color: var(--muted);
      }
      .conn-status .conn-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--muted);
      }
      .conn-status.is-live { color: var(--good); border-color: var(--good); }
      .conn-status.is-live .conn-dot {
        background: var(--good);
        animation: pulse-dot 1.4s ease-in-out infinite;
      }
      .conn-status.is-terminal { color: var(--muted); }

      /* ─── Header counters ──────────────────────────────────────── */
      .run-stats {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: baseline;
        color: var(--muted);
        margin: 8px 0 16px;
      }
      .run-stats .sep { opacity: 0.4; }
      .run-stats strong { color: var(--fg); font-weight: 600; }
      .run-stats .counter {
        font-variant-numeric: tabular-nums;
        transition: color var(--t-mid);
      }

      /* ─── Live DAG (custom DOM) ────────────────────────────────── */
      .dag-live {
        display: flex;
        gap: 16px;
        align-items: stretch;
        padding: 12px;
        background: var(--bg-2);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        overflow-x: auto;
        scrollbar-width: thin;
      }
      .dag-step {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 220px;
        position: relative;
        padding-right: 24px;
        flex: 1;
      }
      .dag-step:not(:last-child)::after {
        content: "→";
        position: absolute;
        right: 4px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--muted);
        opacity: 0.5;
        font-size: 18px;
        pointer-events: none;
      }
      .dag-step.is-current .dag-step-label {
        color: var(--accent);
      }
      .dag-step-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
        padding: 0 4px;
        transition: color var(--t-mid);
      }
      .dag-step-nodes {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .node {
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-height: 84px;
        transition:
          border-color var(--t-mid),
          box-shadow var(--t-mid),
          background var(--t-mid),
          transform var(--t-fast);
        will-change: box-shadow, border-color;
      }
      .node-head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .node-name {
        font-weight: 600;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .node-status {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        opacity: 0.85;
      }
      .node-pulse {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--muted);
        flex-shrink: 0;
        transition: background var(--t-mid);
      }
      .node-stats {
        display: flex;
        gap: 12px;
        font-size: 12px;
        color: var(--muted);
        font-variant-numeric: tabular-nums;
      }
      .node-stats .warn { color: var(--warn); }
      .node-model {
        font-size: 11px;
        color: var(--muted);
        opacity: 0.7;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Per-status node treatments */
      .node.status-pending { opacity: 0.55; }
      .node.status-pending .node-pulse { background: var(--muted); }

      .node.status-completed {
        border-color: var(--good);
        background: linear-gradient(180deg, var(--good-soft) 0%, var(--bg) 60%);
        animation: flash-success 700ms ease-out;
      }
      .node.status-completed .node-pulse { background: var(--good); }
      .node.status-completed .node-status { color: var(--good); }

      .node.status-failed {
        border-color: var(--bad);
        background: linear-gradient(180deg, var(--bad-soft) 0%, var(--bg) 60%);
        animation: flash-error 700ms ease-out;
      }
      .node.status-failed .node-pulse { background: var(--bad); }
      .node.status-failed .node-status { color: var(--bad); }

      .node.is-inflight {
        border-color: var(--accent);
        box-shadow: var(--shadow-glow-accent);
        background: linear-gradient(180deg, var(--accent-soft) 0%, var(--bg) 60%);
        animation: pulse-soft 1.6s ease-in-out infinite;
      }
      .node.is-inflight .node-pulse {
        background: var(--accent);
        animation: pulse-dot 1.4s ease-in-out infinite;
      }
      .node.is-inflight .node-status { color: var(--accent); }

      /* ─── Per-agent table inflight cue ─────────────────────────── */
      .per-agent-wrap { overflow-x: auto; }
      tr.agent-row { transition: background var(--t-mid); }
      tr.agent-row.is-inflight {
        background: linear-gradient(
          90deg,
          transparent 0%,
          var(--accent-soft) 50%,
          transparent 100%
        );
        background-size: 200% 100%;
        animation: shimmer 2.4s linear infinite;
      }
      tr.agent-row.status-completed td:nth-child(2) {
        color: var(--good);
      }

      /* ─── Mermaid (now nested inside <details>) ────────────────── */
      pre.mermaid {
        background: var(--bg-2);
        padding: 16px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        overflow-x: auto;
        margin-top: 8px;
      }
      details.dag-schema {
        margin-top: 12px;
      }
      details.dag-schema summary {
        cursor: pointer;
        color: var(--muted);
        font-size: 11px;
        padding: 6px 0;
        user-select: none;
      }
      details.dag-schema summary:hover { color: var(--accent); }

      /* ─── Event log ────────────────────────────────────────────── */
      .event-log {
        font-size: 12px;
        max-height: 480px;
        overflow-y: auto;
        background: var(--bg-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        scrollbar-width: thin;
      }
      .event-log .ev {
        padding: 6px 10px;
        border-bottom: 1px dashed var(--border);
        animation: slide-in 280ms ease-out;
      }
      .event-log .ev:last-child { border-bottom: 0; }
      .event-log .ev .t { color: var(--muted); margin-right: 8px; }
      .event-log .ev .type { color: var(--accent); margin-right: 8px; font-weight: 600; }
      .event-log .ev .role { color: var(--warn); margin-right: 8px; }
      .event-log .ev .kv { color: var(--muted); }
      .ev-error .type, .ev-circuit_trip .type { color: var(--bad); }
      .ev-completion .type, .ev-state_transition .type { color: var(--good); }
      pre.kv { white-space: pre-wrap; word-break: break-word; margin: 0; }

      /* ─── Forms ────────────────────────────────────────────────── */
      form button {
        background: var(--accent);
        color: var(--bg);
        border: 0;
        padding: 8px 16px;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font: inherit;
        font-weight: 600;
        min-height: 36px;
        transition: filter var(--t-fast), transform var(--t-fast);
      }
      form button:hover { filter: brightness(1.1); }
      form button:active { transform: scale(0.97); }
      form button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      input, textarea {
        background: var(--bg-2);
        color: var(--fg);
        border: 1px solid var(--border);
        padding: 8px 10px;
        font: inherit;
        border-radius: var(--radius-sm);
        width: 100%;
        transition: border-color var(--t-fast);
      }
      input:focus, textarea:focus {
        outline: none;
        border-color: var(--accent);
      }
      textarea { font-family: inherit; min-height: 200px; }
      .grid { display: grid; gap: 24px; grid-template-columns: 1fr 1fr; }

      /* ─── Mobile (≤ 700px) ─────────────────────────────────────── */
      @media (max-width: 700px) {
        main { padding: 16px; }
        header { padding: 10px 16px; gap: 14px; font-size: 13px; }
        h1 { font-size: 16px; }
        .grid { grid-template-columns: 1fr; }
        .run-header { gap: 8px; }
        .run-stats { gap: 8px; font-size: 12px; }
        .run-stats .sep { display: none; }
        .dag-live { flex-direction: column; padding: 10px; }
        .dag-step { min-width: 0; padding-right: 0; padding-bottom: 22px; }
        .dag-step:not(:last-child)::after {
          content: "↓";
          right: 50%;
          top: auto;
          bottom: 4px;
          transform: translateX(50%);
        }
        .node { min-height: 0; }
        /* Card-ify the per-agent table */
        table.per-agent thead { display: none; }
        table.per-agent, table.per-agent tbody, table.per-agent tr, table.per-agent td {
          display: block;
          width: 100%;
        }
        table.per-agent tr {
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          margin-bottom: 8px;
          padding: 8px;
        }
        table.per-agent td {
          border: 0;
          padding: 4px 0;
        }
        table.per-agent td::before {
          content: attr(data-label) " ";
          color: var(--muted);
          margin-right: 8px;
          text-transform: uppercase;
          font-size: 10px;
          letter-spacing: 0.06em;
        }
        /* Tap targets */
        form button { min-height: 44px; padding: 10px 18px; }
        .conn-status { padding: 6px 12px; }
      }

      /* ─── Reduced motion respect ──────────────────────────────── */
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: 0.001ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.001ms !important;
        }
      }

      /* ─── Keyframes ───────────────────────────────────────────── */
      @keyframes pulse-soft {
        0%, 100% { box-shadow: 0 0 0 1px var(--accent), 0 0 8px var(--accent-soft); }
        50%       { box-shadow: 0 0 0 1px var(--accent), 0 0 22px var(--accent-soft); }
      }
      @keyframes pulse-dot {
        0%, 100% { opacity: 1; transform: scale(1); }
        50%      { opacity: 0.45; transform: scale(0.8); }
      }
      @keyframes flash-success {
        0%   { box-shadow: 0 0 0 0 var(--good), 0 0 24px var(--good-soft); }
        100% { box-shadow: 0 0 0 1px var(--good), 0 0 0 var(--good-soft); }
      }
      @keyframes flash-error {
        0%   { box-shadow: 0 0 0 0 var(--bad), 0 0 24px var(--bad-soft); }
        100% { box-shadow: 0 0 0 1px var(--bad), 0 0 0 var(--bad-soft); }
      }
      @keyframes shimmer {
        0%   { background-position: -100% 0; }
        100% { background-position: 100% 0; }
      }
      @keyframes slide-in {
        0%   { opacity: 0; transform: translateY(-4px); }
        100% { opacity: 1; transform: translateY(0); }
      }
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

      // SSE liveness indicator: flip the conn-status pill on stream errors / end.
      document.body.addEventListener("htmx:sseError", () => {
        const c = document.getElementById("conn-status");
        if (c) {
          c.classList.remove("is-live");
          c.classList.add("is-terminal");
          const lbl = c.querySelector(".conn-label");
          if (lbl) lbl.textContent = "reconnecting";
        }
      });
      document.body.addEventListener("htmx:sseClose", (e) => {
        const c = document.getElementById("conn-status");
        if (c) {
          c.classList.remove("is-live");
          c.classList.add("is-terminal");
          const lbl = c.querySelector(".conn-label");
          if (lbl) lbl.textContent = "ended";
        }
      });

      // Decorate per-agent table cells with data-label for mobile card layout.
      function labelCells() {
        const tables = document.querySelectorAll("table.per-agent");
        tables.forEach((t) => {
          const headers = [...t.querySelectorAll("thead th")].map((h) => h.textContent.trim());
          t.querySelectorAll("tbody tr").forEach((tr) => {
            [...tr.children].forEach((td, i) => {
              if (headers[i] && !td.hasAttribute("data-label")) {
                td.setAttribute("data-label", headers[i]);
              }
            });
          });
        });
      }
      labelCells();
      document.body.addEventListener("htmx:oobAfterSwap", labelCells);
    </script>
    ${opts.bodyScripts ?? raw("")}
  </body>
</html>`;
}
