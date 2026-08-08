import type { DagNode, PipelineStep, BudgetConfig } from "./types";

export interface GateResult {
  pass: boolean;
  reason: string;
  condition: string;
}

export function evaluateGate(
  gate: PipelineStep,
  previousStepAgents: string[],
  nodes: Record<string, DagNode>,
  budget: BudgetConfig
): GateResult {
  const condition = gate.condition ?? "all_agents_completed";

  switch (condition) {
    case "all_agents_completed": {
      const failed = previousStepAgents.filter(
        (id) => nodes[id]?.status !== "completed"
      );
      if (failed.length > 0) {
        return {
          pass: false,
          reason: `Agents not completed: ${failed.join(", ")}`,
          condition,
        };
      }
      return { pass: true, reason: "All agents completed", condition };
    }

    case "token_budget": {
      const totalTokens = Object.values(nodes).reduce(
        (sum, n) => sum + n.tokens_used,
        0
      );
      if (totalTokens > budget.max_tokens) {
        return {
          pass: false,
          reason: `Token budget exceeded: ${totalTokens}/${budget.max_tokens}`,
          condition,
        };
      }
      return { pass: true, reason: "Within token budget", condition };
    }

    default:
      return {
        pass: false,
        reason: `Unknown gate condition "${condition}" — failing closed`,
        condition,
      };
  }
}
