export interface Env {
  SUPERVISOR: DurableObjectNamespace;
  AGENT: DurableObjectNamespace;
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
