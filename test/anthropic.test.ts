import { describe, it, expect } from "vitest";
import { resolveModel, buildPrompt } from "../src/anthropic";
import type { ModelDefaults, AgentConfig } from "../src/types";

const defaults: ModelDefaults = {
  planning: "claude-opus-4-6",
  execution: "claude-sonnet-4-6",
  classification: "claude-haiku-4-5-20251001",
};

describe("anthropic", () => {
  describe("resolveModel", () => {
    it("resolves tier keyword to model ID", () => {
      expect(resolveModel("planning", defaults)).toBe("claude-opus-4-6");
      expect(resolveModel("execution", defaults)).toBe("claude-sonnet-4-6");
      expect(resolveModel("classification", defaults)).toBe("claude-haiku-4-5-20251001");
    });

    it("passes through explicit model ID unchanged", () => {
      expect(resolveModel("claude-opus-4-6", defaults)).toBe("claude-opus-4-6");
    });
  });

  describe("buildPrompt", () => {
    it("builds system + user messages from agent config and input", () => {
      const agent: AgentConfig = {
        id: "security",
        role: "Security engineer. Review for vulnerabilities.",
        model: "execution",
        tools: [],
        memory: { max_tokens: 8000 },
      };
      const input = "Here is the diff:\n+console.log(password)";
      const messages = buildPrompt(agent, input);

      expect(messages.system).toBe("Security engineer. Review for vulnerabilities.");
      expect(messages.user).toBe(input);
    });

    it("combines multiple input artifacts into one user message", () => {
      const agent: AgentConfig = {
        id: "synthesizer",
        role: "Merge findings.",
        model: "execution",
        tools: [],
        memory: { max_tokens: 4000 },
      };
      const inputs = ["Finding 1: XSS", "Finding 2: N+1 query"];
      const messages = buildPrompt(agent, inputs.join("\n\n---\n\n"));

      expect(messages.user).toContain("Finding 1: XSS");
      expect(messages.user).toContain("Finding 2: N+1 query");
    });
  });
});
