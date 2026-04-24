# AgentX Factory Phase 1 — Mission Plan

## Executive Summary

Build the AgentX Factory Core Engine: a Cloudflare Workers platform service that executes YAML-defined multi-agent pipelines. Supervisor DO manages DAG state and dispatches work via Queues to Agent DOs, which make Anthropic API calls and write artifacts to R2. Hono Worker provides the HTTP API and queue consumer routing.

4 milestones, 11 features, targeting full deploy with one working pipeline (code-review).

## Feature Table

| ID | Title | Deps | Milestone | Complexity |
|----|-------|------|-----------|------------|
| FEAT-001 | Project Scaffolding | — | M1 | low |
| FEAT-002 | Core Types | FEAT-001 | M1 | low |
| FEAT-003 | Envelope Helpers | FEAT-002 | M2 | low |
| FEAT-004 | YAML Schema Validation | FEAT-002 | M2 | medium |
| FEAT-005 | Gate Evaluator | FEAT-002 | M2 | low |
| FEAT-006 | Anthropic Client Wrapper | FEAT-002 | M2 | low |
| FEAT-007 | Agent Durable Object | FEAT-003, FEAT-006 | M3 | high |
| FEAT-008 | Supervisor Durable Object | FEAT-003, FEAT-004, FEAT-005 | M3 | high |
| FEAT-009 | Hono API Router + Queue Consumers | FEAT-007, FEAT-008 | M4 | medium |
| FEAT-010 | E2E Integration Tests | FEAT-009 | M4 | medium |
| FEAT-011 | Deploy Verification | FEAT-010 | M4 | low |

## Milestone Descriptions

### M1: Foundation
**Features:** FEAT-001, FEAT-002
**Validation:** `npx tsc --noEmit` passes. Wrangler compiles. Vitest initializes.
**Notes:** Sequential — scaffolding first, then types. Fast (~5 min).

### M2: Pure Logic Modules
**Features:** FEAT-003, FEAT-004, FEAT-005, FEAT-006
**Validation:** All 15 unit tests pass (`npx vitest run`). No type errors.
**Notes:** All 4 features can execute in parallel — they only depend on types.ts and have no cross-dependencies.

### M3: Durable Objects
**Features:** FEAT-007, FEAT-008
**Validation:** Agent DO + Supervisor DO integration tests pass via miniflare. DOs initialize SQLite, handle tasks, manage state.
**Notes:** Agent and Supervisor can execute in parallel — Agent depends on envelope + anthropic, Supervisor depends on envelope + schema + gate. No cross-dependency.

### M4: Integration & Deploy
**Features:** FEAT-009, FEAT-010, FEAT-011
**Validation:** Full E2E test suite passes. `wrangler deploy --dry-run` succeeds. Production smoke test passes.
**Notes:** Sequential within milestone — API router wraps DOs, E2E tests exercise the API, deploy requires passing tests.

## Dependency Graph

```
FEAT-001 (Scaffolding)
  └─▶ FEAT-002 (Types)
        ├─▶ FEAT-003 (Envelope)  ─────────┐
        ├─▶ FEAT-004 (Schema)    ──────┐  │
        ├─▶ FEAT-005 (Gate)      ───┐  │  │
        └─▶ FEAT-006 (Anthropic) ┐  │  │  │
                                 │  │  │  │
                                 ▼  │  │  ▼
                         FEAT-007 (Agent DO)
                                 │  ▼  ▼
                                 │  FEAT-008 (Supervisor DO)
                                 │  │
                                 ▼  ▼
                         FEAT-009 (API + Queues)
                                 │
                                 ▼
                         FEAT-010 (E2E Tests)
                                 │
                                 ▼
                         FEAT-011 (Deploy)
```

## Source Material

- Spec: `docs/superpowers/specs/2026-04-23-agentx-factory-design.md`
- Plan: `docs/superpowers/plans/2026-04-23-agentx-phase1-core-engine.md`
- Diagrams: `docs/diagrams/*.mmd`
