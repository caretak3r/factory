import type { PipelineConfig, PipelineStep, AgentConfig } from "./types";
import { parsePipelineYaml } from "./schema";

export interface ImportLookup {
  /** Returns the raw YAML for a pipeline name, or null if not found. */
  (name: string): Promise<string | null>;
}

export class CompositionError extends Error {
  constructor(message: string) {
    super(`composition: ${message}`);
    this.name = "CompositionError";
  }
}

/**
 * Resolve `import:` steps in a pipeline by inlining the referenced sub-pipeline's
 * agents and steps under a step-name prefix. One level deep — imported pipelines
 * may NOT themselves contain further imports.
 *
 * Returns a new PipelineConfig with imports flattened. Pure given the lookup fn.
 */
export async function resolveImports(
  parent: PipelineConfig,
  lookup: ImportLookup
): Promise<PipelineConfig> {
  const newAgents: AgentConfig[] = [...parent.agents];
  const newSteps: PipelineStep[] = [];
  const knownAgentIds = new Set(parent.agents.map((a) => a.id));

  for (const step of parent.pipeline) {
    if (!step.import) {
      newSteps.push(step);
      continue;
    }

    if (step.import === parent.name) {
      throw new CompositionError(
        `pipeline "${parent.name}" cannot import itself (cycle at step "${step.step}")`
      );
    }

    const yaml = await lookup(step.import);
    if (yaml === null) {
      throw new CompositionError(`imported pipeline not found: ${step.import}`);
    }
    const parsed = parsePipelineYaml(yaml);
    if (!parsed.success) {
      throw new CompositionError(
        `imported pipeline "${step.import}" failed to parse: ${parsed.errors.join("; ")}`
      );
    }
    const sub = parsed.data;
    if (sub.pipeline.some((s) => s.import)) {
      throw new CompositionError(
        `imported pipeline "${step.import}" itself contains imports — only one level deep is supported`
      );
    }

    const prefix = `${step.step}__`;

    // Namespace and append sub-pipeline agents
    for (const a of sub.agents) {
      const newId = `${prefix}${a.id}`;
      if (knownAgentIds.has(newId)) {
        throw new CompositionError(
          `agent id collision after import: "${newId}" (from import "${step.import}")`
        );
      }
      knownAgentIds.add(newId);
      newAgents.push({
        ...a,
        id: newId,
        fallback: a.fallback ? `${prefix}${a.fallback}` : undefined,
      });
    }

    // Namespace and append sub-pipeline steps
    for (const subStep of sub.pipeline) {
      newSteps.push(namespaceStep(subStep, prefix));
    }
  }

  return { ...parent, agents: newAgents, pipeline: newSteps };
}

function namespaceStep(step: PipelineStep, prefix: string): PipelineStep {
  return {
    ...step,
    step: `${prefix}${step.step}`,
    agent: step.agent ? `${prefix}${step.agent}` : undefined,
    agents: step.agents ? step.agents.map((a) => `${prefix}${a}`) : undefined,
    inputs: step.inputs ? step.inputs.map((i) => `${prefix}${i}`) : undefined,
  };
}
