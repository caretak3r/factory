import type { Env } from "../types";

const MAX_TOOL_DURATION_MS = 10_000;
const MAX_READ_BYTES = 256 * 1024;

/**
 * Resolve and validate an artifact key supplied by the model.
 *
 * Must be scoped under the current run: `runs/{runId}/...`. Anything else is
 * rejected — this is the only path that touches R2 from inside a tool, so it's
 * the single chokepoint for blast-radius control.
 */
export function resolveArtifactKey(runId: string, requested: string): string {
  if (typeof requested !== "string") throw new Error("path must be a string");
  if (requested.includes("..")) throw new Error("path traversal blocked");
  if (requested.startsWith("/")) throw new Error("absolute path not allowed");

  const expectedPrefix = `runs/${runId}/`;
  // Accept either a fully-qualified key or a relative-to-run path.
  if (requested.startsWith("runs/")) {
    if (!requested.startsWith(expectedPrefix)) {
      throw new Error(`path must be scoped to runs/${runId}/`);
    }
    return requested;
  }
  return expectedPrefix + requested;
}

/** Read an R2 artifact with size + path enforcement. */
export async function readScopedArtifact(
  env: Env,
  runId: string,
  requestedPath: string
): Promise<string> {
  const key = resolveArtifactKey(runId, requestedPath);
  const obj = await env.ARTIFACT_STORE.get(key);
  if (!obj) throw new Error(`Artifact not found: ${key}`);

  const ab = await obj.arrayBuffer();
  if (ab.byteLength > MAX_READ_BYTES) {
    return new TextDecoder().decode(ab.slice(0, MAX_READ_BYTES)) +
      `\n\n[truncated: ${ab.byteLength} bytes total, capped at ${MAX_READ_BYTES}]`;
  }
  return new TextDecoder().decode(ab);
}

/** Run a tool handler with a hard wall-clock timeout. */
export async function withTimeout<T>(promise: Promise<T>, ms = MAX_TOOL_DURATION_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`tool exceeded ${ms}ms timeout`)), ms)
    ),
  ]);
}
