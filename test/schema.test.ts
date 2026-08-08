import { describe, it, expect } from "vitest";
import { parsePipelineYaml, validatePipelineConfig, RunRequestSchema } from "../src/schema";

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
  default:
    max: 2
    backoff: exponential
  fallback:
    skip_failed_agent: true
  escalation:
    channel: notification

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
recovery: {}
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
  describe("agent id charset (SECURITY-04)", () => {
    const yamlWithId = (id: string) => `
name: t
version: 1
description: t
model_defaults:
  planning: a
  execution: b
  classification: c
agents:
  - id: "${id}"
    role: r
    model: execution
    tools: []
    memory:
      max_tokens: 100
pipeline:
  - step: run
    agent: "${id}"
recovery: {}
budget:
  max_tokens: 1
  max_duration_ms: 1
  max_retries: 0
`;

    it("rejects an agent id containing a slash", () => {
      const result = parsePipelineYaml(yamlWithId("bad/id"));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.join("; ")).toContain("agents.0.id");
      }
    });

    it("rejects a dots-only agent id", () => {
      const result = parsePipelineYaml(yamlWithId(".."));
      expect(result.success).toBe(false);
    });

    it("accepts ids with dots, hyphens, and underscores", () => {
      const result = parsePipelineYaml(yamlWithId("agent.v2_x-1"));
      expect(result.success).toBe(true);
    });

    it("validatePipelineConfig flags unsafe ids that bypass the parser (composed ids)", () => {
      const parsed = parsePipelineYaml(yamlWithId("solo"));
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      parsed.data.agents.push({
        id: "../evil",
        role: "r",
        model: "execution",
        tools: [],
        memory: { max_tokens: 100 },
      });
      const errors = validatePipelineConfig(parsed.data);
      expect(errors.some((e) => e.includes("unsafe characters"))).toBe(true);
    });
  });

  describe("YAML alias cap (SECURITY-05)", () => {
    it("rejects an alias-expansion bomb", () => {
      const bomb = `
a: &a ["x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c]
e: [*d,*d,*d,*d,*d,*d,*d,*d]
`;
      const result = parsePipelineYaml(bomb);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0]).toContain("YAML parse error");
      }
    });

    it("still accepts benign anchor reuse", () => {
      const yamlWithAnchor = `
name: t
version: 1
description: t
model_defaults:
  planning: &m claude-x
  execution: *m
  classification: c
agents:
  - id: solo
    role: r
    model: execution
    tools: []
    memory:
      max_tokens: 100
pipeline:
  - step: run
    agent: solo
recovery: {}
budget:
  max_tokens: 1
  max_duration_ms: 1
  max_retries: 0
`;
      const result = parsePipelineYaml(yamlWithAnchor);
      expect(result.success).toBe(true);
    });
  });

  describe("RunRequestSchema (SECURITY-05)", () => {
    it("accepts a valid run request (input optional)", () => {
      expect(RunRequestSchema.safeParse({ pipeline: "p", input: { x: 1 } }).success).toBe(true);
      expect(RunRequestSchema.safeParse({ pipeline: "p" }).success).toBe(true);
    });

    it("rejects missing or non-string pipeline", () => {
      expect(RunRequestSchema.safeParse({}).success).toBe(false);
      expect(RunRequestSchema.safeParse({ pipeline: 42 }).success).toBe(false);
    });
  });
});
