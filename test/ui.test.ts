import { describe, it, expect } from "vitest";
import {
  home,
  runList,
  runDetail,
  pipelineList,
  pipelineDetail,
  dagMermaid,
  eventRow,
  eventLog,
} from "../src/ui/components";
import type { DagState, PipelineEvent } from "../src/types";

function render(node: unknown): string {
  return String(node);
}

const sampleDag: DagState = {
  run_id: "run-abc",
  pipeline_name: "code-review",
  status: "running",
  current_step: 0,
  nodes: {
    security: {
      agent_id: "security",
      do_id: "id-1",
      status: "completed",
      step_index: 0,
      tokens_used: 1200,
      duration_ms: 4000,
      retry_count: 0,
      model: "claude-sonnet-4-6",
    },
    perf: {
      agent_id: "perf",
      do_id: "id-2",
      status: "running",
      step_index: 0,
      tokens_used: 0,
      duration_ms: 0,
      retry_count: 0,
    },
    synthesizer: {
      agent_id: "synthesizer",
      do_id: "id-3",
      status: "pending",
      step_index: 1,
      tokens_used: 0,
      duration_ms: 0,
      retry_count: 0,
    },
  },
  steps: [
    { step: "review", agents: ["security", "perf"], mode: "parallel" },
    { step: "synthesize", agent: "synthesizer", inputs: ["security", "perf"] },
  ],
  created_at: "2026-05-03T10:00:00.000Z",
  updated_at: "2026-05-03T10:01:00.000Z",
  input_ref: "runs/run-abc/input.json",
  total_tokens: 1200,
  total_duration_ms: 4000,
};

describe("ui.home", () => {
  it("renders nav links", () => {
    const html = render(home());
    expect(html).toContain("AgentX Factory");
    expect(html).toContain('href="/runs"');
    expect(html).toContain('href="/pipelines"');
  });
});

describe("ui.runList", () => {
  it("shows empty state when no runs", () => {
    expect(render(runList([]))).toMatch(/No runs yet/);
  });

  it("links to each run with truncated id", () => {
    const html = render(
      runList([
        {
          run_id: "abcdefghij",
          pipeline: "code-review",
          created_at: "2026-05-03",
          status: "completed",
        },
      ])
    );
    expect(html).toContain('href="/runs/abcdefghij"');
    expect(html).toContain("abcdefgh"); // truncated to 8
    expect(html).toContain("code-review");
    expect(html).toContain("status-completed");
  });
});

describe("ui.runDetail", () => {
  it("renders status pill, DAG container, and per-agent table", () => {
    const html = render(runDetail("run-abc", sampleDag, []));
    expect(html).toContain('class="pill status-running"');
    expect(html).toContain('id="dag"');
    expect(html).toContain('hx-get="/ui/runs/run-abc/dag"');
    expect(html).toContain("claude-sonnet-4-6");
    expect(html).toContain("synthesizer");
  });

  it("wires SSE stream with cursor", () => {
    const events: PipelineEvent[] = [
      { id: "5", run_id: "run-abc", timestamp: "2026-05-03T10:00:00Z", event_type: "dispatch", details: {} },
    ];
    const html = render(runDetail("run-abc", sampleDag, events));
    expect(html).toContain('sse-connect="/api/runs/run-abc/stream?since=5"');
    // Visible event log subscribes to per-event stream
    expect(html).toContain('sse-swap="event"');
    // Hidden sink subscribes to per-state-change stream (drives OOB updates)
    expect(html).toContain('sse-swap="state"');
  });
});

describe("ui.eventRow", () => {
  it("classifies error event with bad-color class", () => {
    const ev: PipelineEvent = {
      id: "1",
      run_id: "r",
      timestamp: "2026-01-01T00:00:00Z",
      event_type: "error",
      agent_role: "security",
      details: { error: "boom" },
    };
    const html = render(eventRow(ev));
    expect(html).toContain("ev-error");
    expect(html).toContain("security");
    expect(html).toContain("boom");
  });

  it("renders all phase-2 event types", () => {
    const types = ["recovery_attempt", "circuit_trip", "escalation"] as const;
    for (const t of types) {
      const html = render(
        eventRow({
          id: "1",
          run_id: "r",
          timestamp: "2026-01-01T00:00:00Z",
          event_type: t,
          details: {},
        })
      );
      expect(html).toContain(`ev-${t}`);
      expect(html).toContain(t);
    }
  });
});

describe("ui.eventLog", () => {
  it("wraps events in scrollable container", () => {
    const html = render(eventLog([]));
    expect(html).toContain('class="event-log"');
    expect(html).toContain('id="event-log"');
  });
});

describe("ui.dagMermaid", () => {
  it("emits valid flowchart with one node per agent", () => {
    const html = render(dagMermaid(sampleDag));
    expect(html).toContain("flowchart LR");
    expect(html).toContain("security");
    expect(html).toContain("perf");
    expect(html).toContain("synthesizer");
    expect(html).toContain('class="mermaid"');
  });

  it("links earlier steps to later steps", () => {
    const html = render(dagMermaid(sampleDag));
    // both review-step nodes should connect into synthesizer
    expect(html).toMatch(/security --> synthesizer/);
    expect(html).toMatch(/perf --> synthesizer/);
  });

  it("strips chars that would break Mermaid labels", () => {
    const naughty: DagState = {
      ...sampleDag,
      pipeline_name: 'evil"<script>',
      nodes: {
        'x"|<>': {
          agent_id: 'x"|<>',
          do_id: "i",
          status: "pending",
          step_index: 0,
          tokens_used: 0,
          duration_ms: 0,
          retry_count: 0,
        },
      },
    };
    const html = render(dagMermaid(naughty));
    // None of the dangerous chars should survive into the Mermaid block
    expect(html).not.toContain('"<');
    expect(html).not.toContain("|");
  });
});

describe("ui.pipelineList / pipelineDetail", () => {
  it("renders empty state and populated list", () => {
    expect(render(pipelineList([]))).toMatch(/No pipelines yet/);
    const html = render(pipelineList(["code-review", "test"]));
    expect(html).toContain('href="/pipelines/code-review"');
    expect(html).toContain('href="/pipelines/test"');
  });

  it("includes run-form posting to /ui/runs/start", () => {
    const html = render(pipelineDetail("code-review", "name: code-review\n"));
    expect(html).toContain('hx-post="/ui/runs/start"');
    expect(html).toContain('value="code-review"');
  });

  it("escapes pipeline YAML when rendering as <pre>", () => {
    const html = render(pipelineDetail("foo", "evil: <script>alert(1)</script>"));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
