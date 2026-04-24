import { describe, it, expect } from "vitest";
import { parsePipelineYaml, validatePipelineConfig } from "../src/schema";

const codeReviewYaml = `
name: code-review
version: 1
description: Parallel multi-perspective code review with synthesis

model_defaults:
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  classification: claude-haiku-4-5-20251001

agents:
  - id: security
    role: >
      Security engineer. Review the diff for vulnerabilities:
      injection, auth bypass, data exposure, dependency risks.
      Output structured findings with severity ratings.
    model: execution
    tools: []
    memory:
      max_tokens: 8000

  - id: performance
    role: >
      Performance engineer. Review the diff for bottlenecks:
      N+1 queries, unbounded loops, memory leaks, missing indexes.
      Output structured findings with impact estimates.
    model: execution
    tools: []
    memory:
      max_tokens: 8000

  - id: correctness
    role: >
      Senior engineer. Review the diff for logic errors:
      edge cases, race conditions, incorrect assumptions,
      missing error handling. Output structured findings.
    model: planning
    tools: []
    memory:
      max_tokens: 16000

  - id: synthesizer
    role: >
      Merge all review findings into a single report.
      Deduplicate, prioritize by severity, add overall assessment.
    model: execution
    tools: []
    memory:
      max_tokens: 4000

pipeline:
  - step: review
    agents: [security, performance, correctness]
    mode: parallel

  - step: quality-gate
    type: gate
    condition: all_agents_completed
    on_fail: retry(max=1)

  - step: synthesize
    agent: synthesizer
    inputs: [security, performance, correctness]

recovery:
  default: "retry(max=2, backoff=exponential)"
  fallback: "degrade(skip_failed_agent=true)"
  escalation: "human(channel=notification)"

budget:
  max_tokens: 100000
  max_duration_ms: 300000
  max_retries: 6
`;

describe("schema", () => {
  describe("parsePipelineYaml", () => {
    it("parses valid code-review YAML into PipelineConfig", () => {
      const result = parsePipelineYaml(codeReviewYaml);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("code-review");
        expect(result.data.version).toBe(1);
        expect(result.data.agents).toHaveLength(4);
        expect(result.data.pipeline).toHaveLength(3);
        expect(result.data.budget.max_tokens).toBe(100000);
      }
    });

    it("rejects YAML with missing required fields", () => {
      const bad = "name: test\nversion: 1\n";
      const result = parsePipelineYaml(bad);
      expect(result.success).toBe(false);
    });

    it("rejects YAML with invalid agent (missing role)", () => {
      const bad = `
name: test
version: 1
description: test
model_defaults:
  planning: a
  execution: b
  classification: c
agents:
  - id: broken
    model: execution
    tools: []
    memory:
      max_tokens: 1000
pipeline:
  - step: run
    agent: broken
recovery:
  default: retry
  fallback: degrade
  escalation: human
budget:
  max_tokens: 1000
  max_duration_ms: 1000
  max_retries: 1
`;
      const result = parsePipelineYaml(bad);
      expect(result.success).toBe(false);
    });
  });

  describe("validatePipelineConfig", () => {
    it("catches agent references that don't exist in agents list", () => {
      const config = parsePipelineYaml(codeReviewYaml);
      expect(config.success).toBe(true);
      if (!config.success) return;

      const modified = { ...config.data };
      modified.pipeline = [{ step: "bad", agent: "nonexistent" }];
      const errors = validatePipelineConfig(modified);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("nonexistent");
    });

    it("passes valid config with no errors", () => {
      const config = parsePipelineYaml(codeReviewYaml);
      expect(config.success).toBe(true);
      if (!config.success) return;
      const errors = validatePipelineConfig(config.data);
      expect(errors).toEqual([]);
    });
  });
});
