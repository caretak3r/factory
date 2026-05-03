import { describe, it, expect } from "vitest";
import {
  recordFailure,
  recordSuccess,
  observeState,
  isAllowed,
  toStatus,
  DEFAULT_BREAKER_CONFIG,
  type BreakerConfig,
  type BreakerRoleState,
} from "../src/breaker-logic";

const cfg: BreakerConfig = { threshold: 3, window_ms: 60_000, decay_ms: 30_000 };

function fresh(role = "alpha"): BreakerRoleState {
  return {
    role,
    state: "closed",
    failures_in_window: 0,
    last_failure_at: null,
    opened_at: null,
  };
}

describe("circuit-breaker.recordFailure", () => {
  it("counts failures and stays closed below threshold", () => {
    let s = fresh();
    s = recordFailure(s, 1000, cfg);
    expect(s.state).toBe("closed");
    expect(s.failures_in_window).toBe(1);

    s = recordFailure(s, 2000, cfg);
    expect(s.state).toBe("closed");
    expect(s.failures_in_window).toBe(2);
  });

  it("trips to open at threshold", () => {
    let s = fresh();
    s = recordFailure(s, 1000, cfg);
    s = recordFailure(s, 2000, cfg);
    s = recordFailure(s, 3000, cfg);

    expect(s.state).toBe("open");
    expect(s.opened_at).toBe(3000);
    expect(s.failures_in_window).toBe(3);
  });

  it("resets failure count when prior failure is outside window", () => {
    let s = fresh();
    s = recordFailure(s, 1000, cfg);
    s = recordFailure(s, 2000, cfg);
    // 90s later, well past 60s window
    s = recordFailure(s, 92_000, cfg);
    expect(s.state).toBe("closed");
    expect(s.failures_in_window).toBe(1);
  });
});

describe("circuit-breaker.observeState (decay)", () => {
  it("stays open within decay window", () => {
    const opened: BreakerRoleState = {
      role: "alpha",
      state: "open",
      failures_in_window: 3,
      last_failure_at: 5_000,
      opened_at: 5_000,
    };
    const observed = observeState(opened, 20_000, cfg); // 15s after open
    expect(observed.state).toBe("open");
  });

  it("transitions to half-open after decay_ms elapses", () => {
    const opened: BreakerRoleState = {
      role: "alpha",
      state: "open",
      failures_in_window: 3,
      last_failure_at: 5_000,
      opened_at: 5_000,
    };
    const observed = observeState(opened, 35_001, cfg); // 30.001s after open
    expect(observed.state).toBe("half-open");
  });
});

describe("circuit-breaker half-open transitions", () => {
  it("re-opens on probe failure", () => {
    const halfOpen: BreakerRoleState = {
      role: "alpha",
      state: "half-open",
      failures_in_window: 3,
      last_failure_at: 5_000,
      opened_at: 5_000,
    };
    const next = recordFailure(halfOpen, 40_000, cfg);
    expect(next.state).toBe("open");
    expect(next.opened_at).toBe(40_000);
  });

  it("closes on probe success and resets counters", () => {
    const halfOpen: BreakerRoleState = {
      role: "alpha",
      state: "half-open",
      failures_in_window: 3,
      last_failure_at: 5_000,
      opened_at: 5_000,
    };
    const next = recordSuccess(halfOpen, 40_000, cfg);
    expect(next.state).toBe("closed");
    expect(next.failures_in_window).toBe(0);
    expect(next.opened_at).toBeNull();
  });
});

describe("circuit-breaker.isAllowed", () => {
  it("allows in closed state", () => {
    expect(isAllowed(fresh(), 1000, cfg)).toBe(true);
  });

  it("denies in open state within decay", () => {
    const opened: BreakerRoleState = {
      role: "alpha",
      state: "open",
      failures_in_window: 3,
      last_failure_at: 1000,
      opened_at: 1000,
    };
    expect(isAllowed(opened, 5000, cfg)).toBe(false);
  });

  it("allows after decay (state observed as half-open)", () => {
    const opened: BreakerRoleState = {
      role: "alpha",
      state: "open",
      failures_in_window: 3,
      last_failure_at: 1000,
      opened_at: 1000,
    };
    expect(isAllowed(opened, 31_001, cfg)).toBe(true);
  });
});

describe("circuit-breaker.toStatus", () => {
  it("formats timestamps as ISO strings", () => {
    const status = toStatus({
      role: "alpha",
      state: "open",
      failures_in_window: 3,
      last_failure_at: 1700000000000,
      opened_at: 1700000000000,
    });
    expect(status.role).toBe("alpha");
    expect(status.state).toBe("open");
    expect(status.last_failure_at).toBe(new Date(1700000000000).toISOString());
    expect(status.opened_at).toBe(new Date(1700000000000).toISOString());
  });

  it("renders nulls when timestamps absent", () => {
    const status = toStatus(fresh("beta"));
    expect(status.last_failure_at).toBeNull();
    expect(status.opened_at).toBeNull();
  });
});

describe("circuit-breaker default config", () => {
  it("trips after 5 failures within 60s window", () => {
    let s = fresh();
    for (let i = 0; i < 5; i++) {
      s = recordFailure(s, 1000 * (i + 1), DEFAULT_BREAKER_CONFIG);
    }
    expect(s.state).toBe("open");
  });
});
