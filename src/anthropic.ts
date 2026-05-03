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

/** Anthropic-compatible message used by both single-turn and multi-turn callers. */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string | Anthropic.Messages.ContentBlockParam[];
}

/** Tool definition forwarded to Anthropic when the agent has tools enabled. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LlmResponse {
  /** Concatenated text from text blocks (for back-compat with single-turn callers) */
  content: string;
  /** All blocks returned (text, tool_use, etc.) — needed for tool-use detection */
  blocks: Anthropic.Messages.ContentBlock[];
  stop_reason: Anthropic.Messages.Message["stop_reason"];
  input_tokens: number;
  output_tokens: number;
  model: string;
}

export async function callAnthropic(
  apiKey: string,
  model: string,
  system: string,
  messages: ConversationMessage[],
  maxTokens: number,
  tools?: ToolDefinition[]
): Promise<LlmResponse> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: messages as Anthropic.Messages.MessageParam[],
    ...(tools && tools.length > 0 ? { tools: tools as Anthropic.Messages.ToolUnion[] } : {}),
  });

  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return {
    content: text,
    blocks: response.content,
    stop_reason: response.stop_reason,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    model: response.model,
  };
}
