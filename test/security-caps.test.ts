import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));

function post(env: unknown, path: string, body: string) {
  return worker.fetch(
    new Request(`http://example.com${path}`, { method: "POST", body }),
    env as any,
    {} as any
  );
}

const MINIMAL_PIPELINE_YAML = `
name: caps-test
version: 1
description: t
model_defaults:
  planning: a
  execution: b
  classification: c
agents:
  - id: solo
    role: r
    model: execution
    tools: []
    memory:
      max_tokens: 100
pipeline:
  - step: run
    agent: solo
recovery: {}
budget:
  max_tokens: 1
  max_duration_ms: 1
  max_retries: 0
`;

describe("SECURITY-05: request body caps and run-body validation", () => {
  it("rejects an oversized pipeline YAML body with 413", async () => {
    const res = await post({}, "/api/pipelines", "a".repeat(300 * 1024));
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("too large");
  });

  it("rejects an oversized run body with 413", async () => {
    const res = await post({}, "/api/runs", "a".repeat(600 * 1024));
    expect(res.status).toBe(413);
  });

  it("rejects invalid JSON in the run body with 400", async () => {
    const res = await post({}, "/api/runs", "{not json");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Invalid JSON");
  });

  it("rejects a run body missing the pipeline field with 400", async () => {
    const res = await post({}, "/api/runs", JSON.stringify({ input: { x: 1 } }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Invalid run request");
  });

  it("passes a valid run body through to the pipeline lookup", async () => {
    const env = { PIPELINE_KV: { get: async () => null } };
    const res = await post(env, "/api/runs", JSON.stringify({ pipeline: "nope", input: {} }));
    expect(res.status).toBe(404);
  });

  it("still accepts a valid, small pipeline upload", async () => {
    const env = { PIPELINE_KV: { put: async () => undefined } };
    const res = await post(env, "/api/pipelines", MINIMAL_PIPELINE_YAML);
    expect(res.status).toBe(201);
  });
});
