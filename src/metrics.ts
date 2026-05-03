import type {
  AgentMetrics,
  DagState,
  PipelineEvent,
  RunMetrics,
} from "./types";

/**
 * Aggregate per-run metrics from a DAG snapshot + the run's event log.
 *
 * Tokens, durations, retry counts: read from DagNode (already maintained by supervisor).
 * Gate pass/fail, recovery attempts, circuit trips: read from the events table.
 * Pure: deterministic given the same inputs.
 */
export function aggregateMetrics(dag: DagState, events: PipelineEvent[]): RunMetrics {
  const perAgent: AgentMetrics[] = Object.values(dag.nodes).map((n) => ({
    agent_id: n.agent_id,
    status: n.status,
    tokens_used: n.tokens_used,
    duration_ms: n.duration_ms,
    retry_count: n.retry_count,
    model: n.model ?? null,
  }));

  let agentsCompleted = 0;
  let agentsFailed = 0;
  let totalRetries = 0;
  for (const a of perAgent) {
    if (a.status === "completed") agentsCompleted++;
    else if (a.status === "failed") agentsFailed++;
    totalRetries += a.retry_count;
  }

  let gatesPassed = 0;
  let gatesFailed = 0;
  let recoveryAttempts = 0;
  let circuitTrips = 0;
  for (const e of events) {
    if (e.event_type === "gate_eval") {
      if (e.details.pass === true) gatesPassed++;
      else gatesFailed++;
    } else if (e.event_type === "recovery_attempt" || e.event_type === "recovery") {
      recoveryAttempts++;
    } else if (e.event_type === "circuit_trip") {
      circuitTrips++;
    }
  }

  return {
    run_id: dag.run_id,
    pipeline_name: dag.pipeline_name,
    status: dag.status,
    total_tokens: dag.total_tokens,
    total_duration_ms: dag.total_duration_ms,
    total_retries: totalRetries,
    agents_completed: agentsCompleted,
    agents_failed: agentsFailed,
    gates_passed: gatesPassed,
    gates_failed: gatesFailed,
    recovery_attempts: recoveryAttempts,
    circuit_trips: circuitTrips,
    per_agent: perAgent,
  };
}
