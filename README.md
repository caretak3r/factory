# AgentX Factory

Multi-agent pipeline orchestration on Cloudflare Workers. Define agent workflows in YAML, deploy to the edge, get durable execution with automatic failure recovery.

## What it does

You write a YAML file that describes a pipeline of LLM agents. Each agent has a role, a model tier, and a memory budget. The factory spins up isolated Durable Objects for each agent, dispatches work through Queues, evaluates quality gates between steps, and collects the results into R2.

```yaml
agents:
  - id: security
    role: Review the diff for vulnerabilities
    model: execution
  - id: performance
    role: Review the diff for bottlenecks
    model: execution
  - id: synthesizer
    role: Merge all findings into one report
    model: planning

pipeline:
  - step: review
    agents: [security, performance]
    mode: parallel
  - step: gate
    type: gate
    condition: all_agents_completed
  - step: synthesize
    agent: synthesizer
    inputs: [security, performance]
```

One API call starts the pipeline. Each agent runs independently, writes its output to R2, and reports back to a Supervisor that tracks the whole DAG. If an agent fails, the Supervisor retries it. If the gate fails, the pipeline stops cleanly with a full audit trail.

## Architecture

![Execution Model](docs/diagrams/execution-model.svg)

A **Supervisor Durable Object** owns the pipeline state machine. It parses the YAML into a DAG, creates an **Agent Durable Object** per agent, and dispatches tasks through Cloudflare Queues. Agents make Anthropic API calls, write artifacts to R2, and report completions back via a result queue. The Supervisor evaluates gates and decides what happens next.

Every piece of state lives in the right place:
- Agent memory → Agent DO's SQLite (isolated, no shared state)
- Pipeline DAG → Supervisor DO's SQLite (single source of truth)
- Artifacts → R2 (unlimited size, exact-key reads)
- Config → KV (pipeline YAML, runtime settings)
- Task dispatch → Queues (reliable delivery, built-in retry)

### Handoff Protocol

![Handoff Protocol](docs/diagrams/handoff-protocol.svg)

Control flow routes through the Supervisor. Data flows through R2. Queue messages carry lightweight envelopes (< 1KB) with R2 references — never the actual payloads. This sidesteps the 128KB Queue message limit and keeps the control plane lean.

### Pipeline Lifecycle

![Pipeline Lifecycle](docs/diagrams/pipeline-lifecycle.svg)

Pipelines move through a state machine: Submitted → Validating → Planning → Dispatching → Running → GateCheck → Completing → Completed. Failed agents trigger a Recovery sub-state-machine with retry, fallback, and human escalation paths.

### Gates and Circuit Breakers

![Gates and Circuit Breakers](docs/diagrams/gate-circuit-breaker.svg)

Gates are Supervisor state transitions, not separate services. They fire on token budget overruns, agent timeouts, hallucination flags, or schema validation failures. Circuit breakers track per-agent-role failure rates and fast-fail when an agent is consistently broken.

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers |
| Agent state | Durable Objects (transactional SQLite) |
| Task dispatch | Cloudflare Queues |
| Artifacts | R2 |
| Config | KV |
| LLM | Anthropic (Claude Opus / Sonnet / Haiku) |
| HTTP framework | Hono |
| Validation | Zod |
| Tests | Vitest |

## API

```
POST   /api/pipelines              Upload pipeline YAML
GET    /api/pipelines              List pipelines
GET    /api/pipelines/:name        Get pipeline YAML
DELETE /api/pipelines/:name        Delete pipeline

POST   /api/runs                   Start a pipeline run
GET    /api/runs                   List runs
GET    /api/runs/:id               Get run state (DAG, agent statuses, metrics)
GET    /api/runs/:id/events        Get pipeline event log
GET    /api/runs/:id/artifacts/:key Download an artifact

GET    /api/health                 Health check
```

## Quick start

```bash
# Install
npm install

# Run tests
npx vitest run

# Local dev
npx wrangler dev

# Deploy (requires Cloudflare account setup — see below)
npx wrangler deploy
```

### First deploy

```bash
# Create Cloudflare resources
npx wrangler kv namespace create PIPELINE_KV
# Update wrangler.toml with the returned namespace ID

npx wrangler r2 bucket create agentx-artifacts
npx wrangler queues create agentx-dispatch
npx wrangler queues create agentx-results
npx wrangler queues create agentx-dlq

# Set your Anthropic API key
npx wrangler secret put ANTHROPIC_API_KEY

# Deploy
npx wrangler deploy
```

### Run a pipeline

```bash
URL="https://agentx-factory.YOUR_SUBDOMAIN.workers.dev"

# Upload the built-in code review pipeline
curl -X POST $URL/api/pipelines -d @pipelines/code-review.yaml

# Start a review
curl -X POST $URL/api/runs \
  -H "Content-Type: application/json" \
  -d '{"pipeline":"code-review","input":{"diff":"+ const x = eval(userInput)"}}'

# Check status (use the run_id from above)
curl $URL/api/runs/RUN_ID
```

## Project structure

```
src/
  index.ts          Hono Worker — API routes + queue consumers
  supervisor.ts     Supervisor DO — DAG state machine
  agent.ts          Agent DO — LLM execution + R2 artifacts
  schema.ts         YAML validation (Zod)
  envelope.ts       Handoff envelope helpers
  gate.ts           Gate evaluation logic
  anthropic.ts      Anthropic API wrapper
  types.ts          Shared types
pipelines/
  code-review.yaml  Built-in parallel code review pipeline
test/
  *.test.ts         28 tests across 7 files
```

## Status

Phase 1 (Core Engine) is complete. The system can run multi-agent pipelines end-to-end with parallel execution, gate evaluation, and durable state.

Planned:
- **Phase 2**: Circuit breakers, layered recovery, structured event logging, per-run metrics
- **Phase 3**: HTMX dashboard, multi-turn agents, agent tool use
- **Phase 4**: Conditional DAG branching, agent gossip, pipeline composition, cross-run memory
