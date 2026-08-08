import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";
import { resolveArtifactKey } from "../src/tools/sandbox";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));

class RouteR2 {
  readonly getCalls: string[] = [];

  constructor(private readonly store: Record<string, string>) {}

  async get(key: string) {
    this.getCalls.push(key);
    const value = this.store[key];
    if (value === undefined) return null;
    return {
      text: async () => value,
    } as unknown as R2ObjectBody;
  }
}

function routeEnv(seed: Record<string, string> = {}) {
  const r2 = new RouteR2(seed);
  return {
    env: { ARTIFACT_STORE: r2 } as any,
    r2,
  };
}

function fetchArtifact(env: unknown, runId: string, keyPath: string) {
  return worker.fetch(
    new Request(`http://example.com/api/runs/${runId}/artifacts/${keyPath}`),
    env as any,
    {} as any
  );
}

describe("resolveArtifactKey - HTTP artifact route scoping", () => {
  const run = "run-A";

  it("accepts a fully-qualified key for its own run", () => {
    expect(resolveArtifactKey(run, "runs/run-A/agents/x/output.json")).toBe(
      "runs/run-A/agents/x/output.json"
    );
  });

  it("rejects a key scoped to a different run", () => {
    expect(() =>
      resolveArtifactKey(run, "runs/run-B/agents/x/output.json")
    ).toThrow(/scoped to runs\/run-A\//);
  });

  it("rejects path traversal and absolute keys", () => {
    expect(() =>
      resolveArtifactKey(run, "runs/run-A/../run-B/x")
    ).toThrow(/traversal/);
    expect(() => resolveArtifactKey(run, "/etc/passwd")).toThrow(/absolute/);
  });

  it("resolves a bare relative key under the run prefix", () => {
    expect(resolveArtifactKey(run, "agents/x/output.json")).toBe(
      "runs/run-A/agents/x/output.json"
    );
  });
});

describe("GET /api/runs/:id/artifacts/:key{.+}", () => {
  it("serves a fully-qualified key for its own run", async () => {
    const { env, r2 } = routeEnv({
      "runs/run-A/agents/x/output.json": '{"ok":true}',
    });

    const response = await fetchArtifact(
      env,
      "run-A",
      "runs/run-A/agents/x/output.json"
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(r2.getCalls).toEqual(["runs/run-A/agents/x/output.json"]);
  });

  it("resolves a bare relative key before reading R2", async () => {
    const { env, r2 } = routeEnv({
      "runs/run-A/agents/x/output.json": '{"ok":true}',
    });

    const response = await fetchArtifact(
      env,
      "run-A",
      "agents/x/output.json"
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(r2.getCalls).toEqual(["runs/run-A/agents/x/output.json"]);
  });

  it("rejects a cross-run key before reading R2", async () => {
    const { env, r2 } = routeEnv({
      "runs/run-B/agents/x/output.json": '{"secret":true}',
    });

    const response = await fetchArtifact(
      env,
      "run-A",
      "runs/run-B/agents/x/output.json"
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "path must be scoped to runs/run-A/",
    });
    expect(r2.getCalls).toEqual([]);
  });

  it("rejects traversal and absolute keys before reading R2", async () => {
    const traversal = routeEnv();
    const traversalResponse = await fetchArtifact(
      traversal.env,
      "run-A",
      "agents/..hidden/output.json"
    );

    expect(traversalResponse.status).toBe(400);
    expect(await traversalResponse.json()).toEqual({
      error: "path traversal blocked",
    });
    expect(traversal.r2.getCalls).toEqual([]);

    const absolute = routeEnv();
    const absoluteResponse = await fetchArtifact(
      absolute.env,
      "run-A",
      "%2Fetc/passwd"
    );

    expect(absoluteResponse.status).toBe(400);
    expect(await absoluteResponse.json()).toEqual({
      error: "absolute path not allowed",
    });
    expect(absolute.r2.getCalls).toEqual([]);
  });
});
