import { describe, it, expect } from "vitest";
import { nextBackoffMs, shouldRetry, planRecovery } from "../src/recovery";
import type {
  AgentConfig,
  DagNode,
  PipelineConfig,
  RetryPolicy,
} from "../src/types";

const ZERO_RANDOM = () => 0;

describe("recovery.nextBackoffMs", () => {
  it("computes exponential backoff base * 2^(n-1) with no jitter", () => {
    const policy: RetryPolicy = { max: 5, backoff: "exponential", base_ms: 100 };
    expect(nextBackoffMs(policy, 1, ZERO_RANDOM)).toBe(100);  // 100 * 2^0
    expect(nextBackoffMs(policy, 2, ZERO_RANDOM)).toBe(200);  // 100 * 2^1
    expect(nextBackoffMs(policy, 3, ZERO_RANDOM)).toBe(400);  // 100 * 2^2
    expect(nextBackoffMs(policy, 4, ZERO_RANDOM)).toBe(800);
  });

  it("computes linear backoff base * n", () => {
    const policy: RetryPolicy = { max: 5, backoff: "linear", base_ms: 250 };
    expect(nextBackoffMs(policy, 1, ZERO_RANDOM)).toBe(250);
    expect(nextBackoffMs(policy, 2, ZERO_RANDOM)).toBe(500);
    expect(nextBackoffMs(policy, 4, ZERO_RANDOM)).toBe(1000);
  });

  it("computes constant backoff = base regardless of attempt", () => {
    const policy: RetryPolicy = { max: 5, backoff: "constant", base_ms: 500 };
    expect(nextBackoffMs(policy, 1, ZERO_RANDOM)).toBe(500);
    expect(nextBackoffMs(policy, 7, ZERO_RANDOM)).toBe(500);
  });

  it("caps backoff at cap_ms", () => {
    const policy: RetryPolicy = {
      max: 10,
      backoff: "exponential",
      base_ms: 1000,
      cap_ms: 5000,
    };
    // attempt 10 → 1000 * 2^9 = 512_000, capped to 5000
    expect(nextBackoffMs(policy, 10, ZERO_RANDOM)).toBe(5000);
  });

  it("default cap is 30s when not specified", () => {
    const policy: RetryPolicy = { max: 20, backoff: "exponential", base_ms: 1000 };
    expect(nextBackoffMs(policy, 20, ZERO_RANDOM)).toBe(30_000);
  });

  it("adds 0..base ms of jitter", () => {
    const policy: RetryPolicy = { max: 5, backoff: "constant", base_ms: 100 };
    expect(nextBackoffMs(policy, 1, () => 0.99)).toBe(199); // 100 + 99
    expect(nextBackoffMs(policy, 1, () => 0)).toBe(100);
  });
});

describe("recovery.shouldRetry", () => {
  it("returns false when no policy", () => {
    expect(shouldRetry(undefined, 0)).toBe(false);
  });

  it("returns true while retry_count < max", () => {
    const p: RetryPolicy = { max: 3, backoff: "exponential" };
    expect(shouldRetry(p, 0)).toBe(true);
    expect(shouldRetry(p, 2)).toBe(true);
  });

  it("returns false at retry_count == max", () => {
    const p: RetryPolicy = { max: 3, backoff: "exponential" };
    expect(shouldRetry(p, 3)).toBe(false);
    expect(shouldRetry(p, 99)).toBe(false);
  });
});

// ─── planRecovery ─────────────────────────────────────

function makeConfig(overrides: Partial<PipelineConfig["recovery"]>): PipelineConfig {
  return {
    name: "t",
    version: 1,
    description: "t",
    model_defaults: { planning: "p", execution: "e", classification: "c" },
    agents: [],
    pipeline: [],
    recovery: { ...overrides },
    budget: { max_tokens: 1000, max_duration_ms: 1000, max_retries: 5 },
  };
}

const baseAgent: AgentConfig = {
  id: "alpha",
  role: "test",
  model: "execution",
  tools: [],
  memory: { max_tokens: 1000 },
};

function makeNode(retry_count: number): DagNode {
  return {
    agent_id: "alpha",
    do_id: "id",
    status: "failed",
    step_index: 0,
    tokens_used: 0,
    duration_ms: 0,
    retry_count,
  };
}

describe("recovery.planRecovery", () => {
  it("retries when retry budget remains", () => {
    const config = makeConfig({
      default: { max: 2, backoff: "exponential", base_ms: 100 },
    });
    const action = planRecovery({
      config,
      agent: baseAgent,
      node: makeNode(0),
      random: ZERO_RANDOM,
    });
    expect(action.kind).toBe("retry");
    if (action.kind === "retry") {
      expect(action.attempt).toBe(1);
      expect(action.delay_ms).toBe(100);
    }
  });

  it("falls back to agent.fallback when retries exhausted", () => {
    const config = makeConfig({
      default: { max: 2, backoff: "exponential", base_ms: 100 },
    });
    const action = planRecovery({
      config,
      agent: { ...baseAgent, fallback: "beta" },
      node: makeNode(2),
    });
    expect(action).toEqual({ kind: "fallback", agent_id: "beta", skip: false });
  });

  it("falls back to recovery.fallback.use_agent when no agent.fallback", () => {
    const config = makeConfig({
      default: { max: 1, backoff: "constant" },
      fallback: { use_agent: "rescue" },
    });
    const action = planRecovery({
      config,
      agent: baseAgent,
      node: makeNode(1),
    });
    expect(action).toEqual({ kind: "fallback", agent_id: "rescue", skip: false });
  });

  it("skips failed agent when fallback.skip_failed_agent set", () => {
    const config = makeConfig({
      default: { max: 1, backoff: "constant" },
      fallback: { skip_failed_agent: true },
    });
    const action = planRecovery({
      config,
      agent: baseAgent,
      node: makeNode(1),
    });
    expect(action).toEqual({ kind: "fallback", agent_id: null, skip: true });
  });

  it("escalates when no fallback and escalation configured", () => {
    const config = makeConfig({
      default: { max: 1, backoff: "constant" },
      escalation: { channel: "human", target: "ops" },
    });
    const action = planRecovery({
      config,
      agent: baseAgent,
      node: makeNode(1),
    });
    expect(action).toEqual({ kind: "escalate", channel: "human", target: "ops" });
  });

  it("fails when nothing matches", () => {
    const config = makeConfig({});
    const action = planRecovery({
      config,
      agent: baseAgent,
      node: makeNode(0),
    });
    expect(action.kind).toBe("fail");
  });
});
