import { describe, it, expect, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

import { isCurrentAttempt, isFreshTransition } from "../src/supervisor";
import type { AgentStatus } from "../src/types";

describe("isFreshTransition", () => {
  it("allows the first transition from non-terminal states", () => {
    for (const s of ["pending", "dispatched", "running"] as AgentStatus[]) {
      expect(isFreshTransition(s)).toBe(true);
    }
  });

  it("blocks re-applying deltas once terminal (redelivery is a no-op)", () => {
    expect(isFreshTransition("completed")).toBe(false);
    expect(isFreshTransition("failed")).toBe(false);
  });
});

describe("isCurrentAttempt", () => {
  it("allows signals for the current retry count", () => {
    expect(isCurrentAttempt(0, 0)).toBe(true);
    expect(isCurrentAttempt(2, 2)).toBe(true);
  });

  it("blocks stale signals from previous attempts", () => {
    expect(isCurrentAttempt(0, 1)).toBe(false);
    expect(isCurrentAttempt(1, 2)).toBe(false);
  });

  it("blocks missing or malformed retry counts by default", () => {
    expect(isCurrentAttempt(undefined, 3)).toBe(false);
    expect(isCurrentAttempt("3", 3)).toBe(false);
  });
});
