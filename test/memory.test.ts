import { describe, it, expect, beforeEach } from "vitest";
import { appendRunSummary, getPriorRuns } from "../src/memory";
import type { Env, RunMetrics } from "../src/types";

class StubKV {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function envWithKv(kv: StubKV): Env {
  return { PIPELINE_KV: kv as any } as Env;
}

function metrics(runId: string, status: RunMetrics["status"] = "completed"): RunMetrics {
  return {
    run_id: runId,
    pipeline_name: "code-review",
    status,
    total_tokens: 1000,
    total_duration_ms: 5000,
    total_retries: 0,
    agents_completed: 3,
    agents_failed: 0,
    gates_passed: 1,
    gates_failed: 0,
    recovery_attempts: 0,
    circuit_trips: 0,
    per_agent: [],
  };
}

describe("memory — appendRunSummary / getPriorRuns", () => {
  let kv: StubKV;
  let env: Env;

  beforeEach(() => {
    kv = new StubKV();
    env = envWithKv(kv);
  });

  it("appends a single summary and reads it back", async () => {
    await appendRunSummary(env, metrics("run-1"), "2026-05-03T00:00:00Z");
    const list = await getPriorRuns(env, "code-review", 5);
    expect(list).toHaveLength(1);
    expect(list[0].run_id).toBe("run-1");
    expect(list[0].status).toBe("completed");
    expect(list[0].completed_at).toBe("2026-05-03T00:00:00Z");
  });

  it("returns most recent runs first (newest unshifted)", async () => {
    await appendRunSummary(env, metrics("run-1"), "2026-05-01T00:00:00Z");
    await appendRunSummary(env, metrics("run-2"), "2026-05-02T00:00:00Z");
    await appendRunSummary(env, metrics("run-3"), "2026-05-03T00:00:00Z");

    const list = await getPriorRuns(env, "code-review", 5);
    expect(list.map((r) => r.run_id)).toEqual(["run-3", "run-2", "run-1"]);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await appendRunSummary(env, metrics(`run-${i}`), `2026-05-0${i + 1}`);
    }
    const list = await getPriorRuns(env, "code-review", 2);
    expect(list).toHaveLength(2);
  });

  it("excludes the current run when excludeRunId is set", async () => {
    await appendRunSummary(env, metrics("current"), "2026-05-03");
    await appendRunSummary(env, metrics("prior"), "2026-05-02");

    const list = await getPriorRuns(env, "code-review", 5, "current");
    expect(list.map((r) => r.run_id)).toEqual(["prior"]);
  });

  it("returns [] for unknown pipeline", async () => {
    expect(await getPriorRuns(env, "nonexistent", 5)).toEqual([]);
  });

  it("caps list at MAX_INDEX_ENTRIES", async () => {
    for (let i = 0; i < 60; i++) {
      await appendRunSummary(env, metrics(`run-${i}`), `t-${i}`);
    }
    const list = await getPriorRuns(env, "code-review", 100);
    expect(list.length).toBeLessThanOrEqual(50);
  });
});
