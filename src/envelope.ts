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
