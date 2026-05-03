import type {
  Env,
  PriorRunSummary,
  RunMetrics,
} from "./types";

const INDEX_PREFIX = "memory:";
const MAX_INDEX_ENTRIES = 50;

/**
 * Cross-run memory store, KV-backed.
 *
 * Indexed by pipeline name. Each entry is a small JSON summary of a past run's
 * outcome. Read-only for agents — they can't append (avoids feedback loops).
 * The supervisor calls `appendRunSummary` when a run terminates.
 */

export async function appendRunSummary(
  env: Env,
  metrics: RunMetrics,
  completedAt: string
): Promise<void> {
  if (!env.PIPELINE_KV || !metrics.pipeline_name) return;
  const key = `${INDEX_PREFIX}${metrics.pipeline_name}`;
  const existing = await env.PIPELINE_KV.get(key);
  const list: PriorRunSummary[] = existing ? JSON.parse(existing) : [];

  list.unshift({
    run_id: metrics.run_id,
    pipeline_name: metrics.pipeline_name,
    status: metrics.status,
    total_tokens: metrics.total_tokens,
    total_duration_ms: metrics.total_duration_ms,
    agents_completed: metrics.agents_completed,
    agents_failed: metrics.agents_failed,
    completed_at: completedAt,
  });

  if (list.length > MAX_INDEX_ENTRIES) list.length = MAX_INDEX_ENTRIES;
  await env.PIPELINE_KV.put(key, JSON.stringify(list));
}

export async function getPriorRuns(
  env: Env,
  pipelineName: string,
  limit = 3,
  excludeRunId?: string
): Promise<PriorRunSummary[]> {
  if (!env.PIPELINE_KV || !pipelineName) return [];
  const key = `${INDEX_PREFIX}${pipelineName}`;
  const existing = await env.PIPELINE_KV.get(key);
  if (!existing) return [];
  const list: PriorRunSummary[] = JSON.parse(existing);
  return list
    .filter((r) => r.run_id !== excludeRunId)
    .slice(0, Math.max(0, limit));
}
