import { describe, it, expect } from "vitest";
import {
  evaluateCondition,
  remapRefs,
  ConditionError,
  __conditionCacheSize,
  __clearConditionCache,
} from "../src/conditional";
import type { DagState, PipelineEvent } from "../src/types";

function makeCtx(overrides: Partial<DagState> = {}, events: PipelineEvent[] = []) {
  return {
    dag: {
      run_id: "r",
      pipeline_name: "p",
      status: "running" as const,
      current_step: 0,
      nodes: {
        security: {
          agent_id: "security",
          do_id: "id",
          status: "completed" as const,
          step_index: 0,
          tokens_used: 1500,
          duration_ms: 4000,
          retry_count: 1,
        },
        flaky: {
          agent_id: "flaky",
          do_id: "id",
          status: "failed" as const,
          step_index: 0,
          tokens_used: 0,
          duration_ms: 0,
          retry_count: 3,
        },
      },
      steps: [],
      created_at: "t",
      updated_at: "t",
      input_ref: "r",
      total_tokens: 1500,
      total_duration_ms: 4000,
      ...overrides,
    },
    events,
  };
}

describe("conditional — literals & operators", () => {
  it("evaluates booleans", () => {
    expect(evaluateCondition("true", makeCtx())).toBe(true);
    expect(evaluateCondition("false", makeCtx())).toBe(false);
  });

  it("evaluates not / and / or", () => {
    expect(evaluateCondition("not false", makeCtx())).toBe(true);
    expect(evaluateCondition("true and false", makeCtx())).toBe(false);
    expect(evaluateCondition("true or false", makeCtx())).toBe(true);
    expect(evaluateCondition("not (true and false)", makeCtx())).toBe(true);
  });

  it("evaluates numeric comparisons", () => {
    expect(evaluateCondition("1500 > 1000", makeCtx())).toBe(true);
    expect(evaluateCondition("1500 <= 1500", makeCtx())).toBe(true);
    expect(evaluateCondition("1500 == 1500", makeCtx())).toBe(true);
    expect(evaluateCondition("1500 != 1500", makeCtx())).toBe(false);
  });

  it("parses decimal literals", () => {
    expect(evaluateCondition("1.5 > 1", makeCtx())).toBe(true);
    expect(evaluateCondition("0.5 < 1", makeCtx())).toBe(true);
    expect(evaluateCondition("1.5 == 1.5", makeCtx())).toBe(true);
  });

  it("does not treat identifier path dots as decimals", () => {
    // Regression guard: agent.<id>.<field> must still resolve, not tokenize as a number.
    expect(evaluateCondition("agent.security.completed", makeCtx())).toBe(true);
  });

  it("evaluates string comparisons", () => {
    expect(evaluateCondition('"a" == "a"', makeCtx())).toBe(true);
    expect(evaluateCondition('"a" != "b"', makeCtx())).toBe(true);
  });
});

describe("conditional — agent references", () => {
  it("resolves agent.X.completed and .failed", () => {
    expect(evaluateCondition("agent.security.completed", makeCtx())).toBe(true);
    expect(evaluateCondition("agent.security.failed", makeCtx())).toBe(false);
    expect(evaluateCondition("agent.flaky.failed", makeCtx())).toBe(true);
  });

  it("resolves agent.X.tokens", () => {
    expect(evaluateCondition("agent.security.tokens > 1000", makeCtx())).toBe(true);
    expect(evaluateCondition("agent.security.tokens < 100", makeCtx())).toBe(false);
  });

  it("resolves agent.X.retry_count", () => {
    expect(evaluateCondition("agent.flaky.retry_count == 3", makeCtx())).toBe(true);
  });

  it("throws on unknown agent", () => {
    expect(() => evaluateCondition("agent.ghost.completed", makeCtx())).toThrow(ConditionError);
  });

  it("throws on unknown agent field", () => {
    expect(() => evaluateCondition("agent.security.bogus", makeCtx())).toThrow(ConditionError);
  });
});

describe("conditional — gate references", () => {
  const events: PipelineEvent[] = [
    {
      id: "1",
      run_id: "r",
      timestamp: "t",
      event_type: "gate_eval",
      details: { gate: "quality", pass: true, reason: "ok" },
    },
  ];

  it("resolves gate.X.passed", () => {
    expect(evaluateCondition("gate.quality.passed", makeCtx({}, events))).toBe(true);
    expect(evaluateCondition("gate.quality.failed", makeCtx({}, events))).toBe(false);
  });

  it("returns false for not-yet-fired gates", () => {
    expect(evaluateCondition("gate.unfired.passed", makeCtx({}, []))).toBe(false);
  });
});

describe("conditional — metrics references", () => {
  it("resolves metrics.total_tokens and total_retries", () => {
    expect(evaluateCondition("metrics.total_tokens == 1500", makeCtx())).toBe(true);
    expect(evaluateCondition("metrics.total_retries == 4", makeCtx())).toBe(true); // 1 + 3
  });

  it("counts gates_passed/failed from events", () => {
    const events: PipelineEvent[] = [
      { id: "1", run_id: "r", timestamp: "t", event_type: "gate_eval", details: { pass: true } },
      { id: "2", run_id: "r", timestamp: "t", event_type: "gate_eval", details: { pass: false } },
      { id: "3", run_id: "r", timestamp: "t", event_type: "gate_eval", details: { pass: true } },
    ];
    expect(evaluateCondition("metrics.gates_passed == 2", makeCtx({}, events))).toBe(true);
    expect(evaluateCondition("metrics.gates_failed == 1", makeCtx({}, events))).toBe(true);
  });
});

describe("conditional — injection guards", () => {
  it("rejects unknown reference roots", () => {
    expect(() => evaluateCondition("env.SECRET == 'leak'", makeCtx())).toThrow(ConditionError);
    expect(() =>
      evaluateCondition("global.ARTIFACT_STORE == 'x'", makeCtx())
    ).toThrow(ConditionError);
  });

  it("rejects bare JS-like syntax", () => {
    expect(() => evaluateCondition("1 + 1", makeCtx())).toThrow(ConditionError);
    expect(() => evaluateCondition("`${x}`", makeCtx())).toThrow(ConditionError);
    expect(() => evaluateCondition("eval('1')", makeCtx())).toThrow(ConditionError);
  });

  it("rejects unterminated strings and bad regex", () => {
    expect(() => evaluateCondition('"unterminated', makeCtx())).toThrow(ConditionError);
  });

  it("rejects bad parentheses", () => {
    expect(() => evaluateCondition("(true", makeCtx())).toThrow(ConditionError);
  });
});

describe("conditional — realistic combinations", () => {
  it("supports a typical 'high severity escalation' clause", () => {
    const ctx = makeCtx();
    const expr =
      "(agent.security.completed and agent.security.tokens > 1000) or agent.flaky.failed";
    expect(evaluateCondition(expr, ctx)).toBe(true);
  });

  it("supports a 'budget breach' clause", () => {
    expect(
      evaluateCondition("metrics.total_tokens > 1000 and metrics.total_retries >= 3", makeCtx())
    ).toBe(true);
  });
});

describe("remapRefs", () => {
  it("prefixes agent references", () => {
    expect(remapRefs("agent.scanner.completed", "review__")).toBe(
      "agent.review__scanner.completed"
    );
  });

  it("prefixes gate references", () => {
    expect(remapRefs("gate.check.passed", "review__")).toBe(
      "gate.review__check.passed"
    );
  });

  it("leaves metrics references and literals untouched", () => {
    expect(remapRefs("metrics.total_tokens > 100", "p__")).toBe(
      "metrics.total_tokens > 100"
    );
  });

  it("prefixes every reference in a compound expression", () => {
    expect(remapRefs("agent.a.completed and agent.b.failed", "x__")).toBe(
      "agent.x__a.completed and agent.x__b.failed"
    );
  });

  it("does not treat an agent id named agent as a second root", () => {
    expect(remapRefs("agent.agent.completed", "review__")).toBe(
      "agent.review__agent.completed"
    );
  });

  it("does not treat an agent id named gate as a gate root", () => {
    expect(remapRefs("agent.gate.completed", "review__")).toBe(
      "agent.review__gate.completed"
    );
  });

  it("does not treat a gate step named gate as a second root", () => {
    expect(remapRefs("gate.gate.passed", "review__")).toBe(
      "gate.review__gate.passed"
    );
  });

  it("does not treat a gate step named agent as an agent root", () => {
    expect(remapRefs("gate.agent.passed", "review__")).toBe(
      "gate.review__agent.passed"
    );
  });

  it("returns a blank expression unchanged", () => {
    expect(remapRefs("   ", "x__")).toBe("   ");
  });

  it("throws ConditionError on a malformed expression", () => {
    expect(() => remapRefs("agent..", "x__")).toThrow(ConditionError);
  });
});

describe("evaluateCondition blank guard (CFEAT-05)", () => {
  it("treats an empty expression as true", () => {
    expect(evaluateCondition("", makeCtx())).toBe(true);
  });

  it("treats a whitespace expression as true", () => {
    expect(evaluateCondition("   ", makeCtx())).toBe(true);
  });
});

describe("evaluateCondition AST memoization", () => {
  it("compiles each distinct expression exactly once", () => {
    __clearConditionCache();
    expect(__conditionCacheSize()).toBe(0);
    const ctx = makeCtx();
    evaluateCondition("metrics.total_tokens > 100", ctx);
    evaluateCondition("metrics.total_tokens > 100", ctx);
    evaluateCondition("metrics.total_tokens > 100", ctx);
    expect(__conditionCacheSize()).toBe(1); // 3 evals, 1 parse
    evaluateCondition("metrics.total_retries > 0", ctx);
    expect(__conditionCacheSize()).toBe(2);
  });

  it("does not cache the blank-guard shortcut", () => {
    __clearConditionCache();
    evaluateCondition("", makeCtx());
    evaluateCondition("   ", makeCtx());
    expect(__conditionCacheSize()).toBe(0);
  });
});
