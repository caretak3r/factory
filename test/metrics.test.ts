import { describe, it, expect } from "vitest";
import { aggregateMetrics } from "../src/metrics";
import type { DagState, PipelineEvent } from "../src/types";

function makeDag(overrides: Partial<DagState> = {}): DagState {
  return {
    run_id: "run-1",
    pipeline_name: "code-review",
    status: "completed",
    current_step: 3,
    nodes: {
      security: {
        agent_id: "security",
        do_id: "do-1",
        status: "completed",
        step_index: 0,
        tokens_used: 1200,
        duration_ms: 4000,
        retry_count: 0,
        model: "claude-sonnet-4-6",
      },
      performance: {
        agent_id: "performance",
        do_id: "do-2",
        status: "completed",
        step_index: 0,
        tokens_used: 800,
        duration_ms: 3200,
        retry_count: 1,
        model: "claude-sonnet-4-6",
      },
      flaky: {
        agent_id: "flaky",
        do_id: "do-3",
        status: "failed",
        step_index: 0,
        tokens_used: 0,
        duration_ms: 0,
        retry_count: 2,
        error: "boom",
      },
    },
    steps: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:01:00.000Z",
    input_ref: "runs/run-1/input.json",
    total_tokens: 2000,
    total_duration_ms: 4000,
    ...overrides,
  };
}

function evt(
  event_type: PipelineEvent["event_type"],
  details: Record<string, unknown> = {}
): PipelineEvent {
  return {
    id: Math.random().toString(),
    run_id: "run-1",
    timestamp: "2026-01-01T00:00:30.000Z",
    event_type,
    details,
  };
}

describe("metrics.aggregateMetrics", () => {
  it("counts completed and failed agents", () => {
    const m = aggregateMetrics(makeDag(), []);
    expect(m.agents_completed).toBe(2);
    expect(m.agents_failed).toBe(1);
  });

  it("sums retries across all agents", () => {
    const m = aggregateMetrics(makeDag(), []);
    expect(m.total_retries).toBe(3); // 0 + 1 + 2
  });

  it("propagates total_tokens and total_duration from DAG", () => {
    const m = aggregateMetrics(makeDag(), []);
    expect(m.total_tokens).toBe(2000);
    expect(m.total_duration_ms).toBe(4000);
  });

  it("counts gate pass / fail from events", () => {
    const events = [
      evt("gate_eval", { pass: true }),
      evt("gate_eval", { pass: false, reason: "x" }),
      evt("gate_eval", { pass: true }),
    ];
    const m = aggregateMetrics(makeDag(), events);
    expect(m.gates_passed).toBe(2);
    expect(m.gates_failed).toBe(1);
  });

  it("counts recovery attempts and circuit trips", () => {
    const events = [
      evt("recovery_attempt", { kind: "retry" }),
      evt("recovery_attempt", { kind: "fallback" }),
      evt("circuit_trip", { role: "flaky" }),
    ];
    const m = aggregateMetrics(makeDag(), events);
    expect(m.recovery_attempts).toBe(2);
    expect(m.circuit_trips).toBe(1);
  });

  it("emits per-agent breakdown including model", () => {
    const m = aggregateMetrics(makeDag(), []);
    expect(m.per_agent).toHaveLength(3);

    const sec = m.per_agent.find((a) => a.agent_id === "security")!;
    expect(sec.tokens_used).toBe(1200);
    expect(sec.model).toBe("claude-sonnet-4-6");

    const flaky = m.per_agent.find((a) => a.agent_id === "flaky")!;
    expect(flaky.status).toBe("failed");
    expect(flaky.model).toBeNull();
    expect(flaky.retry_count).toBe(2);
  });

  it("preserves run identity", () => {
    const m = aggregateMetrics(makeDag(), []);
    expect(m.run_id).toBe("run-1");
    expect(m.pipeline_name).toBe("code-review");
    expect(m.status).toBe("completed");
  });
});
