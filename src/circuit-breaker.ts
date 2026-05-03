import { DurableObject } from "cloudflare:workers";
import type { Env, CircuitBreakerState, CircuitBreakerStatus } from "./types";
import {
  BreakerConfig,
  BreakerRoleState,
  DEFAULT_BREAKER_CONFIG,
  emptyRoleState,
  observeState,
  recordFailure,
  recordSuccess,
  toStatus,
} from "./breaker-logic";

export class CircuitBreaker extends DurableObject<Env> {
  private initialized = false;
  private config: BreakerConfig = DEFAULT_BREAKER_CONFIG;

  private initSchema() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS breaker_state (
        role TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        failures_in_window INTEGER NOT NULL DEFAULT 0,
        last_failure_at INTEGER,
        opened_at INTEGER
      );
    `);
    this.initialized = true;
  }

  private load(role: string): BreakerRoleState {
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM breaker_state WHERE role = ?", role)
      .toArray();
    if (rows.length === 0) return emptyRoleState(role);
    const r = rows[0];
    return {
      role,
      state: String(r.state) as CircuitBreakerState,
      failures_in_window: Number(r.failures_in_window),
      last_failure_at: r.last_failure_at === null ? null : Number(r.last_failure_at),
      opened_at: r.opened_at === null ? null : Number(r.opened_at),
    };
  }

  private save(state: BreakerRoleState) {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO breaker_state
       (role, state, failures_in_window, last_failure_at, opened_at)
       VALUES (?, ?, ?, ?, ?)`,
      state.role,
      state.state,
      state.failures_in_window,
      state.last_failure_at,
      state.opened_at
    );
  }

  async failure(role: string): Promise<CircuitBreakerStatus> {
    this.initSchema();
    const next = recordFailure(this.load(role), Date.now(), this.config);
    this.save(next);
    return toStatus(next);
  }

  async success(role: string): Promise<CircuitBreakerStatus> {
    this.initSchema();
    const next = recordSuccess(this.load(role), Date.now(), this.config);
    this.save(next);
    return toStatus(next);
  }

  async check(role: string): Promise<{ allowed: boolean; status: CircuitBreakerStatus }> {
    this.initSchema();
    const observed = observeState(this.load(role), Date.now(), this.config);
    if (observed.state === "half-open") this.save(observed);
    return { allowed: observed.state !== "open", status: toStatus(observed) };
  }

  async getAll(): Promise<CircuitBreakerStatus[]> {
    this.initSchema();
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM breaker_state")
      .toArray();
    return rows.map((r) =>
      toStatus({
        role: String(r.role),
        state: String(r.state) as CircuitBreakerState,
        failures_in_window: Number(r.failures_in_window),
        last_failure_at: r.last_failure_at === null ? null : Number(r.last_failure_at),
        opened_at: r.opened_at === null ? null : Number(r.opened_at),
      })
    );
  }
}
