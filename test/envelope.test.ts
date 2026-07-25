import { describe, it, expect } from "vitest";
import { createDispatchEnvelope, createResultEnvelope, artifactKey, inputKey } from "../src/envelope";

describe("envelope", () => {
  describe("artifactKey", () => {
    it("builds R2 key from run ID and agent role", () => {
      const key = artifactKey("run-123", "security");
      expect(key).toBe("runs/run-123/agents/security/output.json");
    });

    it("accepts composed and dotted ids", () => {
      expect(artifactKey("run-1", "sec-review__scanner")).toBe(
        "runs/run-1/agents/sec-review__scanner/output.json"
      );
      expect(artifactKey("run-1", "agent.v2")).toBe(
        "runs/run-1/agents/agent.v2/output.json"
      );
    });

    it("rejects an agent role containing a path separator", () => {
      expect(() => artifactKey("run-1", "a/b")).toThrow(/unsafe key segment/);
    });

    it("rejects dots-only and empty segments", () => {
      expect(() => artifactKey("run-1", "..")).toThrow(/unsafe key segment/);
      expect(() => artifactKey("run-1", "")).toThrow(/unsafe key segment/);
    });
  });

  describe("inputKey", () => {
    it("rejects a runId containing a slash", () => {
      expect(() => inputKey("run/../x")).toThrow(/unsafe key segment/);
    });
  });

  describe("createDispatchEnvelope", () => {
    it("creates envelope with correct from/to and empty gate_results", () => {
      const env = createDispatchEnvelope({
        runId: "run-123",
        fromAgent: "supervisor",
        fromDoId: "sup-do-id",
        toAgent: "security",
        toDoId: "agent-do-id",
        inputRefs: ["runs/run-123/input.json"],
      });

      expect(env.pipeline_run).toBe("run-123");
      expect(env.from.agent).toBe("supervisor");
      expect(env.to.agent).toBe("security");
      expect(env.artifact_ref).toBe("");
      expect(env.context_window.parent_refs).toEqual(["runs/run-123/input.json"]);
      expect(env.gate_results).toEqual({});
      expect(env.metadata.retry_count).toBe(0);
      expect(env.id).toBeTruthy();
      expect(env.timestamp).toBeTruthy();
    });
  });

  describe("createResultEnvelope", () => {
    it("creates envelope with artifact ref and metadata", () => {
      const env = createResultEnvelope({
        runId: "run-123",
        agentRole: "security",
        agentDoId: "agent-do-id",
        supervisorDoId: "sup-do-id",
        tokensUsed: 4200,
        model: "claude-sonnet-4-6",
        durationMs: 8500,
        retryCount: 0,
      });

      expect(env.pipeline_run).toBe("run-123");
      expect(env.from.agent).toBe("security");
      expect(env.to.agent).toBe("supervisor");
      expect(env.artifact_ref).toBe("runs/run-123/agents/security/output.json");
      expect(env.metadata.tokens_used).toBe(4200);
      expect(env.metadata.model).toBe("claude-sonnet-4-6");
      expect(env.metadata.duration_ms).toBe(8500);
    });
  });
});
