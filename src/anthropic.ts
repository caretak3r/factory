import Anthropic from "@anthropic-ai/sdk";
import type { ModelDefaults, AgentConfig } from "./types";

const TIER_KEYS = new Set(["planning", "execution", "classification"]);

export function resolveModel(modelRef: string, defaults: ModelDefaults): string {
  if (TIER_KEYS.has(modelRef)) {
    return defaults[modelRef as keyof ModelDefaults];
  }
  return modelRef;
}

export interface PromptMessages {
  system: string;
  user: string;
}

export function buildPrompt(agent: AgentConfig, input: string): PromptMessages {
  return {
    system: agent.role,
    user: input,
  };
}

export interface LlmResponse {
  content: string;
  input_tokens: number;
  output_tokens: number;
  model: string;
}

export async function callAnthropic(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number
): Promise<LlmResponse> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return {
    content: textBlock?.text ?? "",
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    model: response.model,
  };
}
