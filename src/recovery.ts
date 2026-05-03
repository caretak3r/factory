import type {
  AgentConfig,
  DagNode,
  EscalationPolicy,
  FallbackPolicy,
  PipelineConfig,
  RecoveryAction,
  RetryPolicy,
} from "./types";

const DEFAULT_BASE_MS = 1000;
const DEFAULT_CAP_MS = 30_000;

/**
 * Compute the backoff delay (ms) for the next retry attempt.
 *
 * `attempt` is 1-indexed: attempt 1 = first retry after the initial failure.
 * Exponential backoff is `base * 2^(attempt - 1)` plus 0–base ms of jitter,
 * capped at `cap_ms`.
 *
 * Pure function. Use `random` to make it deterministic in tests.
 */
export function nextBackoffMs(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random
): number {
  const base = policy.base_ms ?? DEFAULT_BASE_MS;
  const cap = policy.cap_ms ?? DEFAULT_CAP_MS;
  const n = Math.max(1, attempt);

  let delay: number;
  switch (policy.backoff) {
    case "constant":
      delay = base;
      break;
    case "linear":
      delay = base * n;
      break;
    case "exponential":
    default:
      delay = base * Math.pow(2, n - 1);
      break;
  }

  const jitter = random() * base;
  return Math.min(cap, Math.floor(delay + jitter));
}

/** Whether the node should be retried under the policy. */
export function shouldRetry(policy: RetryPolicy | undefined, retryCount: number): boolean {
  if (!policy) return false;
  return retryCount < policy.max;
}

/**
 * Decide what to do when an agent fails.
 *
 * Order of precedence:
 *   1. retry until exhaustion
 *   2. agent-level fallback (agent.fallback)
 *   3. recovery.fallback policy
 *   4. recovery.escalation
 *   5. fail
 */
export function planRecovery(args: {
  config: PipelineConfig;
  agent: AgentConfig;
  node: DagNode;
  random?: () => number;
}): RecoveryAction {
  const { config, agent, node } = args;
  const random = args.random ?? Math.random;
  const retryPolicy = config.recovery.default;

  if (shouldRetry(retryPolicy, node.retry_count)) {
    return {
      kind: "retry",
      attempt: node.retry_count + 1,
      delay_ms: nextBackoffMs(retryPolicy!, node.retry_count + 1, random),
    };
  }

  // Agent-specific fallback wins over global fallback policy.
  if (agent.fallback) {
    return { kind: "fallback", agent_id: agent.fallback, skip: false };
  }

  const fb: FallbackPolicy | undefined = config.recovery.fallback;
  if (fb?.use_agent) {
    return { kind: "fallback", agent_id: fb.use_agent, skip: false };
  }
  if (fb?.skip_failed_agent) {
    return { kind: "fallback", agent_id: null, skip: true };
  }

  const esc: EscalationPolicy | undefined = config.recovery.escalation;
  if (esc) {
    return { kind: "escalate", channel: esc.channel, target: esc.target };
  }

  return { kind: "fail", reason: "No recovery policy matched" };
}
