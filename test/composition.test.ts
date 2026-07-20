import { describe, it, expect } from "vitest";
import { resolveImports, CompositionError } from "../src/composition";
import type { PipelineConfig } from "../src/types";

const baseModelDefaults = {
  planning: "claude-opus-4-6",
  execution: "claude-sonnet-4-6",
  classification: "claude-haiku-4-5-20251001",
};
const baseBudget = { max_tokens: 100000, max_duration_ms: 60000, max_retries: 3 };

const SECURITY_BASE_YAML = `
name: security-base
version: 1
description: Reusable security review block
model_defaults:
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  classification: claude-haiku-4-5-20251001
agents:
  - id: scanner
    role: Run security scans
    model: execution
    tools: []
    memory: { max_tokens: 4000 }
  - id: triage
    role: Triage findings
    model: planning
    tools: []
    memory: { max_tokens: 8000 }
pipeline:
  - step: scan
    agent: scanner
  - step: triage
    agent: triage
    inputs: [scanner]
recovery: {}
budget:
  max_tokens: 50000
  max_duration_ms: 60000
  max_retries: 2
`;

const GUARDED_BASE_YAML = `
name: guarded-base
version: 1
description: Reusable block whose triage step is guarded
model_defaults:
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  classification: claude-haiku-4-5-20251001
agents:
  - id: scanner
    role: Run scans
    model: execution
    tools: []
    memory: { max_tokens: 4000 }
  - id: triage
    role: Triage findings
    model: planning
    tools: []
    memory: { max_tokens: 8000 }
pipeline:
  - step: scan
    agent: scanner
  - step: triage
    agent: triage
    inputs: [scanner]
    when: agent.scanner.completed
recovery: {}
budget:
  max_tokens: 50000
  max_duration_ms: 60000
  max_retries: 2
`;

const NESTED_IMPORT_YAML = `
name: nested
version: 1
description: Has its own import
model_defaults:
  planning: a
  execution: b
  classification: c
agents:
  - id: x
    role: x
    model: execution
    tools: []
    memory: { max_tokens: 1000 }
pipeline:
  - step: deeper
    import: security-base
recovery: {}
budget:
  max_tokens: 1000
  max_duration_ms: 1000
  max_retries: 1
`;

function lookupOf(map: Record<string, string>) {
  return async (name: string) => map[name] ?? null;
}

function parentWithImport(): PipelineConfig {
  return {
    name: "parent",
    version: 1,
    description: "uses imports",
    model_defaults: baseModelDefaults,
    agents: [
      {
        id: "synthesizer",
        role: "Merge findings",
        model: "execution",
        tools: [],
        memory: { max_tokens: 4000 },
      },
    ],
    pipeline: [
      { step: "review", import: "security-base" },
      { step: "synth", agent: "synthesizer", inputs: ["review__triage"] },
    ],
    recovery: {},
    budget: baseBudget,
  };
}

describe("composition.resolveImports", () => {
  it("inlines imported steps with prefix", async () => {
    const out = await resolveImports(
      parentWithImport(),
      lookupOf({ "security-base": SECURITY_BASE_YAML })
    );
    const stepNames = out.pipeline.map((s) => s.step);
    expect(stepNames).toContain("review__scan");
    expect(stepNames).toContain("review__triage");
    expect(stepNames).toContain("synth");
  });

  it("prefixes imported agents", async () => {
    const out = await resolveImports(
      parentWithImport(),
      lookupOf({ "security-base": SECURITY_BASE_YAML })
    );
    const ids = out.agents.map((a) => a.id).sort();
    expect(ids).toContain("review__scanner");
    expect(ids).toContain("review__triage");
    expect(ids).toContain("synthesizer");
  });

  it("rewrites step.agent and step.inputs to prefixed agent ids", async () => {
    const out = await resolveImports(
      parentWithImport(),
      lookupOf({ "security-base": SECURITY_BASE_YAML })
    );
    const triageStep = out.pipeline.find((s) => s.step === "review__triage")!;
    expect(triageStep.agent).toBe("review__triage");
    expect(triageStep.inputs).toEqual(["review__scanner"]);
  });

  it("remaps agent refs inside an imported step's when: guard", async () => {
    const cfg = parentWithImport();
    cfg.pipeline = [{ step: "review", import: "guarded-base" }];
    const out = await resolveImports(cfg, lookupOf({ "guarded-base": GUARDED_BASE_YAML }));
    const triage = out.pipeline.find((s) => s.step === "review__triage")!;
    expect(triage.when).toBe("agent.review__scanner.completed");
  });

  it("preserves non-import steps unchanged", async () => {
    const out = await resolveImports(
      parentWithImport(),
      lookupOf({ "security-base": SECURITY_BASE_YAML })
    );
    const synth = out.pipeline.find((s) => s.step === "synth")!;
    expect(synth.agent).toBe("synthesizer");
    expect(synth.inputs).toEqual(["review__triage"]);
  });

  it("throws on missing import", async () => {
    await expect(
      resolveImports(parentWithImport(), lookupOf({}))
    ).rejects.toThrow(CompositionError);
  });

  it("rejects self-import (cycle)", async () => {
    const cfg = parentWithImport();
    cfg.pipeline = [{ step: "loop", import: "parent" }];
    await expect(
      resolveImports(cfg, lookupOf({}))
    ).rejects.toThrow(/cannot import itself/);
  });

  it("rejects nested imports (one-level rule)", async () => {
    const cfg = parentWithImport();
    cfg.pipeline = [{ step: "review", import: "nested" }];
    await expect(
      resolveImports(
        cfg,
        lookupOf({
          nested: NESTED_IMPORT_YAML,
          "security-base": SECURITY_BASE_YAML,
        })
      )
    ).rejects.toThrow(/one level deep/);
  });

  it("returns the parent unchanged when no imports", async () => {
    const cfg = parentWithImport();
    cfg.pipeline = [{ step: "alone", agent: "synthesizer" }];
    const out = await resolveImports(cfg, lookupOf({}));
    expect(out.pipeline).toEqual(cfg.pipeline);
    expect(out.agents).toEqual(cfg.agents);
  });

  it("throws on a step-name collision after import (CFEAT-07)", async () => {
    const cfg = parentWithImport();
    cfg.pipeline = [
      { step: "review__scan", agent: "synthesizer" },
      { step: "review", import: "guarded-base" },
    ];
    await expect(
      resolveImports(cfg, lookupOf({ "guarded-base": GUARDED_BASE_YAML }))
    ).rejects.toThrow(/step name collision/);
  });
});
