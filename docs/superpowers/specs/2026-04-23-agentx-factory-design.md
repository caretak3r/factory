# AgentX Factory -- Design Spec

**Date:** 2026-04-23
**Author:** Rohit + Claude
**Status:** Draft

---

## 1. Problem

Rohit runs multi-agent workflows daily -- code review swarms, parallel research, feature development pipelines -- via cmux terminal multiplexing. These workflows are effective but fragile: no persistence across sessions, no failure recovery, no observability, no durable memory. An agent that crashes mid-pipeline is gone. Context accumulated during a run evaporates when the terminal closes.

AgentX Factory replaces this with a platform service that makes multi-agent pipelines durable, observable, and self-healing.

## 2. Success Criteria

1. A YAML pipeline definition can describe the existing code-review, research, and feature-dev workflows from `~/.claude/memory/multi-agent-workflows/`
2. A pipeline run survives agent failures -- retry, fallback, or graceful degradation without manual intervention
3. Pipeline state and agent memory persist across sessions -- a run can be inspected, resumed, or replayed
4. End-to-end latency for a 3-agent parallel pipeline is under 2x the slowest individual agent call (overhead from orchestration < 100%)
5. Rohit can deploy and run the entire system with `wrangler deploy`

## 3. Non-Goals (v1)

- Multi-tenancy, auth, billing
- Visual pipeline builder / drag-and-drop UI
- Non-Anthropic LLM providers (thin abstraction exists but only Claude is wired)
- Agent-to-agent direct communication (all communication is supervisor-mediated)
- Streaming responses to the client during pipeline execution (v1 is request/response)
- Custom tool execution sandboxing (agents call LLMs, not arbitrary code)

## 4. Architecture

### 4.1 Platform: Cloudflare-Native

Single platform, single deployment target.

| CF Primitive | Role |
|-------------|------|
| Worker | HTTP API (Hono), serves dashboard static assets |
| Durable Object (Supervisor) | Pipeline state machine, DAG tracker, gate evaluator, recovery engine |
| Durable Object (Agent) | Stateful actor, owns memory shard (transactional SQLite), executes LLM calls |
| Queues | Task dispatch (Supervisor -> Agent), result reporting (Agent -> Supervisor) |
| KV | Pipeline YAML manifests, gate threshold config, runtime settings |
| R2 | Agent output artifacts, pipeline results, handoff payloads, audit logs |

### 4.2 Execution Model: Supervisor + Agent DOs

```
                         +------------------+
                         |   Hono Worker    |
                         |   (API Router)   |
                         +--------+---------+
                                  |
                         POST /pipelines/run
                                  |
                         +--------v---------+
                         |  Supervisor DO   |
                         |  - DAG state     |
                         |  - Gate eval     |
                         |  - Recovery      |
                         +---+---------+----+
                             |         |
                    Dispatch Queue     Result Queue
                       |    |    |          ^  ^  ^
                       v    v    v          |  |  |
                    +----+ +----+ +----+   |  |  |
                    | A1 | | A2 | | A3 |---+--+--+
                    +----+ +----+ +----+
                      |      |      |
                      v      v      v
                    +-------------------+
                    |    R2 Bucket      |
                    |  (artifacts)      |
                    +-------------------+
```

**Supervisor DO** -- one per pipeline run. Owns the DAG. Receives agent completions via Result Queue. Evaluates gates. Dispatches next step or triggers recovery. Never makes LLM calls itself.

**Agent DO** -- one per agent instance per pipeline run. Receives task from Dispatch Queue. Pulls input artifacts from R2. Makes LLM call to Anthropic API. Writes output artifact to R2. Reports completion via Result Queue. Owns its own SQLite storage for memory/context that persists across retries.

**Key constraint:** Workers have a 30s CPU time limit per invocation. Durable Objects extend this with alarm chains -- a DO can schedule its own wake-up. For long LLM calls (30-120s), the Agent DO uses `fetch()` to call Anthropic (fetch time doesn't count against CPU limit) and processes the response when it arrives. This is not a workaround -- it's the designed pattern.

### 4.3 Memory Model: DO-per-Agent (Pure Actor)

Each Agent DO owns a transactional SQLite database (Durable Object Storage). This is the "memory shard" from the architecture diagram.

**What's stored in an Agent DO's SQLite:**
- Conversation history for the current task
- Intermediate reasoning/scratchpad
- Retry context (what failed, why, what to adjust)
- Agent-specific config (role prompt, model selection, tool access)

**What's NOT stored in Agent DO:**
- Other agents' outputs (those are in R2, referenced by envelope)
- Pipeline-level state (that's the Supervisor DO's job)
- Config/manifests (those are in KV)

**No shared mutable state.** Agents communicate exclusively through message passing (Queues) with data references (R2 paths). The Supervisor coordinates but never mutates agent memory.

### 4.4 Handoff Protocol

Three layers: mediation, contract, failure.

#### 4.4.1 Mediation: Supervisor-Controlled, R2-Backed Data

Control flow routes through the Supervisor. Data flows through R2. Queue messages carry lightweight envelopes, not payloads.

```
Agent completes work
  -> Writes output to R2 (r2://run-{id}/agent-{role}/output.json)
  -> Sends envelope to Result Queue (< 1KB)
  -> Supervisor receives envelope
  -> Supervisor evaluates gates
  -> Supervisor sends dispatch envelope to next agent via Dispatch Queue
  -> Next agent pulls input artifact from R2 using envelope's artifact_ref
```

This avoids the 128KB Queue message limit entirely. Envelopes are tiny. Artifacts can be megabytes.

#### 4.4.2 Message Contract: Envelope Schema

```typescript
interface HandoffEnvelope {
  id: string;                    // UUID for this handoff
  pipeline_run: string;          // UUID for the pipeline run
  from: {
    agent: string;               // Role name from YAML
    do_id: string;               // Durable Object ID
  };
  to: {
    agent: string;
    do_id: string;
  };
  artifact_ref: string;          // R2 path: r2://run-{id}/agent-{role}/output.json
  artifact_type: string;         // Schema name for validation
  gate_results: Record<string, 'pass' | 'fail' | 'skip'>;
  context_window: {
    parent_refs: string[];       // R2 paths to upstream artifacts this agent may need
  };
  metadata: {
    tokens_used: number;
    model: string;
    duration_ms: number;
    retry_count: number;
  };
  timestamp: string;             // ISO 8601
}
```

#### 4.4.3 Failure Handling: Layered Recovery

```
Layer 1: Queue retry
  Cloudflare Queues built-in retry with exponential backoff.
  Agent DO crashed mid-execution -> message redelivered.
  Max attempts configurable per pipeline (default: 3).

Layer 2: Dead letter queue
  After max retries exhausted, message goes to DLQ.
  Supervisor is notified via a separate DLQ consumer.

Layer 3: Supervisor recovery
  Supervisor evaluates recovery strategy from YAML:
  - retry: re-dispatch with adjusted parameters
  - fallback: spawn alternate agent DO for same role
  - degrade: skip failed branch, continue with partial results
  - escalate: pause pipeline, notify human

Layer 4: Human escalation
  Notification sent (webhook, email, or dashboard alert).
  Pipeline pauses in "awaiting_human" state.
  Human can resume, abort, or override via API.
```

### 4.5 Gates and Circuit Breakers

Gates are Supervisor state transitions, not separate services.

#### Gate Types

| Gate | Trigger | Action |
|------|---------|--------|
| Token budget | `metadata.tokens_used > pipeline.budget` | Warn or block |
| Hallucination | LLM response includes low-confidence markers or contradicts input | Retry with stricter prompt |
| Timeout | Agent DO hasn't reported within `pipeline.timeout_ms` | Supervisor alarm fires, triggers recovery |
| Schema validation | Agent output doesn't match `artifact_type` contract | Reject, retry |
| Quality threshold | Evaluator agent scores output below threshold | Retry or escalate |

#### Circuit Breaker (per agent role, per pipeline)

```typescript
interface CircuitBreakerState {
  state: 'closed' | 'half_open' | 'open';
  failure_count: number;
  last_failure: string;         // ISO timestamp
  cooldown_ms: number;          // Exponential backoff
  threshold: number;            // Failures before opening
}
```

- **Closed:** normal operation, errors increment failure_count
- **Open:** fast-fail, skip agent, trigger fallback immediately
- **Half-open:** after cooldown, probe with single request. Success -> closed. Failure -> open with longer cooldown.

Circuit breaker state lives in the Supervisor DO's SQLite -- it persists across pipeline runs for the same agent role.

## 5. Pipeline YAML Schema

### 5.1 Top-Level Structure

```yaml
name: string                     # Pipeline identifier
version: number                  # Schema version (1)
description: string              # Human-readable description

model_defaults:                  # LLM tier mapping
  planning: string               # Model ID for planning/reasoning tasks
  execution: string              # Model ID for standard agent work
  classification: string         # Model ID for gates/routing (cheap/fast)

agents:                          # Agent definitions
  - id: string                   # Unique within pipeline
    role: string                 # System prompt / role description
    model: string                # Key from model_defaults or explicit model ID
    tools: string[]              # Tool names available to this agent (declared in v1, executed in Phase 3)
    memory:
      max_tokens: number         # Context window budget for this agent
    fallback: string             # Optional: agent ID to use if this one fails

pipeline:                        # Execution steps (ordered)
  - step: string                 # Step name
    agent: string                # Agent ID (for single-agent steps)
    agents: string[]             # Agent IDs (for parallel steps)
    mode: parallel | sequential  # Execution mode (default: sequential)
    inputs: string[]             # Agent IDs whose outputs feed into this step
    type: gate                   # Optional: marks this as a gate step
    condition: string            # Gate condition expression
    on_fail: string              # Gate failure action
    on_match: string             # Gate match action (for conditional gates)
    on_pass: string              # Gate pass-through action

recovery:                        # Default recovery config
  default: string                # Default action: retry(max=N, backoff=exponential)
  fallback: string               # Fallback action: degrade(skip_failed_agent=true)
  escalation: string             # Escalation: human(channel=notification)

budget:                          # Resource limits
  max_tokens: number             # Total token budget across all agents
  max_duration_ms: number        # Pipeline timeout
  max_retries: number            # Global retry cap
```

### 5.2 Example: Code Review Pipeline

```yaml
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
    memory: { max_tokens: 8000 }

  - id: performance
    role: >
      Performance engineer. Review the diff for bottlenecks:
      N+1 queries, unbounded loops, memory leaks, missing indexes.
      Output structured findings with impact estimates.
    model: execution
    tools: []
    memory: { max_tokens: 8000 }

  - id: correctness
    role: >
      Senior engineer. Review the diff for logic errors:
      edge cases, race conditions, incorrect assumptions,
      missing error handling. Output structured findings.
    model: planning
    tools: []
    memory: { max_tokens: 16000 }

  - id: synthesizer
    role: >
      Merge all review findings into a single report.
      Deduplicate, prioritize by severity, add overall assessment.
    model: execution
    tools: []
    memory: { max_tokens: 4000 }

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
  default: retry(max=2, backoff=exponential)
  fallback: degrade(skip_failed_agent=true)
  escalation: human(channel=notification)

budget:
  max_tokens: 100000
  max_duration_ms: 300000
  max_retries: 6
```

### 5.3 Example: Research Pipeline

```yaml
name: parallel-research
version: 1
description: Multi-angle research with debate and synthesis

model_defaults:
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  classification: claude-haiku-4-5-20251001

agents:
  - id: analyst-technical
    role: >
      Technical analyst. Research the topic from an engineering
      and implementation perspective. Cite sources.
    model: execution
    memory: { max_tokens: 12000 }

  - id: analyst-market
    role: >
      Market analyst. Research the topic from a business,
      competitive, and market perspective. Cite sources.
    model: execution
    memory: { max_tokens: 12000 }

  - id: analyst-contrarian
    role: >
      Devil's advocate. Find counterarguments, risks, and
      reasons this might fail. Challenge assumptions.
    model: planning
    memory: { max_tokens: 12000 }

  - id: synthesizer
    role: >
      Synthesize all analyst reports. Identify consensus,
      disagreements, and key uncertainties. Produce a
      balanced executive summary with recommendations.
    model: planning
    memory: { max_tokens: 8000 }

pipeline:
  - step: research
    agents: [analyst-technical, analyst-market, analyst-contrarian]
    mode: parallel

  - step: completeness-gate
    type: gate
    condition: all_agents_completed
    on_fail: retry(max=1)

  - step: synthesize
    agent: synthesizer
    inputs: [analyst-technical, analyst-market, analyst-contrarian]

recovery:
  default: retry(max=2, backoff=exponential)
  fallback: degrade(skip_failed_agent=true)
  escalation: human(channel=notification)

budget:
  max_tokens: 150000
  max_duration_ms: 600000
  max_retries: 6
```

## 6. API Surface

### 6.1 HTTP API (Hono Worker)

```
POST   /api/pipelines              Create/update pipeline YAML in KV
GET    /api/pipelines              List all pipeline definitions
GET    /api/pipelines/:name        Get pipeline definition
DELETE /api/pipelines/:name        Delete pipeline definition

POST   /api/runs                   Start a pipeline run
GET    /api/runs                   List pipeline runs (with status filter)
GET    /api/runs/:id               Get run status + DAG state
GET    /api/runs/:id/agents        List agent statuses for a run
GET    /api/runs/:id/agents/:role  Get agent detail (memory, artifacts)
GET    /api/runs/:id/artifacts     List R2 artifacts for a run
GET    /api/runs/:id/artifacts/:key  Download specific artifact
POST   /api/runs/:id/resume        Resume a paused pipeline (after human review)
POST   /api/runs/:id/abort         Abort a running pipeline

GET    /api/health                 Health check
```

### 6.2 Dashboard

v1 is minimal -- a Worker-served SPA or HTMX app from R2.

**Views:**
- Pipeline list (YAML definitions with last run status)
- Run detail (DAG visualization with per-agent status, timing, token usage)
- Agent detail (memory contents, artifacts, retry history)
- Live run view (polling-based status updates for in-progress runs)

Tech decision deferred: Hono + HTMX (server-rendered, minimal JS) vs React SPA (richer interactivity). Recommendation: HTMX for v1 -- less build tooling, works well for a polling-based dashboard, and Rohit is the only user.

## 7. Data Flow: Complete Pipeline Run

```
1. Client POSTs to /api/runs with {pipeline: "code-review", input: {...}}
2. Worker fetches pipeline YAML from KV
3. Worker validates YAML against schema
4. Worker creates Supervisor DO via env.SUPERVISOR.idFromName(runId)
5. Supervisor DO:
   a. Parses YAML into DAG
   b. Creates Agent DOs via env.AGENT.idFromName(runId + agentId) for each agent in YAML
   c. Stores initial state: {status: "planning", dag: {...}}
   d. Writes input artifact to R2 (r2://run-{id}/input.json)
   e. Transitions to "dispatching"
   f. For step 1 (parallel review): pushes 3 task envelopes to Dispatch Queue
6. Each Agent DO receives task from Queue:
   a. Pulls input artifact from R2
   b. Constructs prompt from role + input
   c. Calls Anthropic API (fetch -- doesn't count against CPU limit)
   d. Writes output artifact to R2
   e. Pushes completion envelope to Result Queue
7. Supervisor receives completion envelopes:
   a. Updates DAG state (agent -> completed)
   b. When all parallel agents complete: evaluates gate
   c. Gate passes: dispatches synthesizer with input refs to all 3 outputs
   d. Gate fails: triggers recovery (retry or fallback)
8. Synthesizer Agent DO:
   a. Pulls all 3 upstream artifacts from R2
   b. Calls Anthropic API
   c. Writes final output to R2
   d. Reports completion
9. Supervisor:
   a. Marks pipeline as "completed"
   b. Records final metrics (total tokens, duration, cost estimate)
   c. Returns run ID to client (client polls /api/runs/:id for result)
```

## 8. Observability

### 8.1 Structured Logging

Every state transition, gate evaluation, and agent action is logged to the Supervisor DO's SQLite as a structured event:

```typescript
interface PipelineEvent {
  id: string;
  run_id: string;
  timestamp: string;
  event_type: 'dispatch' | 'completion' | 'gate_eval' | 'recovery' | 'error' | 'state_transition';
  agent_role?: string;
  details: Record<string, unknown>;
}
```

### 8.2 Metrics (per run)

- Total tokens consumed (by agent, by model tier)
- Total duration (wall clock and per-agent)
- Retry count
- Gate pass/fail counts
- Cost estimate (based on model pricing)

### 8.3 Audit Trail

The Supervisor DO's SQLite is the audit trail. Every envelope, every gate result, every state transition is a row. No external observability system needed for v1. If external tooling is needed later, batch-export events from SQLite to R2 as JSONL.

## 9. Project Structure

```
factory/
  src/
    index.ts                  # Hono Worker -- API router, static asset serving
    supervisor.ts             # Supervisor Durable Object class
    agent.ts                  # Agent Durable Object class
    schema.ts                 # YAML validation (Zod schemas)
    envelope.ts               # HandoffEnvelope type + helpers
    gate.ts                   # Gate evaluation logic
    circuit-breaker.ts        # Circuit breaker state machine
    recovery.ts               # Recovery strategy engine
    anthropic.ts              # Anthropic API client (thin wrapper)
    types.ts                  # Shared TypeScript types
  pipelines/
    code-review.yaml          # Built-in pipeline: code review
    research.yaml             # Built-in pipeline: parallel research
    feature-dev.yaml           # Built-in pipeline: feature development
  dashboard/
    index.html                # Dashboard entry point (HTMX)
    styles.css                # Minimal styles
  wrangler.toml               # Cloudflare config (DO bindings, Queue bindings, KV/R2)
  package.json
  tsconfig.json
  docs/
    diagrams/                 # Mermaid architecture diagrams (already created)
  PROJECT_CONTEXT.md          # Architecture reference (already created)
```

## 10. Cloudflare Configuration (wrangler.toml shape)

```toml
name = "agentx-factory"
main = "src/index.ts"
compatibility_date = "2026-04-23"

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
script_name = "agentx-factory"
max_batch_size = 1
max_retries = 3
dead_letter_queue = "agentx-dlq"

[[queues.consumers]]
queue = "agentx-results"
script_name = "agentx-factory"
max_batch_size = 10
max_retries = 3

[[queues.consumers]]
queue = "agentx-dlq"
script_name = "agentx-factory"
max_batch_size = 1

[vars]
ANTHROPIC_API_KEY = ""         # Set via wrangler secret

[[kv_namespaces]]
binding = "PIPELINE_KV"
id = ""                        # Created via wrangler kv:namespace create

[[r2_buckets]]
binding = "ARTIFACT_STORE"
bucket_name = "agentx-artifacts"
```

## 11. Implementation Phases

### Phase 1: Core Engine (MVP)

- Hono Worker with pipeline CRUD API
- Supervisor DO: DAG parser, state machine, gate evaluator
- Agent DO: single-turn LLM call via Anthropic API, R2 artifact write
- Queue-based dispatch and result collection
- Envelope schema
- YAML validation with Zod
- One working pipeline: code-review.yaml
- `wrangler deploy` works end-to-end

**Deliverable:** Run `POST /api/runs` with a code review pipeline and get a synthesized report back.

### Phase 2: Recovery + Observability

- Circuit breaker implementation
- Layered recovery (retry, fallback, degrade, escalate)
- DLQ consumer
- Structured event logging in Supervisor SQLite
- Per-run metrics (tokens, duration, cost)
- API endpoints for run inspection (`/runs/:id`, `/runs/:id/agents`)

### Phase 3: Dashboard + Multi-Turn Agents

- HTMX dashboard: pipeline list, run detail, agent detail
- Multi-turn agent support (agent can make multiple LLM calls per task)
- Agent tool use (agent can invoke tools defined in YAML -- starting with structured output validation)
- Pipeline input templates (parameterized YAML)

### Phase 4: Advanced Patterns

- Conditional branching in DAG (routing based on agent output)
- Agent-to-agent gossip (supervised: Supervisor relays messages between agent DOs)
- Pipeline composition (one pipeline's output feeds another pipeline)
- Cross-run memory (agent DOs persist knowledge across different pipeline runs)
- Cost-aware model routing (auto-downgrade to cheaper model if budget is tight)

## 12. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Anthropic API latency spikes | Pipeline duration blows up | Timeout per agent, parallel execution absorbs some variance |
| Durable Object cold starts | Added latency on first dispatch | DOs stay warm during a pipeline run; cold start is ~50ms (acceptable) |
| R2 consistency (eventual for listing, strong for reads) | Agent reads stale artifact | Write artifact before sending envelope; envelope contains exact R2 key (not listing-based) |
| Queue message ordering | Agents receive tasks out of order | DAG enforcement in Supervisor; agents only execute when Supervisor dispatches |
| SQLite storage limits (10GB per DO) | Agent memory overflow | Memory budget per agent in YAML; prune old context beyond budget |
| Cloudflare Workers 128MB memory | Large artifacts crash Worker | Artifacts go to R2, not through Worker memory; stream if needed |

## 13. Open Questions (to resolve during implementation)

1. **Gate condition DSL:** How expressive should gate conditions be? Start with simple keywords (`all_agents_completed`, `severity >= critical`) and add a mini-expression evaluator if needed?
2. **Agent tool sandboxing:** v1 agents only call LLMs. When we add tool use (Phase 3), how do we sandbox tool execution within a DO? Workers runtime limits what's possible.
3. **Pipeline versioning:** When a YAML definition changes, do in-flight runs use the old version? (Yes -- snapshot YAML into Supervisor DO at run creation.)
4. **Dashboard auth:** v1 has none (dogfood, localhost/tunnel). When is auth needed? Cloudflare Access is the simplest path.
5. **Cost tracking:** Anthropic API returns token counts in responses. Store per-agent and aggregate per-run. Actual dollar cost requires a pricing table -- hardcode or fetch?

---

*This spec covers the complete design for AgentX Factory v1. Implementation should follow the phased approach in Section 11, starting with Phase 1 (Core Engine). Each phase should be independently deployable and testable.*
