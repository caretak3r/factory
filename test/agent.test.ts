import { describe, it, expect } from "vitest";
import type { TaskParams, TaskResult } from "../src/agent";

describe("Agent DO", () => {
  it("TaskParams interface has required fields", () => {
    const params: TaskParams = {
      runId: "run-123",
      agentConfig: {
        id: "security",
        role: "Review for vulnerabilities",
        model: "execution",
        tools: [],
        memory: { max_tokens: 8000 },
      },
      modelDefaults: {
        planning: "claude-opus-4-6",
        execution: "claude-sonnet-4-6",
        classification: "claude-haiku-4-5-20251001",
      },
      inputRefs: ["runs/run-123/input.json"],
      supervisorDoId: "sup-123",
      retryCount: 0,
    };

    expect(params.runId).toBe("run-123");
    expect(params.agentConfig.id).toBe("security");
    expect(params.inputRefs).toHaveLength(1);
  });

  it("TaskResult interface represents success", () => {
    const result: TaskResult = {
      success: true,
      artifactRef: "runs/run-123/agents/security/output.json",
      tokensUsed: 4200,
      model: "claude-sonnet-4-6",
      durationMs: 8500,
    };

    expect(result.success).toBe(true);
    expect(result.tokensUsed).toBe(4200);
  });

  it("TaskResult interface represents failure", () => {
    const result: TaskResult = {
      success: false,
      error: "API key invalid",
      durationMs: 100,
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain("API key");
  });
});
