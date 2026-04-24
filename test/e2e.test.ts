import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parsePipelineYaml, validatePipelineConfig } from "../src/schema";

const codeReviewYaml = readFileSync("pipelines/code-review.yaml", "utf-8");

describe("E2E: Pipeline Integration", () => {
  it("code-review.yaml is valid and passes all validation", () => {
    const parsed = parsePipelineYaml(codeReviewYaml);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const errors = validatePipelineConfig(parsed.data);
    expect(errors).toEqual([]);
  });

  it("code-review pipeline has correct structure for parallel review + synthesis", () => {
    const parsed = parsePipelineYaml(codeReviewYaml);
    if (!parsed.success) return;

    const config = parsed.data;

    // 4 agents: security, performance, correctness, synthesizer
    expect(config.agents).toHaveLength(4);
    const agentIds = config.agents.map((a) => a.id);
    expect(agentIds).toContain("security");
    expect(agentIds).toContain("performance");
    expect(agentIds).toContain("correctness");
    expect(agentIds).toContain("synthesizer");

    // Step 1: parallel review of 3 agents
    const reviewStep = config.pipeline[0];
    expect(reviewStep.step).toBe("review");
    expect(reviewStep.agents).toEqual(["security", "performance", "correctness"]);
    expect(reviewStep.mode).toBe("parallel");

    // Step 2: gate
    const gateStep = config.pipeline[1];
    expect(gateStep.type).toBe("gate");
    expect(gateStep.condition).toBe("all_agents_completed");

    // Step 3: synthesize with inputs from all 3 reviewers
    const synthStep = config.pipeline[2];
    expect(synthStep.agent).toBe("synthesizer");
    expect(synthStep.inputs).toEqual(["security", "performance", "correctness"]);
  });

  it("model defaults map tiers correctly", () => {
    const parsed = parsePipelineYaml(codeReviewYaml);
    if (!parsed.success) return;

    expect(parsed.data.model_defaults.planning).toBe("claude-opus-4-6");
    expect(parsed.data.model_defaults.execution).toBe("claude-sonnet-4-6");
    expect(parsed.data.model_defaults.classification).toBe("claude-haiku-4-5-20251001");
  });

  it("budget constraints are reasonable", () => {
    const parsed = parsePipelineYaml(codeReviewYaml);
    if (!parsed.success) return;

    expect(parsed.data.budget.max_tokens).toBe(100000);
    expect(parsed.data.budget.max_duration_ms).toBe(300000); // 5 minutes
    expect(parsed.data.budget.max_retries).toBe(6);
  });

  it("all agent models resolve to valid tier keywords", () => {
    const parsed = parsePipelineYaml(codeReviewYaml);
    if (!parsed.success) return;

    const validTiers = new Set(["planning", "execution", "classification"]);
    for (const agent of parsed.data.agents) {
      expect(
        validTiers.has(agent.model) || agent.model.startsWith("claude-"),
        `Agent ${agent.id} has invalid model: ${agent.model}`
      ).toBe(true);
    }
  });

  // Note: index.ts export test requires cloudflare:workers runtime.
  // Verified via: npx wrangler deploy --dry-run --outdir=dist
  it("recovery config uses expected keywords", () => {
    const parsed = parsePipelineYaml(codeReviewYaml);
    if (!parsed.success) return;

    expect(parsed.data.recovery.default).toContain("retry");
    expect(parsed.data.recovery.fallback).toContain("degrade");
    expect(parsed.data.recovery.escalation).toContain("human");
  });
});
