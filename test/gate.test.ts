import { describe, it, expect } from "vitest";
import { evaluateGate } from "../src/gate";
import type { DagNode, PipelineStep, BudgetConfig } from "../src/types";

function makeNode(overrides: Partial<DagNode> = {}): DagNode {
  return {
    agent_id: "test",
    do_id: "do-123",
    status: "completed",
    step_index: 0,
    tokens_used: 1000,
    duration_ms: 5000,
    retry_count: 0,
    ...overrides,
  };
}

describe("evaluateGate", () => {
  it("passes all_agents_completed when all agents completed", () => {
    const gate: PipelineStep = {
      step: "gate-1",
      type: "gate",
      condition: "all_agents_completed",
      on_fail: "retry(max=1)",
    };
    const agents = ["a", "b", "c"];
    const nodes: Record<string, DagNode> = {
      a: makeNode({ agent_id: "a", status: "completed" }),
      b: makeNode({ agent_id: "b", status: "completed" }),
      c: makeNode({ agent_id: "c", status: "completed" }),
    };
    const budget: BudgetConfig = { max_tokens: 100000, max_duration_ms: 300000, max_retries: 6 };

    const result = evaluateGate(gate, agents, nodes, budget);
    expect(result.pass).toBe(true);
  });

  it("fails all_agents_completed when one agent failed", () => {
    const gate: PipelineStep = {
      step: "gate-1",
      type: "gate",
      condition: "all_agents_completed",
      on_fail: "retry(max=1)",
    };
    const agents = ["a", "b"];
    const nodes: Record<string, DagNode> = {
      a: makeNode({ agent_id: "a", status: "completed" }),
      b: makeNode({ agent_id: "b", status: "failed" }),
    };
    const budget: BudgetConfig = { max_tokens: 100000, max_duration_ms: 300000, max_retries: 6 };

    const result = evaluateGate(gate, agents, nodes, budget);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("b");
  });

  it("fails token_budget when total exceeds limit", () => {
    const gate: PipelineStep = {
      step: "budget-gate",
      type: "gate",
      condition: "token_budget",
    };
    const agents = ["a"];
    const nodes: Record<string, DagNode> = {
      a: makeNode({ agent_id: "a", tokens_used: 150000 }),
    };
    const budget: BudgetConfig = { max_tokens: 100000, max_duration_ms: 300000, max_retries: 6 };

    const result = evaluateGate(gate, agents, nodes, budget);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("Token");
  });

  it("returns pass for unknown condition (permissive default)", () => {
    const gate: PipelineStep = {
      step: "unknown-gate",
      type: "gate",
      condition: "something_custom",
    };

    const result = evaluateGate(gate, [], {}, { max_tokens: 100000, max_duration_ms: 300000, max_retries: 6 });
    expect(result.pass).toBe(true);
  });
});
