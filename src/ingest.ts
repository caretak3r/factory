import type { Env } from "./types";
import { getSupervisor, writeRunIndex } from "./do-stubs";
import {
  normalizeIdea,
  dedupKey,
  ideaKvKey,
  ideaR2Key,
  shouldStartVerdictRun,
  type IdeaV1,
} from "./idea";

export const VERDICT_PIPELINE = "idea-to-verdict";

export interface StoredIdea {
  idea: IdeaV1;
  run_id: string | null;
  created_at: string;
}

export interface IngestResponse extends StoredIdea {
  status: "started" | "stored" | "duplicate";
  error?: string;
}

export interface IngestResult {
  httpStatus: number;
  body: IngestResponse | { error: string; details?: string[] };
}

async function persistIdea(
  env: Env,
  idea: IdeaV1,
  runId: string | null
): Promise<StoredIdea> {
  const record: StoredIdea = {
    idea,
    run_id: runId,
    created_at: new Date().toISOString(),
  };
  const payload = JSON.stringify(record);
  await env.PIPELINE_KV.put(ideaKvKey(idea.id), payload);
  const seen = dedupKey(idea);
  if (seen) {
    await env.PIPELINE_KV.put(seen, idea.id);
  }
  await env.ARTIFACT_STORE.put(ideaR2Key(idea.id), payload);
  return record;
}

export async function ingestIdea(env: Env, raw: unknown): Promise<IngestResult> {
  const normalized = normalizeIdea(raw);
  if (!normalized.success) {
    return {
      httpStatus: 400,
      body: { error: "Invalid idea", details: normalized.errors },
    };
  }
  const idea = normalized.data;

  const seen = dedupKey(idea);
  if (seen) {
    const existingId = await env.PIPELINE_KV.get(seen);
    if (existingId) {
      const existingRaw = await env.PIPELINE_KV.get(ideaKvKey(existingId));
      if (existingRaw) {
        const existing = JSON.parse(existingRaw) as StoredIdea;
        return {
          httpStatus: 200,
          body: { ...existing, status: "duplicate" },
        };
      }
    }
  }

  if (!shouldStartVerdictRun(idea)) {
    const stored = await persistIdea(env, idea, null);
    return { httpStatus: 201, body: { ...stored, status: "stored" } };
  }

  const yaml = await env.PIPELINE_KV.get(`pipeline:${VERDICT_PIPELINE}`);
  if (!yaml) {
    const stored = await persistIdea(env, idea, null);
    return {
      httpStatus: 503,
      body: {
        ...stored,
        status: "stored",
        error: `Pipeline "${VERDICT_PIPELINE}" not found`,
      },
    };
  }

  const runId = crypto.randomUUID();
  const supervisor = getSupervisor(env, runId);
  const result = await supervisor.initializeRun({
    runId,
    pipelineYaml: yaml,
    input: idea,
  });
  if (!result.success) {
    return { httpStatus: 400, body: { error: result.error ?? "initializeRun failed" } };
  }
  await writeRunIndex(env, runId, VERDICT_PIPELINE);
  const stored = await persistIdea(env, idea, runId);
  return { httpStatus: 201, body: { ...stored, status: "started" } };
}

export async function loadIdea(
  env: Env,
  id: string
): Promise<StoredIdea | null> {
  const raw = await env.PIPELINE_KV.get(ideaKvKey(id));
  if (!raw) return null;
  return JSON.parse(raw) as StoredIdea;
}
