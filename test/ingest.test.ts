import { describe, it, expect, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));

import worker from "../src/index";
import { ideaKvKey, seenKey, type IdeaV1 } from "../src/idea";

const API_TOKEN = "test-token";

const VERDICT_YAML = `
name: idea-to-verdict
version: 1
description: t
model_defaults:
  planning: a
  execution: b
  classification: c
agents:
  - id: extractor
    role: r
    model: execution
    tools: []
    memory:
      max_tokens: 100
pipeline:
  - step: extract
    agent: extractor
recovery: {}
budget:
  max_tokens: 1
  max_duration_ms: 1
  max_retries: 0
`;

function memoryKv(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    store: m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => {
      m.set(k, v);
    },
    delete: async (k: string) => {
      m.delete(k);
    },
    list: async () => ({ keys: [...m.keys()].map((name) => ({ name })) }),
  };
}

function fakeEnv(opts: {
  kv?: ReturnType<typeof memoryKv>;
  initializeRun?: ReturnType<typeof vi.fn>;
} = {}) {
  const kv = opts.kv ?? memoryKv();
  const initializeRun =
    opts.initializeRun ??
    vi.fn().mockResolvedValue({ success: true, runId: "run-1" });
  const r2 = { put: vi.fn().mockResolvedValue(undefined) };
  return {
    env: {
      API_TOKEN,
      PIPELINE_KV: kv,
      ARTIFACT_STORE: r2,
      SUPERVISOR: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ initializeRun }),
      },
      AGENT: {},
      CIRCUIT_BREAKER: {},
      DISPATCH_QUEUE: {},
      RESULT_QUEUE: {},
      ANTHROPIC_API_KEY: "test",
    } as any,
    kv,
    r2,
    initializeRun,
  };
}

function ingest(env: unknown, body: unknown) {
  return worker.fetch(
    new Request("http://example.com/api/ingest", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${API_TOKEN}` },
    }),
    env as any,
    {} as any
  );
}

describe("POST /api/ingest", () => {
  it("rejects invalid JSON with 400", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(
      new Request("http://example.com/api/ingest", {
        method: "POST",
        body: "{not json",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      }),
      env,
      {} as any
    );
    expect(res.status).toBe(400);
  });

  it("rejects a body-less idea with 400", async () => {
    const { env } = fakeEnv();
    const res = await ingest(env, { source: { kind: "form" } });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Invalid idea");
  });

  it("stores a held idea without starting a run", async () => {
    const { env, initializeRun, kv, r2 } = fakeEnv();
    const res = await ingest(env, { body: "park this", status: "held" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      status: string;
      run_id: string | null;
      idea: IdeaV1;
    };
    expect(json.status).toBe("stored");
    expect(json.run_id).toBeNull();
    expect(json.idea.body).toBe("park this");
    expect(initializeRun).not.toHaveBeenCalled();
    expect(kv.store.has(ideaKvKey(json.idea.id))).toBe(true);
    expect(r2.put).toHaveBeenCalled();
  });

  it("returns 503 after persisting when the verdict pipeline is missing", async () => {
    const { env, initializeRun } = fakeEnv();
    const res = await ingest(env, { body: "a real idea" });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string; idea: IdeaV1 };
    expect(json.error).toMatch(/idea-to-verdict/);
    expect(json.idea.id).toMatch(/^ide_/);
    expect(initializeRun).not.toHaveBeenCalled();
  });

  it("starts idea-to-verdict when the pipeline exists", async () => {
    const kv = memoryKv({ "pipeline:idea-to-verdict": VERDICT_YAML });
    const { env, initializeRun } = fakeEnv({ kv });
    const res = await ingest(env, {
      body: "narrow CLI for helm diffs",
      source: { kind: "form" },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      status: string;
      run_id: string | null;
      idea: IdeaV1;
    };
    expect(json.status).toBe("started");
    expect(json.run_id).toBeTruthy();
    expect(initializeRun).toHaveBeenCalledTimes(1);
    const args = initializeRun.mock.calls[0][0] as { pipelineYaml: string; input: IdeaV1 };
    expect(args.pipelineYaml).toContain("name: idea-to-verdict");
    expect(args.input.body).toBe("narrow CLI for helm diffs");
  });

  it("dedups X likes by tweet id and does not start a second run", async () => {
    const kv = memoryKv({ "pipeline:idea-to-verdict": VERDICT_YAML });
    const { env, initializeRun } = fakeEnv({ kv });
    const payload = {
      body: "liked this",
      source: { kind: "x_like", external_id: "2061" },
    };
    const first = await ingest(env, payload);
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as { idea: IdeaV1; run_id: string };
    const second = await ingest(env, payload);
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      status: string;
      idea: IdeaV1;
    };
    expect(secondJson.status).toBe("duplicate");
    expect(secondJson.idea.id).toBe(firstJson.idea.id);
    expect(initializeRun).toHaveBeenCalledTimes(1);
    expect(kv.store.get(seenKey("x_like", "2061"))).toBe(firstJson.idea.id);
  });
});

describe("GET /api/ideas/:id", () => {
  it("404s when missing", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(
      new Request("http://example.com/api/ideas/ide_00000000000000000000000000", {
        headers: { authorization: `Bearer ${API_TOKEN}` },
      }),
      env,
      {} as any
    );
    expect(res.status).toBe(404);
  });

  it("returns the stored record", async () => {
    const kv = memoryKv({ "pipeline:idea-to-verdict": VERDICT_YAML });
    const { env } = fakeEnv({ kv });
    const created = await ingest(env, { body: "fetch me" });
    const createdJson = (await created.json()) as { idea: IdeaV1 };
    const res = await worker.fetch(
      new Request(`http://example.com/api/ideas/${createdJson.idea.id}`, {
        headers: { authorization: `Bearer ${API_TOKEN}` },
      }),
      env,
      {} as any
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { idea: IdeaV1 };
    expect(json.idea.body).toBe("fetch me");
  });
});
