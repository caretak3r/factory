import { z } from "zod";
import YAML from "yaml";
import type { PipelineConfig } from "./types";

const ModelDefaultsSchema = z.object({
  planning: z.string(),
  execution: z.string(),
  classification: z.string(),
});

const AgentConfigSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  model: z.string().min(1),
  tools: z.array(z.string()).default([]),
  memory: z.object({ max_tokens: z.number().positive() }),
  fallback: z.string().optional(),
});

const PipelineStepSchema = z.object({
  step: z.string().min(1),
  agent: z.string().optional(),
  agents: z.array(z.string()).optional(),
  mode: z.enum(["parallel", "sequential"]).optional(),
  inputs: z.array(z.string()).optional(),
  type: z.literal("gate").optional(),
  condition: z.string().optional(),
  on_fail: z.string().optional(),
  on_match: z.string().optional(),
  on_pass: z.string().optional(),
});

const RecoveryConfigSchema = z.object({
  default: z.string(),
  fallback: z.string(),
  escalation: z.string(),
});

const BudgetConfigSchema = z.object({
  max_tokens: z.number().positive(),
  max_duration_ms: z.number().positive(),
  max_retries: z.number().int().nonnegative(),
});

const PipelineConfigSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().min(1),
  model_defaults: ModelDefaultsSchema,
  agents: z.array(AgentConfigSchema).min(1),
  pipeline: z.array(PipelineStepSchema).min(1),
  recovery: RecoveryConfigSchema,
  budget: BudgetConfigSchema,
});

type ParseResult =
  | { success: true; data: PipelineConfig }
  | { success: false; errors: string[] };

export function parsePipelineYaml(yamlString: string): ParseResult {
  let raw: unknown;
  try {
    raw = YAML.parse(yamlString);
  } catch (e) {
    return { success: false, errors: [`YAML parse error: ${e}`] };
  }

  const result = PipelineConfigSchema.safeParse(raw);
  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`
      ),
    };
  }

  return { success: true, data: result.data as PipelineConfig };
}

export function validatePipelineConfig(config: PipelineConfig): string[] {
  const errors: string[] = [];
  const agentIds = new Set(config.agents.map((a) => a.id));

  for (const step of config.pipeline) {
    if (step.type === "gate") continue;

    if (step.agent && !agentIds.has(step.agent)) {
      errors.push(`Step "${step.step}" references unknown agent "${step.agent}"`);
    }
    if (step.agents) {
      for (const a of step.agents) {
        if (!agentIds.has(a)) {
          errors.push(`Step "${step.step}" references unknown agent "${a}"`);
        }
      }
    }
    if (step.inputs) {
      for (const inp of step.inputs) {
        if (!agentIds.has(inp)) {
          errors.push(`Step "${step.step}" input references unknown agent "${inp}"`);
        }
      }
    }
  }

  for (const agent of config.agents) {
    if (agent.fallback && !agentIds.has(agent.fallback)) {
      errors.push(`Agent "${agent.id}" fallback references unknown agent "${agent.fallback}"`);
    }
  }

  return errors;
}
