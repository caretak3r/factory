# AgentX Factory

Multi-agent pipeline orchestration platform. Cloudflare-native. Anthropic-primary.

## Status

**Phase:** Phase 4 complete (conditional + composition + gossip + memory)
**Started:** 2026-04-23
**Target user:** Dogfood (Rohit is user zero)

**Phase 2 shipped (2026-05-03):**
- Structured recovery DSL (replaced string config) — retry/fallback/escalation as Zod objects
- Per-role global circuit breaker (singleton DO `CircuitBreaker`, 5-failure / 60s window, 30s decay → half-open)
- Recovery state machine in supervisor: retry-with-backoff → agent fallback → recovery-config fallback → escalate-to-human → fail
- New event types: `recovery_attempt`, `circuit_trip`, `escalation`
- New endpoints: `GET /api/runs/:id/metrics`, `GET /api/circuit-breaker`

**Phase 3 shipped (2026-05-03):**
- HTMX + SSE dashboard at `/`, `/runs`, `/runs/:id`, `/pipelines`, `/pipelines/:name`
- Server-rendered Mermaid DAG (auto-refreshes via HTMX poll); live event stream via `/api/runs/:id/stream`
- Multi-turn agent loop in `agent.ts` (driven by `AgentConfig.turns.max` + optional `stop_when` substring); per-turn history persisted in agent DO SQLite
- Anthropic wrapper (`callAnthropic`) now accepts `messages[]` and exposes raw `blocks` (text + tool_use)
- Tool registry (`src/tools/registry.ts`): `read`, `grep`, `semgrep` (stub), `test-runner` (stub); R2-scoped sandbox blocks path traversal + cross-run access; 10s wall-clock timeout per call

**Phase 4 shipped (2026-05-03):**
- Conditional steps: `when:` DSL evaluator (`src/conditional.ts`) — whitelisted refs (`agent.X.completed`, `agent.X.tokens`, `gate.X.passed`, `metrics.total_tokens`, etc.), boolean ops, comparisons, no eval. Skipped steps emit `step_skipped` events and write empty artifacts so downstream gates pass
- Pipeline composition: `import:` step (`src/composition.ts`) — one level deep, prefixed agent/step IDs (`<step>__<inner>`), cycle detection, missing-import errors
- Mid-run gossip: `src/gossip.ts` — opt-in two-sided trust (`gossip.read_peers` on reader, `gossip.expose: public` on peer); supervisor passes peer artifact refs in dispatch message; agent prepends them to prompt
- Cross-run memory: `src/memory.ts` — KV-backed per-pipeline-name index (cap 50), supervisor appends summary on terminal state, agents fetch via `memory.include_prior_runs` opt-in. Read-only (no feedback loops in v1)
- Examples: `pipelines/security-base.yaml` (reusable block), `pipelines/conditional-review.yaml` (uses all four Phase-4 features)
- Test count: 96 → 137 (41 new across conditional, composition, gossip, memory, e2e)

## What This Is

A platform service that interprets YAML pipeline definitions and executes them as coordinated multi-agent workflows. Each agent is a stateful Durable Object with its own memory. A Supervisor DO manages the pipeline DAG, evaluates gates, triggers recovery, and collects output.

Think: your cmux-based multi-agent workflows, but durable, observable, and self-healing.

## Architecture Decisions

| Decision | Choice |
|----------|--------|
| Runtime | Cloudflare Workers + Durable Objects + Queues + KV + R2 |
| LLM | Anthropic-primary (Opus/Sonnet/Haiku tiered). Thin abstraction layer |
| Pipeline format | YAML config-as-code |
| Execution model | Supervisor DO (state machine) + Agent DOs (autonomous workers) |
| Memory model | DO-per-agent, pure actor model. No shared mutable state |
| Handoff | Supervisor-mediated control flow, R2-backed data flow, envelope messages |
| Dashboard | Worker-served (Hono + HTMX or SPA from R2) |
| Auth/billing | None (v1 is single-user dogfood) |

## Execution Model

```
Supervisor DO (state machine, DAG owner)
  |-- dispatches --> Agent DO_1 (via Queue)
  |-- dispatches --> Agent DO_2 (via Queue)
  |-- evaluates gates on agent completion
  |-- triggers recovery / fallback agents
  '-- collects final output --> R2
```

**Control flow:** Supervisor-mediated. Every state transition goes through the Supervisor.
**Data flow:** R2-backed. Agent outputs go to R2, envelope messages carry references.
**Failure handling:** Queue retry (backoff) -> DLQ -> Supervisor fallback -> human escalation.

## Handoff Envelope

```yaml
handoff:
  id: "handoff-uuid"
  pipeline_run: "run-uuid"
  from: { agent: "role", do_id: "..." }
  to: { agent: "role", do_id: "..." }
  artifact_ref: "r2://pipeline-{run}/{agent}/output.json"
  artifact_type: "schema_name"
  gate_results: { check_name: "pass|fail" }
  context_window: { parent_refs: ["r2://..."] }
  metadata: { tokens_used: N, model: "...", duration_ms: N }
```

## Cloudflare Primitive Mapping

| Concept | CF Primitive | Purpose |
|---------|-------------|---------|
| Agent instance | Durable Object | Stateful actor with transactional SQLite (memory shard) |
| Pipeline controller | Durable Object | Supervisor state machine, DAG tracking |
| Task dispatch | Queues | Message passing between Supervisor and Agents |
| Hot config | KV | Pipeline YAML manifests, gate thresholds, runtime settings |
| Artifact storage | R2 | Agent outputs, pipeline results, handoff payloads |
| API/dashboard | Worker | Hono HTTP endpoints, static asset serving |

## Architecture Layers

1. **Input** -- Raw input queue (prompts, tasks, data)
2. **Orchestrator** -- Supervisor DO: DAG owner, token budget, queue management
3. **Pipelines** -- Agent DO swarms, parallel execution, specialized chains
4. **Memory** -- DO-per-agent transactional SQLite, hierarchical context windows
5. **Gates** -- Supervisor state transitions: timeouts, hallucination checks, budget limits
6. **Checks** -- Output validation, token pruning, structured state compression
7. **Recovery** -- Retry subgraphs, fallback agents, human-in-the-loop escalation
8. **Output** -- Completed artifacts to R2, feedback loop to Orchestrator

## Pipeline YAML (Draft Shape)

```yaml
name: code-review-pipeline
version: 1
model_defaults:
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  classification: claude-haiku-4-5-20251001

agents:
  - id: security-reviewer
    role: "Security engineer reviewing for vulnerabilities"
    model: execution
    tools: [grep, read, semgrep]
    memory: { max_tokens: 8000 }

  - id: perf-reviewer
    role: "Performance engineer reviewing for bottlenecks"
    model: execution
    tools: [grep, read, profiler]
    memory: { max_tokens: 8000 }

  - id: correctness-reviewer
    role: "Senior engineer reviewing for logic errors"
    model: planning
    tools: [grep, read, test-runner]
    memory: { max_tokens: 16000 }

  - id: synthesizer
    role: "Merge all review findings into a unified report"
    model: execution
    tools: []
    memory: { max_tokens: 4000 }

pipeline:
  - step: parallel-review
    agents: [security-reviewer, perf-reviewer, correctness-reviewer]
    mode: parallel

  - step: gate-quality
    type: gate
    condition: "all agents completed without hallucination flag"
    on_fail: retry(max=1)

  - step: synthesize
    agent: synthesizer
    inputs: [security-reviewer, perf-reviewer, correctness-reviewer]

  - step: human-review
    type: gate
    condition: "severity >= critical"
    on_match: escalate(channel: human)
    on_pass: output

recovery:
  default: retry(max=2, backoff=exponential)
  fallback: degrade(skip_failed_agent=true)
  escalation: human(channel: notification)
```

## Diagrams

See `docs/diagrams/` for Mermaid architecture diagrams:
- `execution-model.mmd` -- Supervisor + Agent DO topology
- `handoff-protocol.mmd` -- Message flow and R2 data plane
- `pipeline-lifecycle.mmd` -- State machine for pipeline runs
- `gate-circuit-breaker.mmd` -- Failure detection and recovery paths

## Open Questions

- [x] Dashboard tech: Hono + HTMX vs React SPA from R2? → Hono + HTMX + SSE
- [ ] Observability: structured logs to R2 vs external (Axiom/Baselime)?
- [x] Agent tool sandboxing: how do agents safely execute tools? → R2-scoped read-only access via `src/tools/sandbox.ts`; 10s wall-time cap; `semgrep`/`test-runner` are stubs (no real sandbox in Workers)
- [x] YAML schema validation: JSON Schema or Zod at deploy time? → Zod
- [ ] Pipeline versioning: how to handle YAML schema evolution?

## Lineage

This project formalizes patterns from:
- `~/.claude/memory/multi-agent-workflow.md` (cmux orchestration)
- `~/.claude/memory/multi-agent-workflows/` (feature-dev, research, code-review manifests)
- `~/.claude/memory/agentic-design-patterns.md` (21 patterns from Gulli)
