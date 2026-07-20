import type {
  Env,
  DagState,
  PipelineEvent,
  RunMetrics,
  HandoffEnvelope,
  CircuitBreakerStatus,
} from "./types";
import type { InitParams, InitResult } from "./supervisor";
import type { TaskParams, TaskResult } from "./agent";

/** Typed view of the Supervisor DO's RPC surface (Worker → DO). */
export interface SupervisorStub {
  initializeRun(params: InitParams): Promise<InitResult>;
  handleAgentCompletion(envelope: HandoffEnvelope): Promise<void>;
  handleAgentFailure(
    agentId: string,
    error: string,
    opts?: { skipBreaker?: boolean; retryCount?: number }
  ): Promise<void>;
  getState(): Promise<DagState>;
  getEvents(sinceId?: number | string): Promise<PipelineEvent[]>;
  getMetrics(): Promise<RunMetrics>;
}

/** Typed view of the Agent DO's RPC surface. */
export interface AgentStub {
  handleTask(params: TaskParams): Promise<TaskResult>;
  getStatus(): Promise<{ status: string }>;
}

/** Typed view of the CircuitBreaker DO's RPC surface. */
export interface BreakerStub {
  check(role: string): Promise<{ allowed: boolean; status: CircuitBreakerStatus }>;
  failure(role: string): Promise<CircuitBreakerStatus>;
  success(role: string): Promise<CircuitBreakerStatus>;
  getAll(): Promise<CircuitBreakerStatus[]>;
}

/** Acquire the Supervisor DO for a run, typed. */
export function getSupervisor(env: Env, runId: string): SupervisorStub {
  const id = env.SUPERVISOR.idFromName(runId);
  return env.SUPERVISOR.get(id) as unknown as SupervisorStub;
}

/**
 * Acquire an Agent DO by run + agent id, typed. Name matches the dispatch
 * convention `${runId}:${agentId}` used across the codebase.
 */
export function getAgent(env: Env, runId: string, agentId: string): AgentStub {
  const id = env.AGENT.idFromName(`${runId}:${agentId}`);
  return env.AGENT.get(id) as unknown as AgentStub;
}

/** Acquire the global CircuitBreaker DO, or null if the binding is absent. */
export function getBreaker(env: Env): BreakerStub | null {
  if (!env.CIRCUIT_BREAKER) return null;
  const id = env.CIRCUIT_BREAKER.idFromName("global");
  return env.CIRCUIT_BREAKER.get(id) as unknown as BreakerStub;
}

/**
 * Write the KV run-index entry recorded when a run starts.
 *
 * Used by both the JSON API and the HTMX UI start paths.
 */
export function writeRunIndex(
  env: Env,
  runId: string,
  pipeline: string,
  status = "started"
): Promise<void> {
  return env.PIPELINE_KV.put(
    `run:${runId}`,
    JSON.stringify({ pipeline, created_at: new Date().toISOString(), status })
  );
}
