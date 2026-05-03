import type { CircuitBreakerState, CircuitBreakerStatus } from "./types";

export interface BreakerConfig {
  /** Failures within window to trip from closed → open */
  threshold: number;
  /** Rolling window for counting failures (ms) */
  window_ms: number;
  /** Time after trip before allowing half-open probe (ms) */
  decay_ms: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  threshold: 5,
  window_ms: 60_000,
  decay_ms: 30_000,
};

export interface BreakerRoleState {
  role: string;
  state: CircuitBreakerState;
  failures_in_window: number;
  /** Wall-clock ms of last failure (null if none) */
  last_failure_at: number | null;
  /** Wall-clock ms when the breaker opened (null if not open) */
  opened_at: number | null;
}

export function emptyRoleState(role: string): BreakerRoleState {
  return {
    role,
    state: "closed",
    failures_in_window: 0,
    last_failure_at: null,
    opened_at: null,
  };
}

/**
 * Reconcile stored state against wall-clock — handles the open → half-open
 * transition that happens passively after `decay_ms` elapses. Pure.
 */
export function observeState(
  state: BreakerRoleState,
  now: number,
  config: BreakerConfig
): BreakerRoleState {
  if (state.state === "open" && state.opened_at !== null) {
    if (now - state.opened_at >= config.decay_ms) {
      return { ...state, state: "half-open" };
    }
  }
  return state;
}

export function isAllowed(state: BreakerRoleState, now: number, config: BreakerConfig): boolean {
  return observeState(state, now, config).state !== "open";
}

export function recordFailure(
  state: BreakerRoleState,
  now: number,
  config: BreakerConfig
): BreakerRoleState {
  const observed = observeState(state, now, config);

  if (observed.state === "half-open") {
    return {
      ...observed,
      state: "open",
      opened_at: now,
      last_failure_at: now,
    };
  }

  const inWindow =
    observed.last_failure_at !== null &&
    now - observed.last_failure_at <= config.window_ms;
  const newCount = inWindow ? observed.failures_in_window + 1 : 1;

  if (newCount >= config.threshold) {
    return {
      ...observed,
      state: "open",
      failures_in_window: newCount,
      last_failure_at: now,
      opened_at: observed.opened_at ?? now,
    };
  }

  return {
    ...observed,
    failures_in_window: newCount,
    last_failure_at: now,
  };
}

export function recordSuccess(
  state: BreakerRoleState,
  now: number,
  config: BreakerConfig
): BreakerRoleState {
  const observed = observeState(state, now, config);

  if (observed.state === "half-open") {
    return {
      ...observed,
      state: "closed",
      failures_in_window: 0,
      opened_at: null,
    };
  }

  if (
    observed.last_failure_at !== null &&
    now - observed.last_failure_at > config.window_ms
  ) {
    return { ...observed, failures_in_window: 0 };
  }
  return observed;
}

export function toStatus(state: BreakerRoleState): CircuitBreakerStatus {
  return {
    role: state.role,
    state: state.state,
    failures_in_window: state.failures_in_window,
    last_failure_at: state.last_failure_at
      ? new Date(state.last_failure_at).toISOString()
      : null,
    opened_at: state.opened_at ? new Date(state.opened_at).toISOString() : null,
  };
}
