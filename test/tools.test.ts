import { describe, it, expect } from "vitest";
import {
  runToolCall,
  toolDefinitionsFor,
  listAvailableTools,
  type ToolContext,
} from "../src/tools/registry";
import { resolveArtifactKey } from "../src/tools/sandbox";

// ─── In-memory R2 stub ────────────────────────────

class StubR2 {
  private store = new Map<string, string>();
  put(key: string, body: string) {
    this.store.set(key, body);
  }
  get(key: string) {
    const v = this.store.get(key);
    if (v === undefined) return null;
    const data = new TextEncoder().encode(v).buffer;
    return {
      arrayBuffer: async () => data,
    } as unknown as R2ObjectBody;
  }
}

function ctxWith(seed: Record<string, string>): ToolContext {
  const r2 = new StubR2();
  for (const [k, v] of Object.entries(seed)) r2.put(k, v);
  return {
    runId: "run-1",
    env: { ARTIFACT_STORE: r2 } as any,
  };
}

// ─── Sandbox path resolution ──────────────────────

describe("sandbox.resolveArtifactKey", () => {
  it("scopes a relative path under runs/{runId}/", () => {
    expect(resolveArtifactKey("run-1", "agents/security/output.json")).toBe(
      "runs/run-1/agents/security/output.json"
    );
  });

  it("accepts a fully-qualified key when it matches the run", () => {
    expect(resolveArtifactKey("run-1", "runs/run-1/input.json")).toBe(
      "runs/run-1/input.json"
    );
  });

  it("rejects a key for a different run", () => {
    expect(() => resolveArtifactKey("run-1", "runs/run-2/input.json")).toThrow(/scoped/);
  });

  it("rejects path traversal", () => {
    expect(() => resolveArtifactKey("run-1", "../../etc/passwd")).toThrow(/traversal/);
  });

  it("rejects absolute paths", () => {
    expect(() => resolveArtifactKey("run-1", "/etc/passwd")).toThrow(/absolute/);
  });
});

// ─── Registry ─────────────────────────────────────

describe("registry.listAvailableTools", () => {
  it("exposes the expected tool catalog", () => {
    const list = listAvailableTools().sort();
    expect(list).toEqual(["grep", "read", "semgrep", "test-runner"]);
  });
});

describe("registry.toolDefinitionsFor", () => {
  it("returns definitions for requested tools only", () => {
    const defs = toolDefinitionsFor(["read", "grep"]);
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(["grep", "read"]);
    for (const d of defs) {
      expect(d.input_schema.type).toBe("object");
    }
  });

  it("ignores unknown tool names silently", () => {
    const defs = toolDefinitionsFor(["read", "nonexistent"]);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("read");
  });

  it("returns [] for empty input", () => {
    expect(toolDefinitionsFor([])).toEqual([]);
  });
});

// ─── runToolCall ──────────────────────────────────

describe("registry.runToolCall — read", () => {
  it("reads a scoped artifact", async () => {
    const ctx = ctxWith({
      "runs/run-1/agents/security/output.json": '{"findings": ["xss"]}',
    });
    const res = await runToolCall(
      { name: "read", input: { path: "agents/security/output.json" } },
      ctx
    );
    expect(res.is_error).toBeUndefined();
    expect(res.content).toContain("xss");
  });

  it("reports missing path", async () => {
    const ctx = ctxWith({});
    const res = await runToolCall({ name: "read", input: {} }, ctx);
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("path");
  });

  it("blocks reads outside the run scope", async () => {
    const ctx = ctxWith({});
    const res = await runToolCall(
      { name: "read", input: { path: "runs/run-2/secret.json" } },
      ctx
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("scoped");
  });

  it("blocks path traversal", async () => {
    const ctx = ctxWith({});
    const res = await runToolCall(
      { name: "read", input: { path: "../../etc/passwd" } },
      ctx
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("traversal");
  });
});

describe("registry.runToolCall — grep", () => {
  it("returns matching lines with line numbers", async () => {
    const ctx = ctxWith({
      "runs/run-1/agents/x/output.json": "alpha\nbeta\nGAMMA\ndelta",
    });
    const res = await runToolCall(
      {
        name: "grep",
        input: { path: "agents/x/output.json", pattern: "ga", flags: "i" },
      },
      ctx
    );
    expect(res.is_error).toBeUndefined();
    expect(res.content).toContain("3: GAMMA");
  });

  it("reports no matches without erroring", async () => {
    const ctx = ctxWith({ "runs/run-1/a.txt": "hello" });
    const res = await runToolCall(
      { name: "grep", input: { path: "a.txt", pattern: "zzz" } },
      ctx
    );
    expect(res.is_error).toBeUndefined();
    expect(res.content).toContain("no matches");
  });

  it("rejects invalid regex", async () => {
    const ctx = ctxWith({ "runs/run-1/a.txt": "x" });
    const res = await runToolCall(
      { name: "grep", input: { path: "a.txt", pattern: "[invalid" } },
      ctx
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("invalid regex");
  });
  it("rejects a catastrophic backtracking pattern", async () => {
    const ctx = ctxWith({ "runs/run-1/a.txt": "aaaa" });
    const res = await runToolCall(
      { name: "grep", input: { path: "a.txt", pattern: "(a+)+$" } },
      ctx
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("pattern rejected");
  });

  it("rejects an overlong pattern", async () => {
    const ctx = ctxWith({ "runs/run-1/a.txt": "x" });
    const res = await runToolCall(
      { name: "grep", input: { path: "a.txt", pattern: "a".repeat(200) } },
      ctx
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("pattern rejected");
  });

  it("rejects unsupported regex flags", async () => {
    const ctx = ctxWith({ "runs/run-1/a.txt": "x" });
    const res = await runToolCall(
      { name: "grep", input: { path: "a.txt", pattern: "x", flags: "y" } },
      ctx
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("unsupported regex flags");
  });
});

describe("registry.runToolCall — unknown tool", () => {
  it("returns an error result", async () => {
    const ctx = ctxWith({});
    const res = await runToolCall({ name: "shell", input: { cmd: "rm -rf /" } }, ctx);
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("Unknown");
  });
});

describe("registry.runToolCall — stubs", () => {
  it("semgrep returns stub message", async () => {
    const ctx = ctxWith({});
    const res = await runToolCall({ name: "semgrep", input: { rule: "x" } }, ctx);
    expect(res.is_error).toBeUndefined();
    expect(res.content).toContain("stubbed");
  });

  it("test-runner returns stub message", async () => {
    const ctx = ctxWith({});
    const res = await runToolCall({ name: "test-runner", input: {} }, ctx);
    expect(res.content).toContain("stubbed");
  });
});
