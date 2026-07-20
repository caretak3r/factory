import { describe, it, expect, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

import { precedingStepAgents } from "../src/supervisor";
import type { PipelineStep } from "../src/types";

const step = (s: Partial<PipelineStep> & { step: string }): PipelineStep => s;

describe("precedingStepAgents", () => {
  it("returns the single agent of the immediately preceding step", () => {
    const steps = [
      step({ step: "a", agent: "alpha" }),
      step({ step: "g", type: "gate" }),
    ];
    expect(precedingStepAgents(steps, 1)).toEqual(["alpha"]);
  });

  it("returns all agents of a multi-agent preceding step", () => {
    const steps = [
      step({ step: "review", agents: ["sec", "perf"] }),
      step({ step: "g", type: "gate" }),
    ];
    expect(precedingStepAgents(steps, 1)).toEqual(["sec", "perf"]);
  });

  it("skips an intervening gate to reach the real agent step (gate-after-gate)", () => {
    const steps = [
      step({ step: "work", agents: ["a", "b"] }),
      step({ step: "g1", type: "gate" }),
      step({ step: "g2", type: "gate" }),
    ];
    expect(precedingStepAgents(steps, 2)).toEqual(["a", "b"]);
  });

  it("returns the agents of a preceding when-guarded step (structure only)", () => {
    const steps = [
      step({ step: "maybe", agent: "cond", when: "agent.x.completed" }),
      step({ step: "g", type: "gate" }),
    ];
    expect(precedingStepAgents(steps, 1)).toEqual(["cond"]);
  });

  it("returns [] for a gate as the first step", () => {
    const steps = [step({ step: "g", type: "gate" })];
    expect(precedingStepAgents(steps, 0)).toEqual([]);
  });

  it("returns [] when only gates precede", () => {
    const steps = [
      step({ step: "g0", type: "gate" }),
      step({ step: "g1", type: "gate" }),
    ];
    expect(precedingStepAgents(steps, 1)).toEqual([]);
  });
});
