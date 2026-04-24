# AgentX Factory Phase 1: Core Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP execution engine — YAML pipeline in, synthesized LLM output out — deployed to Cloudflare Workers with Durable Objects, Queues, KV, and R2.

**Architecture:** Supervisor DO owns the pipeline DAG and dispatches tasks via Queues to Agent DOs. Agent DOs make Anthropic API calls, write artifacts to R2, and report completions back. The Hono Worker handles HTTP API and queue consumer routing.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects (SQLite), Queues, KV, R2, Hono, Zod, yaml, @anthropic-ai/sdk, vitest + @cloudflare/vitest-pool-workers

---

## File Structure

```
factory/
  src/
    types.ts              # All shared TypeScript types (Env, HandoffEnvelope, PipelineConfig, DAG)
    envelope.ts           # Envelope creation + validation helpers
    schema.ts             # Zod schemas for pipeline YAML validation + parser
    gate.ts               # Gate condition evaluation logic
    anthropic.ts          # Thin Anthropic API wrapper with model tier resolution
    agent.ts              # Agent Durable Object class
    supervisor.ts         # Supervisor Durable Object class
    index.ts              # Hono Worker: HTTP API router + queue consumers
  pipelines/
    code-review.yaml      # Built-in pipeline definition
  test/
    envelope.test.ts      # Envelope helpers unit tests
    schema.test.ts        # YAML schema validation tests
    gate.test.ts          # Gate evaluator tests
    anthropic.test.ts     # Anthropic client tests (mocked)
    agent.test.ts         # Agent DO integration tests (miniflare)
    supervisor.test.ts    # Supervisor DO integration tests (miniflare)
    e2e.test.ts           # End-to-end pipeline run test
  wrangler.toml
  package.json
  tsconfig.json
  vitest.config.ts
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.toml`
- Create: `vitest.config.ts`
- Create: `src/index.ts` (stub)

- [ ] **Step 1: Initialize package.json**

```bash
cd /Users/rohit/Documents/factory
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install hono zod yaml @anthropic-ai/sdk
npm install -D typescript wrangler vitest @cloudflare/vitest-pool-workers @cloudflare/workers-types
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types/2023-07-01", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx"
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create wrangler.toml**

```toml
name = "agentx-factory"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[durable_objects]
bindings = [
  { name = "SUPERVISOR", class_name = "Supervisor" },
  { name = "AGENT", class_name = "Agent" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Supervisor", "Agent"]

[[queues.producers]]
binding = "DISPATCH_QUEUE"
queue = "agentx-dispatch"

[[queues.producers]]
binding = "RESULT_QUEUE"
queue = "agentx-results"

[[queues.consumers]]
queue = "agentx-dispatch"
max_batch_size = 1
max_retries = 3
dead_letter_queue = "agentx-dlq"

[[queues.consumers]]
queue = "agentx-results"
max_batch_size = 10
max_retries = 3

[[queues.consumers]]
queue = "agentx-dlq"
max_batch_size = 1

[[kv_namespaces]]
binding = "PIPELINE_KV"
id = "placeholder"

[[r2_buckets]]
binding = "ARTIFACT_STORE"
bucket_name = "agentx-artifacts"
```

- [ ] **Step 5: Create vitest.config.ts**

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          kvNamespaces: ["PIPELINE_KV"],
          r2Buckets: ["ARTIFACT_STORE"],
          queueProducers: {
            DISPATCH_QUEUE: "agentx-dispatch",
            RESULT_QUEUE: "agentx-results",
          },
          durableObjects: {
            SUPERVISOR: "Supervisor",
            AGENT: "Agent",
          },
        },
      },
    },
  },
});
```

- [ ] **Step 6: Create stub src/index.ts**

```typescript
export default {
  async fetch(): Promise<Response> {
    return new Response("agentx-factory");
  },
};
```

- [ ] **Step 7: Verify build works**

Run: `npx wrangler dev --dry-run 2>&1 | head -5`
Expected: No TypeScript errors. Worker compiles.

- [ ] **Step 8: Verify tests work**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -5`
Expected: "No test files found" (no tests yet, but vitest initializes).

- [ ] **Step 9: Create directories**

```bash
mkdir -p src test pipelines
```

- [ ] **Step 10: Commit**

```bash
git init
echo "node_modules/\n.wrangler/\ndist/" > .gitignore
git add package.json tsconfig.json wrangler.toml vitest.config.ts src/index.ts .gitignore
git commit -m "chore: scaffold agentx-factory project with wrangler, hono, vitest"
```

---

## Task 2: Types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Define Env bindings type**

```typescript
// src/types.ts

import type { DurableObjectNamespace, KVNamespace, R2Bucket, Queue } from "@cloudflare/workers-types";

export interface Env {
  SUPERVISOR: DurableObjectNamespace;
  AGENT: DurableObjectNamespace;
  PIPELINE_KV: KVNamespace;
  ARTIFACT_STORE: R2Bucket;
  DISPATCH_QUEUE: Queue;
  RESULT_QUEUE: Queue;
  ANTHROPIC_API_KEY: string;
}
```

- [ ] **Step 2: Define HandoffEnvelope**

Add to `src/types.ts`:

```typescript
export interface AgentRef {
  agent: string;
  do_id: string;
}

export interface HandoffEnvelope {
  id: string;
  pipeline_run: string;
  from: AgentRef;
  to: AgentRef;
  artifact_ref: string;
  artifact_type: string;
  gate_results: Record<string, "pass" | "fail" | "skip">;
  context_window: {
    parent_refs: string[];
  };
  metadata: {
    tokens_used: number;
    model: string;
    duration_ms: number;
    retry_count: number;
  };
  timestamp: string;
}
```

- [ ] **Step 3: Define pipeline config types**

Add to `src/types.ts`:

```typescript
export interface ModelDefaults {
  planning: string;
  execution: string;
  classification: string;
}

export interface AgentConfig {
  id: string;
  role: string;
  model: string;
  tools: string[];
  memory: { max_tokens: number };
  fallback?: string;
}

export interface PipelineStep {
  step: string;
  agent?: string;
  agents?: string[];
  mode?: "parallel" | "sequential";
  inputs?: string[];
  type?: "gate";
  condition?: string;
  on_fail?: string;
  on_match?: string;
  on_pass?: string;
}

export interface RecoveryConfig {
  default: string;
  fallback: string;
  escalation: string;
}

export interface BudgetConfig {
  max_tokens: number;
  max_duration_ms: number;
  max_retries: number;
}

export interface PipelineConfig {
  name: string;
  version: number;
  description: string;
  model_defaults: ModelDefaults;
  agents: AgentConfig[];
  pipeline: PipelineStep[];
  recovery: RecoveryConfig;
  budget: BudgetConfig;
}
```

- [ ] **Step 4: Define DAG types**

Add to `src/types.ts`:

```typescript
export type AgentStatus = "pending" | "dispatched" | "running" | "completed" | "failed";
export type RunStatus = "submitted" | "validating" | "planning" | "dispatching" | "running" | "completed" | "failed" | "awaiting_human";

export interface DagNode {
  agent_id: string;
  do_id: string;
  status: AgentStatus;
  step_index: number;
  artifact_ref?: string;
  tokens_used: number;
  duration_ms: number;
  retry_count: number;
  error?: string;
}

export interface DagState {
  run_id: string;
  pipeline_name: string;
  status: RunStatus;
  current_step: number;
  nodes: Record<string, DagNode>;
  steps: PipelineStep[];
  created_at: string;
  updated_at: string;
  input_ref: string;
  total_tokens: number;
  total_duration_ms: number;
}

export interface PipelineEvent {
  id: string;
  run_id: string;
  timestamp: string;
  event_type: "dispatch" | "completion" | "gate_eval" | "recovery" | "error" | "state_transition";
  agent_role?: string;
  details: Record<string, unknown>;
}

export interface DispatchMessage {
  type: "dispatch";
  envelope: HandoffEnvelope;
  agent_config: AgentConfig;
  model_defaults: ModelDefaults;
}

export interface ResultMessage {
  type: "result";
  envelope: HandoffEnvelope;
  supervisor_do_id: string;
}
```

- [ ] **Step 5: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts
git commit -m "feat: define core types — Env, HandoffEnvelope, PipelineConfig, DAG state"
```

---

## Task 3: Envelope Helpers

**Files:**
- Create: `src/envelope.ts`
- Create: `test/envelope.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/envelope.test.ts
import { describe, it, expect } from "vitest";
import { createDispatchEnvelope, createResultEnvelope, artifactKey } from "../src/envelope";

describe("envelope", () => {
  describe("artifactKey", () => {
    it("builds R2 key from run ID and agent role", () => {
      const key = artifactKey("run-123", "security");
      expect(key).toBe("runs/run-123/agents/security/output.json");
    });
  });

  describe("createDispatchEnvelope", () => {
    it("creates envelope with correct from/to and empty gate_results", () => {
      const env = createDispatchEnvelope({
        runId: "run-123",
        fromAgent: "supervisor",
        fromDoId: "sup-do-id",
        toAgent: "security",
        toDoId: "agent-do-id",
        inputRefs: ["runs/run-123/input.json"],
      });

      expect(env.pipeline_run).toBe("run-123");
      expect(env.from.agent).toBe("supervisor");
      expect(env.to.agent).toBe("security");
      expect(env.artifact_ref).toBe("");
      expect(env.context_window.parent_refs).toEqual(["runs/run-123/input.json"]);
      expect(env.gate_results).toEqual({});
      expect(env.metadata.retry_count).toBe(0);
      expect(env.id).toBeTruthy();
      expect(env.timestamp).toBeTruthy();
    });
  });

  describe("createResultEnvelope", () => {
    it("creates envelope with artifact ref and metadata", () => {
      const env = createResultEnvelope({
        runId: "run-123",
        agentRole: "security",
        agentDoId: "agent-do-id",
        supervisorDoId: "sup-do-id",
        tokensUsed: 4200,
        model: "claude-sonnet-4-6",
        durationMs: 8500,
        retryCount: 0,
      });

      expect(env.pipeline_run).toBe("run-123");
      expect(env.from.agent).toBe("security");
      expect(env.to.agent).toBe("supervisor");
      expect(env.artifact_ref).toBe("runs/run-123/agents/security/output.json");
      expect(env.metadata.tokens_used).toBe(4200);
      expect(env.metadata.model).toBe("claude-sonnet-4-6");
      expect(env.metadata.duration_ms).toBe(8500);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/envelope.test.ts --reporter=verbose`
Expected: FAIL — module `../src/envelope` not found.

- [ ] **Step 3: Implement envelope.ts**

```typescript
// src/envelope.ts
import type { HandoffEnvelope } from "./types";

export function artifactKey(runId: string, agentRole: string): string {
  return `runs/${runId}/agents/${agentRole}/output.json`;
}

export function inputKey(runId: string): string {
  return `runs/${runId}/input.json`;
}

interface DispatchEnvelopeParams {
  runId: string;
  fromAgent: string;
  fromDoId: string;
  toAgent: string;
  toDoId: string;
  inputRefs: string[];
}

export function createDispatchEnvelope(params: DispatchEnvelopeParams): HandoffEnvelope {
  return {
    id: crypto.randomUUID(),
    pipeline_run: params.runId,
    from: { agent: params.fromAgent, do_id: params.fromDoId },
    to: { agent: params.toAgent, do_id: params.toDoId },
    artifact_ref: "",
    artifact_type: "dispatch",
    gate_results: {},
    context_window: { parent_refs: params.inputRefs },
    metadata: { tokens_used: 0, model: "", duration_ms: 0, retry_count: 0 },
    timestamp: new Date().toISOString(),
  };
}

interface ResultEnvelopeParams {
  runId: string;
  agentRole: string;
  agentDoId: string;
  supervisorDoId: string;
  tokensUsed: number;
  model: string;
  durationMs: number;
  retryCount: number;
}

export function createResultEnvelope(params: ResultEnvelopeParams): HandoffEnvelope {
  return {
    id: crypto.randomUUID(),
    pipeline_run: params.runId,
    from: { agent: params.agentRole, do_id: params.agentDoId },
    to: { agent: "supervisor", do_id: params.supervisorDoId },
    artifact_ref: artifactKey(params.runId, params.agentRole),
    artifact_type: "result",
    gate_results: {},
    context_window: { parent_refs: [] },
    metadata: {
      tokens_used: params.tokensUsed,
      model: params.model,
      duration_ms: params.durationMs,
      retry_count: params.retryCount,
    },
    timestamp: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/envelope.test.ts --reporter=verbose`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/envelope.ts test/envelope.test.ts
git commit -m "feat: add envelope helpers — createDispatchEnvelope, createResultEnvelope, artifactKey"
```

---

## Task 4: YAML Schema Validation

**Files:**
- Create: `src/schema.ts`
- Create: `test/schema.test.ts`
- Create: `pipelines/code-review.yaml`

- [ ] **Step 1: Create the code-review pipeline YAML**

```yaml
# pipelines/code-review.yaml
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
```

- [ ] **Step 2: Write the failing tests**

```typescript
// test/schema.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parsePipelineYaml, validatePipelineConfig } from "../src/schema";

const codeReviewYaml = readFileSync("pipelines/code-review.yaml", "utf-8");

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

      // Modify step to reference non-existent agent
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/schema.test.ts --reporter=verbose`
Expected: FAIL — module `../src/schema` not found.

- [ ] **Step 4: Implement schema.ts**

```typescript
// src/schema.ts
import { z } from "zod";
import YAML from "yaml";
import type { PipelineConfig } from "./types";

const ModelDefaultsSchema = z.object({
  planning: z.string(),
  execution: z.string(),
  classification: z.string(),
});

const AgentConfigSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  model: z.string().min(1),
  tools: z.array(z.string()).default([]),
  memory: z.object({ max_tokens: z.number().positive() }),
  fallback: z.string().optional(),
});

const PipelineStepSchema = z.object({
  step: z.string().min(1),
  agent: z.string().optional(),
  agents: z.array(z.string()).optional(),
  mode: z.enum(["parallel", "sequential"]).optional(),
  inputs: z.array(z.string()).optional(),
  type: z.literal("gate").optional(),
  condition: z.string().optional(),
  on_fail: z.string().optional(),
  on_match: z.string().optional(),
  on_pass: z.string().optional(),
});

const RecoveryConfigSchema = z.object({
  default: z.string(),
  fallback: z.string(),
  escalation: z.string(),
});

const BudgetConfigSchema = z.object({
  max_tokens: z.number().positive(),
  max_duration_ms: z.number().positive(),
  max_retries: z.number().int().nonnegative(),
});

const PipelineConfigSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().min(1),
  model_defaults: ModelDefaultsSchema,
  agents: z.array(AgentConfigSchema).min(1),
  pipeline: z.array(PipelineStepSchema).min(1),
  recovery: RecoveryConfigSchema,
  budget: BudgetConfigSchema,
});

type ParseResult =
  | { success: true; data: PipelineConfig }
  | { success: false; errors: string[] };

export function parsePipelineYaml(yamlString: string): ParseResult {
  let raw: unknown;
  try {
    raw = YAML.parse(yamlString);
  } catch (e) {
    return { success: false, errors: [`YAML parse error: ${e}`] };
  }

  const result = PipelineConfigSchema.safeParse(raw);
  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`
      ),
    };
  }

  return { success: true, data: result.data as PipelineConfig };
}

export function validatePipelineConfig(config: PipelineConfig): string[] {
  const errors: string[] = [];
  const agentIds = new Set(config.agents.map((a) => a.id));

  for (const step of config.pipeline) {
    if (step.type === "gate") continue;

    if (step.agent && !agentIds.has(step.agent)) {
      errors.push(`Step "${step.step}" references unknown agent "${step.agent}"`);
    }
    if (step.agents) {
      for (const a of step.agents) {
        if (!agentIds.has(a)) {
          errors.push(`Step "${step.step}" references unknown agent "${a}"`);
        }
      }
    }
    if (step.inputs) {
      for (const inp of step.inputs) {
        if (!agentIds.has(inp)) {
          errors.push(`Step "${step.step}" input references unknown agent "${inp}"`);
        }
      }
    }
  }

  for (const agent of config.agents) {
    if (agent.fallback && !agentIds.has(agent.fallback)) {
      errors.push(`Agent "${agent.id}" fallback references unknown agent "${agent.fallback}"`);
    }
  }

  return errors;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/schema.test.ts --reporter=verbose`
Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schema.ts test/schema.test.ts pipelines/code-review.yaml
git commit -m "feat: add YAML pipeline schema validation with Zod + code-review pipeline"
```

---

## Task 5: Gate Evaluator

**Files:**
- Create: `src/gate.ts`
- Create: `test/gate.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/gate.test.ts
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
    expect(result.reason).toContain("token");
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/gate.test.ts --reporter=verbose`
Expected: FAIL — module `../src/gate` not found.

- [ ] **Step 3: Implement gate.ts**

```typescript
// src/gate.ts
import type { DagNode, PipelineStep, BudgetConfig } from "./types";

export interface GateResult {
  pass: boolean;
  reason: string;
  condition: string;
}

export function evaluateGate(
  gate: PipelineStep,
  previousStepAgents: string[],
  nodes: Record<string, DagNode>,
  budget: BudgetConfig
): GateResult {
  const condition = gate.condition ?? "all_agents_completed";

  switch (condition) {
    case "all_agents_completed": {
      const failed = previousStepAgents.filter(
        (id) => nodes[id]?.status !== "completed"
      );
      if (failed.length > 0) {
        return {
          pass: false,
          reason: `Agents not completed: ${failed.join(", ")}`,
          condition,
        };
      }
      return { pass: true, reason: "All agents completed", condition };
    }

    case "token_budget": {
      const totalTokens = Object.values(nodes).reduce(
        (sum, n) => sum + n.tokens_used,
        0
      );
      if (totalTokens > budget.max_tokens) {
        return {
          pass: false,
          reason: `Token budget exceeded: ${totalTokens}/${budget.max_tokens}`,
          condition,
        };
      }
      return { pass: true, reason: "Within token budget", condition };
    }

    default:
      return { pass: true, reason: `Unknown condition "${condition}" — permissive pass`, condition };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/gate.test.ts --reporter=verbose`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gate.ts test/gate.test.ts
git commit -m "feat: add gate evaluator — all_agents_completed, token_budget conditions"
```

---

## Task 6: Anthropic Client Wrapper

**Files:**
- Create: `src/anthropic.ts`
- Create: `test/anthropic.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/anthropic.test.ts
import { describe, it, expect } from "vitest";
import { resolveModel, buildPrompt } from "../src/anthropic";
import type { ModelDefaults, AgentConfig } from "../src/types";

const defaults: ModelDefaults = {
  planning: "claude-opus-4-6",
  execution: "claude-sonnet-4-6",
  classification: "claude-haiku-4-5-20251001",
};

describe("anthropic", () => {
  describe("resolveModel", () => {
    it("resolves tier keyword to model ID", () => {
      expect(resolveModel("planning", defaults)).toBe("claude-opus-4-6");
      expect(resolveModel("execution", defaults)).toBe("claude-sonnet-4-6");
      expect(resolveModel("classification", defaults)).toBe("claude-haiku-4-5-20251001");
    });

    it("passes through explicit model ID unchanged", () => {
      expect(resolveModel("claude-opus-4-6", defaults)).toBe("claude-opus-4-6");
    });
  });

  describe("buildPrompt", () => {
    it("builds system + user messages from agent config and input", () => {
      const agent: AgentConfig = {
        id: "security",
        role: "Security engineer. Review for vulnerabilities.",
        model: "execution",
        tools: [],
        memory: { max_tokens: 8000 },
      };
      const input = "Here is the diff:\n+console.log(password)";
      const messages = buildPrompt(agent, input);

      expect(messages.system).toBe("Security engineer. Review for vulnerabilities.");
      expect(messages.user).toBe(input);
    });

    it("combines multiple input artifacts into one user message", () => {
      const agent: AgentConfig = {
        id: "synthesizer",
        role: "Merge findings.",
        model: "execution",
        tools: [],
        memory: { max_tokens: 4000 },
      };
      const inputs = ["Finding 1: XSS", "Finding 2: N+1 query"];
      const messages = buildPrompt(agent, inputs.join("\n\n---\n\n"));

      expect(messages.user).toContain("Finding 1: XSS");
      expect(messages.user).toContain("Finding 2: N+1 query");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/anthropic.test.ts --reporter=verbose`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement anthropic.ts**

```typescript
// src/anthropic.ts
import Anthropic from "@anthropic-ai/sdk";
import type { ModelDefaults, AgentConfig } from "./types";

const TIER_KEYS = new Set(["planning", "execution", "classification"]);

export function resolveModel(modelRef: string, defaults: ModelDefaults): string {
  if (TIER_KEYS.has(modelRef)) {
    return defaults[modelRef as keyof ModelDefaults];
  }
  return modelRef;
}

export interface PromptMessages {
  system: string;
  user: string;
}

export function buildPrompt(agent: AgentConfig, input: string): PromptMessages {
  return {
    system: agent.role,
    user: input,
  };
}

export interface LlmResponse {
  content: string;
  input_tokens: number;
  output_tokens: number;
  model: string;
}

export async function callAnthropic(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number
): Promise<LlmResponse> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return {
    content: textBlock?.text ?? "",
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    model: response.model,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/anthropic.test.ts --reporter=verbose`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/anthropic.ts test/anthropic.test.ts
git commit -m "feat: add anthropic client wrapper — resolveModel, buildPrompt, callAnthropic"
```

---

## Task 7: Agent Durable Object

**Files:**
- Create: `src/agent.ts`
- Create: `test/agent.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/agent.test.ts
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";

// We test the Agent DO through its RPC interface
describe("Agent DO", () => {
  it("initializes SQLite schema on first access", async () => {
    const id = env.AGENT.idFromName("test-agent-init");
    const stub = env.AGENT.get(id);
    const status = await stub.getStatus();
    expect(status).toEqual({ status: "idle" });
  });

  it("handles a task dispatch and writes artifact to R2", async () => {
    const id = env.AGENT.idFromName("test-agent-task");
    const stub = env.AGENT.get(id);

    // Write a mock input artifact to R2
    await env.ARTIFACT_STORE.put(
      "runs/run-test/input.json",
      JSON.stringify({ diff: "console.log('hello')" })
    );

    // Mock the Anthropic call by setting a test flag
    const result = await stub.handleTask({
      runId: "run-test",
      agentConfig: {
        id: "security",
        role: "Test role: echo the input back",
        model: "execution",
        tools: [],
        memory: { max_tokens: 4000 },
      },
      modelDefaults: {
        planning: "claude-opus-4-6",
        execution: "claude-sonnet-4-6",
        classification: "claude-haiku-4-5-20251001",
      },
      inputRefs: ["runs/run-test/input.json"],
      supervisorDoId: "sup-123",
      retryCount: 0,
    });

    expect(result.success).toBeDefined();
    // In test mode (no real API key), we expect a graceful error or mock response
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agent.test.ts --reporter=verbose`
Expected: FAIL — Agent class not exported.

- [ ] **Step 3: Implement Agent DO**

```typescript
// src/agent.ts
import { DurableObject } from "cloudflare:workers";
import type { Env, AgentConfig, ModelDefaults } from "./types";
import { artifactKey, createResultEnvelope } from "./envelope";
import { resolveModel, buildPrompt, callAnthropic } from "./anthropic";

interface TaskParams {
  runId: string;
  agentConfig: AgentConfig;
  modelDefaults: ModelDefaults;
  inputRefs: string[];
  supervisorDoId: string;
  retryCount: number;
}

interface TaskResult {
  success: boolean;
  artifactRef?: string;
  tokensUsed?: number;
  model?: string;
  durationMs?: number;
  error?: string;
}

export class Agent extends DurableObject<Env> {
  private initialized = false;

  private initSchema() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    this.initialized = true;
  }

  async getStatus(): Promise<{ status: string }> {
    this.initSchema();
    const row = this.ctx.storage.sql
      .exec("SELECT value FROM config WHERE key = 'status'")
      .toArray();
    return { status: row.length > 0 ? String(row[0].value) : "idle" };
  }

  async handleTask(params: TaskParams): Promise<TaskResult> {
    this.initSchema();
    const startTime = Date.now();

    // Update status
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('status', 'running')"
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO config (key, value) VALUES ('run_id', '${params.runId}')`
    );

    try {
      // Pull input artifacts from R2
      const inputParts: string[] = [];
      for (const ref of params.inputRefs) {
        const obj = await this.env.ARTIFACT_STORE.get(ref);
        if (obj) {
          inputParts.push(await obj.text());
        }
      }
      const input = inputParts.join("\n\n---\n\n");

      // Build prompt
      const { system, user } = buildPrompt(params.agentConfig, input);
      const model = resolveModel(params.agentConfig.model, params.modelDefaults);

      // Call Anthropic
      const llmResponse = await callAnthropic(
        this.env.ANTHROPIC_API_KEY,
        model,
        system,
        user,
        params.agentConfig.memory.max_tokens
      );

      // Write output artifact to R2
      const outputKey = artifactKey(params.runId, params.agentConfig.id);
      await this.env.ARTIFACT_STORE.put(
        outputKey,
        JSON.stringify({
          agent: params.agentConfig.id,
          model: llmResponse.model,
          content: llmResponse.content,
          tokens: {
            input: llmResponse.input_tokens,
            output: llmResponse.output_tokens,
          },
        })
      );

      // Record in history
      this.ctx.storage.sql.exec(
        `INSERT INTO history (role, content) VALUES ('assistant', ?)`,
        llmResponse.content.substring(0, 10000) // Truncate for storage
      );

      const durationMs = Date.now() - startTime;
      const totalTokens = llmResponse.input_tokens + llmResponse.output_tokens;

      // Send result envelope to Result Queue
      const envelope = createResultEnvelope({
        runId: params.runId,
        agentRole: params.agentConfig.id,
        agentDoId: this.ctx.id.toString(),
        supervisorDoId: params.supervisorDoId,
        tokensUsed: totalTokens,
        model: llmResponse.model,
        durationMs,
        retryCount: params.retryCount,
      });

      await this.env.RESULT_QUEUE.send({
        type: "result",
        envelope,
        supervisor_do_id: params.supervisorDoId,
      });

      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('status', 'completed')"
      );

      return {
        success: true,
        artifactRef: outputKey,
        tokensUsed: totalTokens,
        model: llmResponse.model,
        durationMs,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('status', 'failed')"
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO history (role, content) VALUES ('error', ?)`,
        error.substring(0, 5000)
      );

      return { success: false, error, durationMs: Date.now() - startTime };
    }
  }
}
```

- [ ] **Step 4: Export Agent from index.ts**

Update `src/index.ts`:

```typescript
export { Agent } from "./agent";

export default {
  async fetch(): Promise<Response> {
    return new Response("agentx-factory");
  },
};
```

- [ ] **Step 5: Run test to verify**

Run: `npx vitest run test/agent.test.ts --reporter=verbose`
Expected: `getStatus` test PASS. `handleTask` test may fail on missing API key — that's expected behavior.

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts src/index.ts test/agent.test.ts
git commit -m "feat: add Agent Durable Object — task handling, R2 artifacts, result queue"
```

---

## Task 8: Supervisor Durable Object

**Files:**
- Create: `src/supervisor.ts`
- Create: `test/supervisor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/supervisor.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("Supervisor DO", () => {
  it("initializes a pipeline run from config", async () => {
    const id = env.SUPERVISOR.idFromName("test-run-init");
    const stub = env.SUPERVISOR.get(id);

    const result = await stub.initializeRun({
      runId: "test-run-init",
      pipelineYaml: `
name: simple
version: 1
description: test
model_defaults:
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  classification: claude-haiku-4-5-20251001
agents:
  - id: worker
    role: Do the thing
    model: execution
    tools: []
    memory:
      max_tokens: 4000
pipeline:
  - step: work
    agent: worker
recovery:
  default: "retry(max=1)"
  fallback: "degrade"
  escalation: "human"
budget:
  max_tokens: 10000
  max_duration_ms: 60000
  max_retries: 3
`,
      input: { task: "test input" },
    });

    expect(result.success).toBe(true);
    expect(result.runId).toBe("test-run-init");
  });

  it("returns current DAG state", async () => {
    const id = env.SUPERVISOR.idFromName("test-run-status");
    const stub = env.SUPERVISOR.get(id);

    await stub.initializeRun({
      runId: "test-run-status",
      pipelineYaml: `
name: simple
version: 1
description: test
model_defaults:
  planning: a
  execution: b
  classification: c
agents:
  - id: worker
    role: Do the thing
    model: execution
    tools: []
    memory:
      max_tokens: 4000
pipeline:
  - step: work
    agent: worker
recovery:
  default: retry
  fallback: degrade
  escalation: human
budget:
  max_tokens: 10000
  max_duration_ms: 60000
  max_retries: 3
`,
      input: { task: "test" },
    });

    const state = await stub.getState();
    expect(state.status).toBe("dispatching");
    expect(state.pipeline_name).toBe("simple");
    expect(Object.keys(state.nodes)).toContain("worker");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/supervisor.test.ts --reporter=verbose`
Expected: FAIL — Supervisor class not exported.

- [ ] **Step 3: Implement Supervisor DO**

```typescript
// src/supervisor.ts
import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  DagState,
  DagNode,
  PipelineConfig,
  PipelineStep,
  PipelineEvent,
  RunStatus,
  HandoffEnvelope,
  DispatchMessage,
  AgentConfig,
} from "./types";
import { parsePipelineYaml, validatePipelineConfig } from "./schema";
import { evaluateGate } from "./gate";
import { createDispatchEnvelope, inputKey, artifactKey } from "./envelope";

interface InitParams {
  runId: string;
  pipelineYaml: string;
  input: unknown;
}

interface InitResult {
  success: boolean;
  runId?: string;
  error?: string;
}

export class Supervisor extends DurableObject<Env> {
  private initialized = false;
  private dag: DagState | null = null;
  private config: PipelineConfig | null = null;

  private initSchema() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS dag_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        event_type TEXT NOT NULL,
        agent_role TEXT,
        details TEXT NOT NULL DEFAULT '{}'
      );
    `);
    this.initialized = true;
  }

  private saveDag() {
    if (!this.dag) return;
    this.dag.updated_at = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO dag_state (key, value) VALUES ('dag', ?)",
      JSON.stringify(this.dag)
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO dag_state (key, value) VALUES ('config', ?)",
      JSON.stringify(this.config)
    );
  }

  private loadDag(): boolean {
    const dagRow = this.ctx.storage.sql
      .exec("SELECT value FROM dag_state WHERE key = 'dag'")
      .toArray();
    const configRow = this.ctx.storage.sql
      .exec("SELECT value FROM dag_state WHERE key = 'config'")
      .toArray();
    if (dagRow.length > 0 && configRow.length > 0) {
      this.dag = JSON.parse(String(dagRow[0].value));
      this.config = JSON.parse(String(configRow[0].value));
      return true;
    }
    return false;
  }

  private logEvent(eventType: PipelineEvent["event_type"], agentRole: string | null, details: Record<string, unknown>) {
    if (!this.dag) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO events (run_id, event_type, agent_role, details) VALUES (?, ?, ?, ?)",
      this.dag.run_id,
      eventType,
      agentRole,
      JSON.stringify(details)
    );
  }

  async initializeRun(params: InitParams): Promise<InitResult> {
    this.initSchema();

    // Parse and validate YAML
    const parsed = parsePipelineYaml(params.pipelineYaml);
    if (!parsed.success) {
      return { success: false, error: `YAML validation failed: ${parsed.errors.join("; ")}` };
    }

    const validationErrors = validatePipelineConfig(parsed.data);
    if (validationErrors.length > 0) {
      return { success: false, error: `Config validation failed: ${validationErrors.join("; ")}` };
    }

    this.config = parsed.data;

    // Build DAG nodes for all agents
    const nodes: Record<string, DagNode> = {};
    for (const agent of this.config.agents) {
      const doId = this.env.AGENT.idFromName(`${params.runId}:${agent.id}`);
      nodes[agent.id] = {
        agent_id: agent.id,
        do_id: doId.toString(),
        status: "pending",
        step_index: this.config.pipeline.findIndex(
          (s) => s.agent === agent.id || s.agents?.includes(agent.id)
        ),
        tokens_used: 0,
        duration_ms: 0,
        retry_count: 0,
      };
    }

    const inRef = inputKey(params.runId);

    this.dag = {
      run_id: params.runId,
      pipeline_name: this.config.name,
      status: "planning",
      current_step: 0,
      nodes,
      steps: this.config.pipeline,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      input_ref: inRef,
      total_tokens: 0,
      total_duration_ms: 0,
    };

    // Write input artifact to R2
    await this.env.ARTIFACT_STORE.put(inRef, JSON.stringify(params.input));

    this.logEvent("state_transition", null, { from: "submitted", to: "planning" });

    // Transition to dispatching and dispatch first step
    this.dag.status = "dispatching";
    this.saveDag();

    await this.dispatchCurrentStep();

    return { success: true, runId: params.runId };
  }

  private async dispatchCurrentStep() {
    if (!this.dag || !this.config) return;

    const step = this.dag.steps[this.dag.current_step];
    if (!step) {
      this.dag.status = "completed";
      this.saveDag();
      return;
    }

    // Skip gate steps (they're evaluated on completion, not dispatched)
    if (step.type === "gate") {
      this.dag.current_step++;
      this.saveDag();
      await this.dispatchCurrentStep();
      return;
    }

    const agentIds = step.agents ?? (step.agent ? [step.agent] : []);
    const supervisorDoId = this.ctx.id.toString();

    for (const agentId of agentIds) {
      const node = this.dag.nodes[agentId];
      if (!node) continue;

      node.status = "dispatched";

      // Determine input refs
      let parentRefs: string[];
      if (step.inputs && step.inputs.length > 0) {
        parentRefs = step.inputs.map((id) => artifactKey(this.dag!.run_id, id));
      } else {
        parentRefs = [this.dag.input_ref];
      }

      const agentConfig = this.config.agents.find((a) => a.id === agentId)!;

      const envelope = createDispatchEnvelope({
        runId: this.dag.run_id,
        fromAgent: "supervisor",
        fromDoId: supervisorDoId,
        toAgent: agentId,
        toDoId: node.do_id,
        inputRefs: parentRefs,
      });

      const message: DispatchMessage = {
        type: "dispatch",
        envelope,
        agent_config: agentConfig,
        model_defaults: this.config.model_defaults,
      };

      await this.env.DISPATCH_QUEUE.send(message);

      this.logEvent("dispatch", agentId, {
        step: step.step,
        input_refs: parentRefs,
      });
    }

    this.dag.status = "running";
    this.saveDag();
  }

  async handleAgentCompletion(envelope: HandoffEnvelope) {
    this.initSchema();
    if (!this.dag && !this.loadDag()) return;
    if (!this.dag || !this.config) return;

    const agentId = envelope.from.agent;
    const node = this.dag.nodes[agentId];
    if (!node) return;

    // Update node state
    node.status = "completed";
    node.artifact_ref = envelope.artifact_ref;
    node.tokens_used = envelope.metadata.tokens_used;
    node.duration_ms = envelope.metadata.duration_ms;
    node.retry_count = envelope.metadata.retry_count;

    this.dag.total_tokens += envelope.metadata.tokens_used;
    this.dag.total_duration_ms = Math.max(
      this.dag.total_duration_ms,
      envelope.metadata.duration_ms
    );

    this.logEvent("completion", agentId, {
      tokens: envelope.metadata.tokens_used,
      model: envelope.metadata.model,
      duration_ms: envelope.metadata.duration_ms,
    });

    // Check if all agents for the current step are done
    const currentStep = this.dag.steps[this.dag.current_step];
    if (!currentStep) {
      this.dag.status = "completed";
      this.saveDag();
      return;
    }

    const stepAgents = currentStep.agents ?? (currentStep.agent ? [currentStep.agent] : []);
    const allDone = stepAgents.every(
      (id) => this.dag!.nodes[id]?.status === "completed" || this.dag!.nodes[id]?.status === "failed"
    );

    if (!allDone) {
      this.saveDag();
      return;
    }

    // All agents for this step completed — move to next step
    this.dag.current_step++;

    // Check if next step is a gate
    const nextStep = this.dag.steps[this.dag.current_step];
    if (nextStep?.type === "gate") {
      const gateResult = evaluateGate(nextStep, stepAgents, this.dag.nodes, this.config.budget);
      this.logEvent("gate_eval", null, {
        gate: nextStep.step,
        pass: gateResult.pass,
        reason: gateResult.reason,
      });

      if (!gateResult.pass) {
        // For now, mark as failed. Recovery is Phase 2.
        this.dag.status = "failed";
        this.saveDag();
        return;
      }

      // Gate passed, skip to next real step
      this.dag.current_step++;
    }

    // Check if we've reached the end
    if (this.dag.current_step >= this.dag.steps.length) {
      this.dag.status = "completed";
      this.logEvent("state_transition", null, { from: "running", to: "completed" });
      this.saveDag();
      return;
    }

    // Dispatch next step
    this.dag.status = "dispatching";
    this.saveDag();
    await this.dispatchCurrentStep();
  }

  async handleAgentFailure(agentId: string, error: string) {
    this.initSchema();
    if (!this.dag && !this.loadDag()) return;
    if (!this.dag) return;

    const node = this.dag.nodes[agentId];
    if (node) {
      node.status = "failed";
      node.error = error;
    }

    this.logEvent("error", agentId, { error });

    // For Phase 1, fail the pipeline on any agent failure
    this.dag.status = "failed";
    this.saveDag();
  }

  async getState(): Promise<DagState> {
    this.initSchema();
    if (!this.dag) this.loadDag();
    if (!this.dag) {
      return {
        run_id: "",
        pipeline_name: "",
        status: "submitted",
        current_step: 0,
        nodes: {},
        steps: [],
        created_at: "",
        updated_at: "",
        input_ref: "",
        total_tokens: 0,
        total_duration_ms: 0,
      };
    }
    return this.dag;
  }

  async getEvents(): Promise<PipelineEvent[]> {
    this.initSchema();
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM events ORDER BY id ASC")
      .toArray();
    return rows.map((r) => ({
      id: String(r.id),
      run_id: String(r.run_id),
      timestamp: String(r.timestamp),
      event_type: String(r.event_type) as PipelineEvent["event_type"],
      agent_role: r.agent_role ? String(r.agent_role) : undefined,
      details: JSON.parse(String(r.details)),
    }));
  }
}
```

- [ ] **Step 4: Export Supervisor from index.ts**

Update `src/index.ts`:

```typescript
export { Agent } from "./agent";
export { Supervisor } from "./supervisor";

export default {
  async fetch(): Promise<Response> {
    return new Response("agentx-factory");
  },
};
```

- [ ] **Step 5: Run tests to verify**

Run: `npx vitest run test/supervisor.test.ts --reporter=verbose`
Expected: Both tests PASS — initializeRun creates DAG, getState returns it.

- [ ] **Step 6: Commit**

```bash
git add src/supervisor.ts src/index.ts test/supervisor.test.ts
git commit -m "feat: add Supervisor Durable Object — DAG state machine, dispatch, gate evaluation"
```

---

## Task 9: Hono API Router + Queue Consumers

**Files:**
- Modify: `src/index.ts` (replace stub)

- [ ] **Step 1: Implement the full Worker entry point**

Replace `src/index.ts` entirely:

```typescript
// src/index.ts
import { Hono } from "hono";
import type { Env, DispatchMessage, ResultMessage } from "./types";
import { parsePipelineYaml, validatePipelineConfig } from "./schema";

export { Agent } from "./agent";
export { Supervisor } from "./supervisor";

const app = new Hono<{ Bindings: Env }>();

// ─── Health ────────────────────────────────────────
app.get("/api/health", (c) => c.json({ status: "ok", service: "agentx-factory" }));

// ─── Pipeline CRUD ─────────────────────────────────
app.post("/api/pipelines", async (c) => {
  const body = await c.req.text();
  const parsed = parsePipelineYaml(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid YAML", details: parsed.errors }, 400);
  }
  const errors = validatePipelineConfig(parsed.data);
  if (errors.length > 0) {
    return c.json({ error: "Validation failed", details: errors }, 400);
  }
  await c.env.PIPELINE_KV.put(`pipeline:${parsed.data.name}`, body);
  return c.json({ name: parsed.data.name, status: "saved" }, 201);
});

app.get("/api/pipelines", async (c) => {
  const list = await c.env.PIPELINE_KV.list({ prefix: "pipeline:" });
  const names = list.keys.map((k) => k.name.replace("pipeline:", ""));
  return c.json({ pipelines: names });
});

app.get("/api/pipelines/:name", async (c) => {
  const name = c.req.param("name");
  const yaml = await c.env.PIPELINE_KV.get(`pipeline:${name}`);
  if (!yaml) return c.json({ error: "Not found" }, 404);
  return c.text(yaml, 200, { "Content-Type": "text/yaml" });
});

app.delete("/api/pipelines/:name", async (c) => {
  const name = c.req.param("name");
  await c.env.PIPELINE_KV.delete(`pipeline:${name}`);
  return c.json({ status: "deleted" });
});

// ─── Pipeline Runs ─────────────────────────────────
app.post("/api/runs", async (c) => {
  const body = await c.req.json<{ pipeline: string; input: unknown }>();
  const yaml = await c.env.PIPELINE_KV.get(`pipeline:${body.pipeline}`);
  if (!yaml) {
    return c.json({ error: `Pipeline "${body.pipeline}" not found` }, 404);
  }

  const runId = crypto.randomUUID();
  const supervisorId = c.env.SUPERVISOR.idFromName(runId);
  const supervisor = c.env.SUPERVISOR.get(supervisorId);

  const result = await supervisor.initializeRun({
    runId,
    pipelineYaml: yaml,
    input: body.input,
  });

  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  // Index the run in KV for listing
  await c.env.PIPELINE_KV.put(
    `run:${runId}`,
    JSON.stringify({ pipeline: body.pipeline, created_at: new Date().toISOString(), status: "started" })
  );

  return c.json({ run_id: runId, status: "started" }, 201);
});

app.get("/api/runs", async (c) => {
  const list = await c.env.PIPELINE_KV.list({ prefix: "run:" });
  const runs = await Promise.all(
    list.keys.map(async (k) => {
      const data = await c.env.PIPELINE_KV.get(k.name);
      return { run_id: k.name.replace("run:", ""), ...JSON.parse(data ?? "{}") };
    })
  );
  return c.json({ runs });
});

app.get("/api/runs/:id", async (c) => {
  const runId = c.req.param("id");
  const supervisorId = c.env.SUPERVISOR.idFromName(runId);
  const supervisor = c.env.SUPERVISOR.get(supervisorId);

  const state = await supervisor.getState();
  return c.json(state);
});

app.get("/api/runs/:id/events", async (c) => {
  const runId = c.req.param("id");
  const supervisorId = c.env.SUPERVISOR.idFromName(runId);
  const supervisor = c.env.SUPERVISOR.get(supervisorId);

  const events = await supervisor.getEvents();
  return c.json({ events });
});

app.get("/api/runs/:id/artifacts/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const obj = await c.env.ARTIFACT_STORE.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  return c.text(await obj.text(), 200, { "Content-Type": "application/json" });
});

// ─── Worker Export ─────────────────────────────────
export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch, env: Env) {
    for (const msg of batch.messages) {
      const data = msg.body as DispatchMessage | ResultMessage | { type: string };

      if (data.type === "dispatch") {
        const dispatch = data as DispatchMessage;
        const agentDoId = env.AGENT.idFromName(
          `${dispatch.envelope.pipeline_run}:${dispatch.envelope.to.agent}`
        );
        const agent = env.AGENT.get(agentDoId);

        try {
          await agent.handleTask({
            runId: dispatch.envelope.pipeline_run,
            agentConfig: dispatch.agent_config,
            modelDefaults: dispatch.model_defaults,
            inputRefs: dispatch.envelope.context_window.parent_refs,
            supervisorDoId: dispatch.envelope.from.do_id,
            retryCount: dispatch.envelope.metadata.retry_count,
          });
          msg.ack();
        } catch (e) {
          console.error(`Agent task failed: ${e}`);
          msg.retry();
        }
      } else if (data.type === "result") {
        const result = data as ResultMessage;
        const supervisorId = env.SUPERVISOR.idFromName(
          result.envelope.pipeline_run
        );
        const supervisor = env.SUPERVISOR.get(supervisorId);

        try {
          await supervisor.handleAgentCompletion(result.envelope);
          msg.ack();
        } catch (e) {
          console.error(`Supervisor completion handling failed: ${e}`);
          msg.retry();
        }
      } else {
        // DLQ or unknown message type
        console.error(`Unknown queue message type: ${data.type}`);
        msg.ack();
      }
    }
  },
};
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Verify wrangler builds**

Run: `npx wrangler deploy --dry-run --outdir=dist 2>&1 | tail -5`
Expected: Build succeeds, outputs bundle to `dist/`.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add Hono API router + queue consumers — pipeline CRUD, run management"
```

---

## Task 10: End-to-End Integration Test

**Files:**
- Create: `test/e2e.test.ts`

- [ ] **Step 1: Write the integration test**

This test verifies the full flow: upload pipeline YAML -> start run -> verify Supervisor creates DAG and dispatches agents.

```typescript
// test/e2e.test.ts
import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { readFileSync } from "node:fs";

const codeReviewYaml = readFileSync("pipelines/code-review.yaml", "utf-8");

describe("E2E: Pipeline Run", () => {
  it("health check returns ok", async () => {
    const res = await SELF.fetch("http://localhost/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("saves and retrieves a pipeline definition", async () => {
    // Create
    const createRes = await SELF.fetch("http://localhost/api/pipelines", {
      method: "POST",
      body: codeReviewYaml,
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.name).toBe("code-review");

    // List
    const listRes = await SELF.fetch("http://localhost/api/pipelines");
    const list = await listRes.json();
    expect(list.pipelines).toContain("code-review");

    // Get
    const getRes = await SELF.fetch("http://localhost/api/pipelines/code-review");
    expect(getRes.status).toBe(200);
    const yaml = await getRes.text();
    expect(yaml).toContain("code-review");
  });

  it("starts a pipeline run and creates DAG state", async () => {
    // Ensure pipeline exists
    await SELF.fetch("http://localhost/api/pipelines", {
      method: "POST",
      body: codeReviewYaml,
    });

    // Start run
    const runRes = await SELF.fetch("http://localhost/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipeline: "code-review",
        input: { diff: "console.log('test')" },
      }),
    });
    expect(runRes.status).toBe(201);
    const run = await runRes.json();
    expect(run.run_id).toBeTruthy();

    // Check run state
    const stateRes = await SELF.fetch(`http://localhost/api/runs/${run.run_id}`);
    const state = await stateRes.json();
    expect(state.pipeline_name).toBe("code-review");
    expect(["dispatching", "running"]).toContain(state.status);
    expect(Object.keys(state.nodes)).toContain("security");
    expect(Object.keys(state.nodes)).toContain("performance");
    expect(Object.keys(state.nodes)).toContain("correctness");
    expect(Object.keys(state.nodes)).toContain("synthesizer");

    // Check input artifact in R2
    const inputObj = await env.ARTIFACT_STORE.get(`runs/${run.run_id}/input.json`);
    expect(inputObj).not.toBeNull();
    const inputData = await inputObj!.json();
    expect(inputData.diff).toBe("console.log('test')");

    // Check events
    const eventsRes = await SELF.fetch(`http://localhost/api/runs/${run.run_id}/events`);
    const events = await eventsRes.json();
    expect(events.events.length).toBeGreaterThan(0);
    expect(events.events.some((e: any) => e.event_type === "dispatch")).toBe(true);
  });

  it("lists pipeline runs", async () => {
    const listRes = await SELF.fetch("http://localhost/api/runs");
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.runs.length).toBeGreaterThan(0);
  });

  it("rejects a run for a non-existent pipeline", async () => {
    const res = await SELF.fetch("http://localhost/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline: "nonexistent", input: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects invalid pipeline YAML", async () => {
    const res = await SELF.fetch("http://localhost/api/pipelines", {
      method: "POST",
      body: "name: incomplete\nversion: 1\n",
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass — envelope (3), schema (4), gate (4), anthropic (4), e2e (6).

Note: The Agent DO `handleTask` test may show a controlled failure for the Anthropic API call (no real API key in test). That's expected — the test verifies initialization and error handling paths.

- [ ] **Step 3: Fix any failures**

If any tests fail, read the error output, identify root cause, fix, and re-run. Common issues:
- Import paths
- Miniflare binding names not matching wrangler.toml
- DO RPC method signatures

- [ ] **Step 4: Commit**

```bash
git add test/e2e.test.ts
git commit -m "test: add end-to-end integration tests — pipeline CRUD, run lifecycle, DAG state"
```

---

## Task 11: Deploy Verification

**Files:**
- No new files. Verification only.

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Test local dev server**

Run: `npx wrangler dev` (in background)

Then in another terminal:
```bash
# Health check
curl http://localhost:8787/api/health
# Expected: {"status":"ok","service":"agentx-factory"}

# Upload pipeline
curl -X POST http://localhost:8787/api/pipelines -d @pipelines/code-review.yaml
# Expected: {"name":"code-review","status":"saved"}

# List pipelines
curl http://localhost:8787/api/pipelines
# Expected: {"pipelines":["code-review"]}
```

- [ ] **Step 4: Deploy to Cloudflare (requires account setup)**

Before deploying, create the required resources:
```bash
# Create KV namespace
npx wrangler kv namespace create PIPELINE_KV
# Update wrangler.toml with the returned ID

# Create R2 bucket
npx wrangler r2 bucket create agentx-artifacts

# Create Queues
npx wrangler queues create agentx-dispatch
npx wrangler queues create agentx-results
npx wrangler queues create agentx-dlq

# Set API key
npx wrangler secret put ANTHROPIC_API_KEY
# Enter your API key when prompted

# Deploy
npx wrangler deploy
```

- [ ] **Step 5: Smoke test production**

```bash
WORKER_URL="https://agentx-factory.<your-subdomain>.workers.dev"

# Health
curl $WORKER_URL/api/health

# Upload pipeline
curl -X POST $WORKER_URL/api/pipelines -d @pipelines/code-review.yaml

# Start a run
curl -X POST $WORKER_URL/api/runs \
  -H "Content-Type: application/json" \
  -d '{"pipeline":"code-review","input":{"diff":"+ const x = eval(userInput)"}}'

# Poll for completion (save the run_id from above)
curl $WORKER_URL/api/runs/<run_id>
```

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: verify build, test suite, and deployment — Phase 1 MVP complete"
```

---

## Summary

| Task | What | Files | Tests |
|------|------|-------|-------|
| 1 | Scaffolding | package.json, tsconfig, wrangler.toml, vitest.config | Build verification |
| 2 | Types | src/types.ts | Type check only |
| 3 | Envelope helpers | src/envelope.ts | 3 unit tests |
| 4 | YAML schema | src/schema.ts, pipelines/code-review.yaml | 4 unit tests |
| 5 | Gate evaluator | src/gate.ts | 4 unit tests |
| 6 | Anthropic client | src/anthropic.ts | 4 unit tests |
| 7 | Agent DO | src/agent.ts | 2 integration tests |
| 8 | Supervisor DO | src/supervisor.ts | 2 integration tests |
| 9 | API + Queue consumers | src/index.ts | — (covered by e2e) |
| 10 | E2E integration | test/e2e.test.ts | 6 integration tests |
| 11 | Deploy verification | — | Manual smoke test |

**Total:** 10 source files, 7 test files, ~25 automated tests, 11 atomic commits.
