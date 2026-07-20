import { describe, it, expect } from "vitest";
import { getSupervisor, getAgent, getBreaker, writeRunIndex } from "../src/do-stubs";
import type { Env } from "../src/types";

interface NameRecord {
  name?: string;
}

function fakeNamespace(record: NameRecord): DurableObjectNamespace {
  const stub = { marker: "stub" };
  return {
    idFromName: (name: string) => {
      record.name = name;
      return { toString: () => name };
    },
    get: () => stub,
  } as unknown as DurableObjectNamespace;
}

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUPERVISOR: fakeNamespace({}),
    AGENT: fakeNamespace({}),
    CIRCUIT_BREAKER: fakeNamespace({}),
    PIPELINE_KV: {} as Env["PIPELINE_KV"],
    ARTIFACT_STORE: {} as Env["ARTIFACT_STORE"],
    DISPATCH_QUEUE: {} as Env["DISPATCH_QUEUE"],
    RESULT_QUEUE: {} as Env["RESULT_QUEUE"],
    ANTHROPIC_API_KEY: "test",
    ...overrides,
  };
}

describe("do-stubs accessors", () => {
  it("getSupervisor names the DO by run id", () => {
    const rec: NameRecord = {};
    const env = fakeEnv({ SUPERVISOR: fakeNamespace(rec) });

    getSupervisor(env, "run-123");

    expect(rec.name).toBe("run-123");
  });

  it("getAgent names the DO as `${runId}:${agentId}`", () => {
    const rec: NameRecord = {};
    const env = fakeEnv({ AGENT: fakeNamespace(rec) });

    getAgent(env, "run-123", "security");

    expect(rec.name).toBe("run-123:security");
  });

  it("getBreaker returns null when the binding is absent", () => {
    const env = fakeEnv({
      CIRCUIT_BREAKER: undefined as unknown as Env["CIRCUIT_BREAKER"],
    });

    expect(getBreaker(env)).toBeNull();
  });

  it("getBreaker names the global breaker when present", () => {
    const rec: NameRecord = {};
    const env = fakeEnv({ CIRCUIT_BREAKER: fakeNamespace(rec) });

    getBreaker(env);

    expect(rec.name).toBe("global");
  });

  it("writeRunIndex puts the run-index entry with the expected shape", async () => {
    let putKey = "";
    let putVal = "";
    const env = fakeEnv({
      PIPELINE_KV: {
        put: async (key: string, value: string) => {
          putKey = key;
          putVal = value;
        },
      } as unknown as Env["PIPELINE_KV"],
    });

    await writeRunIndex(env, "run-abc", "code-review");

    expect(putKey).toBe("run:run-abc");
    const parsed = JSON.parse(putVal);
    expect(parsed.pipeline).toBe("code-review");
    expect(parsed.status).toBe("started");
    expect(typeof parsed.created_at).toBe("string");
  });
});
