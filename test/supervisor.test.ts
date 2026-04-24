import { describe, it, expect } from "vitest";
import type { InitParams, InitResult } from "../src/supervisor";

describe("Supervisor DO", () => {
  it("InitParams interface has required fields", () => {
    const params: InitParams = {
      runId: "run-123",
      pipelineYaml: "name: test\nversion: 1",
      input: { diff: "console.log('hello')" },
    };

    expect(params.runId).toBe("run-123");
    expect(params.pipelineYaml).toContain("test");
    expect(params.input).toHaveProperty("diff");
  });

  it("InitResult interface represents success", () => {
    const result: InitResult = {
      success: true,
      runId: "run-123",
    };
    expect(result.success).toBe(true);
    expect(result.runId).toBe("run-123");
  });

  it("InitResult interface represents failure", () => {
    const result: InitResult = {
      success: false,
      error: "YAML validation failed",
    };
    expect(result.success).toBe(false);
    expect(result.error).toContain("YAML");
  });
});
