import type { HandoffEnvelope } from "./types";

/**
 * R2 key-segment charset authority (SECURITY-04). Every value interpolated
 * into an R2 key must be non-empty, drawn from [A-Za-z0-9._-], and must not
 * consist solely of dots. schema.ts enforces the same rule on agent ids at
 * the config boundary; validatePipelineConfig re-checks post-`import:`
 * composed ids (step-prefix + "__" + id).
 */
export const SAFE_KEY_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function isSafeKeySegment(value: string): boolean {
  return SAFE_KEY_SEGMENT_RE.test(value) && !/^\.+$/.test(value);
}

function assertSafeKeySegment(label: string, value: string): void {
  if (!isSafeKeySegment(value)) {
    throw new Error(`unsafe key segment for ${label}: "${value}"`);
  }
}

export function artifactKey(runId: string, agentRole: string): string {
  assertSafeKeySegment("runId", runId);
  assertSafeKeySegment("agentRole", agentRole);
  return `runs/${runId}/agents/${agentRole}/output.json`;
}

export function inputKey(runId: string): string {
  assertSafeKeySegment("runId", runId);
  return `runs/${runId}/input.json`;
}


interface DispatchEnvelopeParams {
  runId: string;
  fromAgent: string;
  fromDoId: string;
  toAgent: string;
  toDoId: string;
  inputRefs: string[];
  retryCount?: number;
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
    metadata: {
      tokens_used: 0,
      model: "",
      duration_ms: 0,
      retry_count: params.retryCount ?? 0,
    },
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
