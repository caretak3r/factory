import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parsePipelineYaml, validatePipelineConfig } from "../src/schema";
import { resolveImports } from "../src/composition";

const codeReviewYaml = readFileSync("pipelines/code-review.yaml", "utf-8");
const securityBaseYaml = readFileSync("pipelines/security-base.yaml", "utf-8");
const conditionalReviewYaml = readFileSync(
  "pipelines/conditional-review.yaml",
  "utf-8"
);

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
  it("security-base.yaml is a valid standalone pipeline", () => {
    const parsed = parsePipelineYaml(securityBaseYaml);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(validatePipelineConfig(parsed.data)).toEqual([]);
    // Both imported agents should be public-exposed
    expect(parsed.data.agents.every((a) => a.gossip?.expose === "public")).toBe(true);
  });

  it("conditional-review.yaml resolves imports and validates end-to-end", async () => {
    const parsed = parsePipelineYaml(conditionalReviewYaml);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const resolved = await resolveImports(parsed.data, async (name) =>
      name === "security-base" ? securityBaseYaml : null
    );

    // After import: agents should include the namespaced sub-pipeline agents
    const agentIds = resolved.agents.map((a) => a.id).sort();
    expect(agentIds).toContain("security-review__scanner");
    expect(agentIds).toContain("security-review__triage");
    expect(agentIds).toContain("deep-dive");
    expect(agentIds).toContain("synthesizer");

    // Validation should pass — references in deep-dive/synthesize must resolve
    expect(validatePipelineConfig(resolved)).toEqual([]);

    // when: clause survives import
    const deepDive = resolved.pipeline.find((s) => s.step === "deep-dive")!;
    expect(deepDive.when).toContain("security-review__triage.tokens");
  });

  it("recovery config parses into structured policies", () => {
    const parsed = parsePipelineYaml(codeReviewYaml);
    if (!parsed.success) return;

    expect(parsed.data.recovery.default).toEqual({
      max: 2,
      backoff: "exponential",
    });
    expect(parsed.data.recovery.fallback).toEqual({ skip_failed_agent: true });
    expect(parsed.data.recovery.escalation).toEqual({ channel: "notification" });
  });
});
