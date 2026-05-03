export interface Env {
  SUPERVISOR: DurableObjectNamespace;
  AGENT: DurableObjectNamespace;
  CIRCUIT_BREAKER: DurableObjectNamespace;
  PIPELINE_KV: KVNamespace;
  ARTIFACT_STORE: R2Bucket;
  DISPATCH_QUEUE: Queue;
  RESULT_QUEUE: Queue;
  ANTHROPIC_API_KEY: string;
}

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

export interface ModelDefaults {
  planning: string;
  execution: string;
  classification: string;
}

export interface AgentTurnsConfig {
  /** Hard cap on the number of LLM turns this agent runs */
  max: number;
  /** If the assistant's text response contains this substring, end the loop early */
  stop_when?: string;
}

export interface GossipPolicy {
  /** Peer agent ids whose artifacts this agent wants to read mid-run */
  read_peers?: string[];
  /** Whether this agent's own artifact may be read by peers ('public') or not ('private') */
  expose?: "public" | "private";
}

export interface MemoryAgentConfig {
  /** When true, prior runs' summaries for the same pipeline are fetched into the prompt */
  include_prior_runs?: boolean;
  /** Cap on the number of prior-run summaries to include (default 3) */
  max_prior_runs?: number;
}

export interface AgentConfig {
  id: string;
  role: string;
  model: string;
  tools: string[];
  memory: { max_tokens: number } & MemoryAgentConfig;
  fallback?: string;
  /** When set, the agent runs as a multi-turn conversation up to `turns.max` */
  turns?: AgentTurnsConfig;
  /** Phase 4: cross-agent visibility controls */
  gossip?: GossipPolicy;
}

/** A peer artifact passed alongside the dispatch when the agent has gossip.read_peers configured */
export interface PeerArtifact {
  agent_id: string;
  artifact_ref: string;
}

/** A single turn captured in agent.history */
export interface TurnRecord {
  turn_index: number;
  role: "user" | "assistant" | "tool_result";
  content: string;
  tokens?: { input: number; output: number };
  model?: string;
  stop_reason?: string | null;
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
  /** Optional whitelist-DSL expression (Phase 4). Step is skipped when expression is false. */
  when?: string;
  /** When set, this step expands into the imported pipeline's steps with this prefix. */
  import?: string;
}

// ─── Structured recovery (Phase 2) ─────────────────
// Replaces the v1 string DSL ("retry(max=2, backoff=exponential)")
// with typed objects.

export type BackoffStrategy = "exponential" | "linear" | "constant";

export interface RetryPolicy {
  max: number;
  backoff: BackoffStrategy;
  /** Base delay in ms; exponential = base * 2^n + jitter */
  base_ms?: number;
  /** Hard cap on a single backoff in ms (default 30000) */
  cap_ms?: number;
}

export interface FallbackPolicy {
  /** When true, the failed agent is skipped and downstream proceeds without its output */
  skip_failed_agent?: boolean;
  /** When set, dispatch this agent id in place of the failed one (overrides agent.fallback) */
  use_agent?: string;
}

export interface EscalationPolicy {
  channel: "notification" | "email" | "webhook" | "human";
  /** Optional target — webhook URL, email, slack channel, etc. */
  target?: string;
}

export interface RecoveryConfig {
  default?: RetryPolicy;
  fallback?: FallbackPolicy;
  escalation?: EscalationPolicy;
}

export type RecoveryAction =
  | { kind: "retry"; delay_ms: number; attempt: number }
  | { kind: "fallback"; agent_id: string | null; skip: boolean }
  | { kind: "escalate"; channel: EscalationPolicy["channel"]; target?: string }
  | { kind: "fail"; reason: string };

// ─── Circuit breaker (Phase 2) ─────────────────────

export type CircuitBreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerStatus {
  role: string;
  state: CircuitBreakerState;
  failures_in_window: number;
  last_failure_at: string | null;
  opened_at: string | null;
}

// ─── Run metrics (Phase 2) ─────────────────────────

export interface AgentMetrics {
  agent_id: string;
  status: AgentStatus;
  tokens_used: number;
  duration_ms: number;
  retry_count: number;
  model: string | null;
}

export interface RunMetrics {
  run_id: string;
  pipeline_name: string;
  status: RunStatus;
  total_tokens: number;
  total_duration_ms: number;
  total_retries: number;
  agents_completed: number;
  agents_failed: number;
  gates_passed: number;
  gates_failed: number;
  recovery_attempts: number;
  circuit_trips: number;
  per_agent: AgentMetrics[];
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
  /** Model the agent last ran with — populated on completion */
  model?: string;
  /** Most recent recovery action emitted for this node */
  last_recovery?: RecoveryAction;
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

export type PipelineEventType =
  | "dispatch"
  | "completion"
  | "gate_eval"
  | "recovery"
  | "recovery_attempt"
  | "circuit_trip"
  | "escalation"
  | "step_skipped"
  | "error"
  | "state_transition";

export interface PipelineEvent {
  id: string;
  run_id: string;
  timestamp: string;
  event_type: PipelineEventType;
  agent_role?: string;
  details: Record<string, unknown>;
}

export interface DispatchMessage {
  type: "dispatch";
  envelope: HandoffEnvelope;
  agent_config: AgentConfig;
  model_defaults: ModelDefaults;
  /** Peer artifacts the agent is permitted to read mid-run (Phase 4 gossip) */
  peers?: PeerArtifact[];
  /** Prior-run summaries to seed the prompt (Phase 4 cross-run memory) */
  prior_runs?: PriorRunSummary[];
}

export interface PriorRunSummary {
  run_id: string;
  pipeline_name: string;
  status: RunStatus;
  total_tokens: number;
  total_duration_ms: number;
  agents_completed: number;
  agents_failed: number;
  completed_at: string;
}

export interface ResultMessage {
  type: "result";
  envelope: HandoffEnvelope;
  supervisor_do_id: string;
}
