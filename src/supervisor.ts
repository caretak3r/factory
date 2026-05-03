import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  DagState,
  DagNode,
  AgentConfig,
  PipelineConfig,
  PipelineStep,
  PipelineEvent,
  PipelineEventType,
  HandoffEnvelope,
  DispatchMessage,
  RunMetrics,
} from "./types";
import { parsePipelineYaml, validatePipelineConfig } from "./schema";
import { evaluateGate } from "./gate";
import { createDispatchEnvelope, inputKey, artifactKey } from "./envelope";
import { planRecovery } from "./recovery";
import { aggregateMetrics } from "./metrics";
import { evaluateCondition } from "./conditional";
import { resolveImports } from "./composition";
import { resolvePeerArtifacts } from "./gossip";
import { getPriorRuns, appendRunSummary } from "./memory";

export interface InitParams {
  runId: string;
  pipelineYaml: string;
  input: unknown;
}

export interface InitResult {
  success: boolean;
  runId?: string;
  error?: string;
}

export class Supervisor extends DurableObject<Env> {
  private initialized = false;
  private dag: DagState | null = null;
  private config: PipelineConfig | null = null;

  private initSchema() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS dag_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        event_type TEXT NOT NULL,
        agent_role TEXT,
        details TEXT NOT NULL DEFAULT '{}'
      );
    `);
    this.initialized = true;
  }

  private saveDag() {
    if (!this.dag) return;
    this.dag.updated_at = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO dag_state (key, value) VALUES ('dag', ?)",
      JSON.stringify(this.dag)
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO dag_state (key, value) VALUES ('config', ?)",
      JSON.stringify(this.config)
    );
  }

  private loadDag(): boolean {
    const dagRow = this.ctx.storage.sql
      .exec("SELECT value FROM dag_state WHERE key = 'dag'")
      .toArray();
    const configRow = this.ctx.storage.sql
      .exec("SELECT value FROM dag_state WHERE key = 'config'")
      .toArray();
    if (dagRow.length > 0 && configRow.length > 0) {
      this.dag = JSON.parse(String(dagRow[0].value));
      this.config = JSON.parse(String(configRow[0].value));
      return true;
    }
    return false;
  }

  private logEvent(
    eventType: PipelineEventType,
    agentRole: string | null,
    details: Record<string, unknown>
  ) {
    if (!this.dag) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO events (run_id, event_type, agent_role, details) VALUES (?, ?, ?, ?)",
      this.dag.run_id,
      eventType,
      agentRole,
      JSON.stringify(details)
    );
  }

  private getBreakerStub() {
    if (!this.env.CIRCUIT_BREAKER) return null;
    const id = this.env.CIRCUIT_BREAKER.idFromName("global");
    return this.env.CIRCUIT_BREAKER.get(id) as unknown as {
      check(role: string): Promise<{ allowed: boolean; status: unknown }>;
      failure(role: string): Promise<unknown>;
      success(role: string): Promise<unknown>;
    };
  }

  async initializeRun(params: InitParams): Promise<InitResult> {
    this.initSchema();

    const parsed = parsePipelineYaml(params.pipelineYaml);
    if (!parsed.success) {
      return {
        success: false,
        error: `YAML validation failed: ${parsed.errors.join("; ")}`,
      };
    }

    let configWithImports = parsed.data;
    if (parsed.data.pipeline.some((s) => s.import)) {
      try {
        configWithImports = await resolveImports(parsed.data, async (name) => {
          return await this.env.PIPELINE_KV.get(`pipeline:${name}`);
        });
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    const validationErrors = validatePipelineConfig(configWithImports);
    if (validationErrors.length > 0) {
      return {
        success: false,
        error: `Config validation failed: ${validationErrors.join("; ")}`,
      };
    }

    this.config = configWithImports;

    const nodes: Record<string, DagNode> = {};
    for (const agent of this.config.agents) {
      const doId = this.env.AGENT.idFromName(`${params.runId}:${agent.id}`);
      nodes[agent.id] = {
        agent_id: agent.id,
        do_id: doId.toString(),
        status: "pending",
        step_index: this.config.pipeline.findIndex(
          (s) => s.agent === agent.id || s.agents?.includes(agent.id)
        ),
        tokens_used: 0,
        duration_ms: 0,
        retry_count: 0,
      };
    }

    const inRef = inputKey(params.runId);

    this.dag = {
      run_id: params.runId,
      pipeline_name: this.config.name,
      status: "planning",
      current_step: 0,
      nodes,
      steps: this.config.pipeline,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      input_ref: inRef,
      total_tokens: 0,
      total_duration_ms: 0,
    };

    await this.env.ARTIFACT_STORE.put(inRef, JSON.stringify(params.input));

    this.logEvent("state_transition", null, {
      from: "submitted",
      to: "planning",
    });

    this.dag.status = "dispatching";
    this.saveDag();

    await this.dispatchCurrentStep();

    return { success: true, runId: params.runId };
  }

  private async dispatchCurrentStep() {
    if (!this.dag || !this.config) return;

    const step = this.dag.steps[this.dag.current_step];
    if (!step) {
      this.dag.status = "completed";
      this.saveDag();
      return;
    }

    if (step.type === "gate") {
      this.dag.current_step++;
      this.saveDag();
      await this.dispatchCurrentStep();
      return;
    }

    // Evaluate `when:` guard. False → mark step's agents completed with empty
    // artifacts and advance, so downstream gates relying on `all_agents_completed`
    // still pass.
    if (step.when) {
      const events = await this.getEvents();
      let pass = true;
      try {
        pass = evaluateCondition(step.when, { dag: this.dag, events });
      } catch (e) {
        // Bad expression — fail-open and log so user can fix the YAML.
        this.logEvent("error", null, {
          reason: "when_eval_failed",
          error: e instanceof Error ? e.message : String(e),
          step: step.step,
        });
        pass = true;
      }
      if (!pass) {
        this.logEvent("step_skipped", null, { step: step.step, when: step.when });
        const skippedAgents = step.agents ?? (step.agent ? [step.agent] : []);
        for (const agentId of skippedAgents) {
          const node = this.dag.nodes[agentId];
          if (!node) continue;
          node.status = "completed";
          node.artifact_ref = artifactKey(this.dag.run_id, agentId);
          await this.env.ARTIFACT_STORE.put(
            node.artifact_ref,
            JSON.stringify({ skipped: true, reason: step.when })
          );
        }
        this.dag.current_step++;
        this.saveDag();
        await this.dispatchCurrentStep();
        return;
      }
    }

    const agentIds = step.agents ?? (step.agent ? [step.agent] : []);

    for (const agentId of agentIds) {
      await this.dispatchAgent(agentId, step);
    }

    this.dag.status = "running";
    this.saveDag();
  }

  /**
   * Dispatch a single agent. Used by both initial step dispatch and recovery flows.
   * `slotAgentId` is the DAG node slot (the failed agent's id when retrying or running a fallback);
   * `useAgent` overrides the agent definition (used for fallbacks where a different agent
   * runs under the failed agent's slot, writing to the same artifact key).
   */
  private async dispatchAgent(
    slotAgentId: string,
    step: PipelineStep,
    useAgent?: AgentConfig
  ) {
    if (!this.dag || !this.config) return;
    const node = this.dag.nodes[slotAgentId];
    if (!node) return;

    const agentConfig =
      useAgent ?? this.config.agents.find((a) => a.id === slotAgentId);
    if (!agentConfig) return;

    // Circuit breaker pre-check (per-role, global across runs)
    const breaker = this.getBreakerStub();
    if (breaker) {
      try {
        const { allowed, status } = await breaker.check(slotAgentId);
        if (!allowed) {
          node.status = "failed";
          node.error = "circuit_breaker_open";
          this.logEvent("circuit_trip", slotAgentId, { status });
          // Treat as failure so recovery kicks in
          await this.handleAgentFailure(slotAgentId, "circuit_breaker_open", {
            skipBreaker: true,
          });
          return;
        }
      } catch (e) {
        // Breaker unavailable — fail open (allow dispatch)
        console.error(`Breaker check failed: ${e}`);
      }
    }

    node.status = "dispatched";

    let parentRefs: string[];
    if (step.inputs && step.inputs.length > 0) {
      parentRefs = step.inputs.map((id) => artifactKey(this.dag!.run_id, id));
    } else {
      parentRefs = [this.dag.input_ref];
    }

    // The agent receives slotAgentId as its identity (so it writes to the slot's
    // artifact key) but executes the (possibly fallback) agentConfig's role.
    const dispatchAgentConfig: AgentConfig = useAgent
      ? { ...useAgent, id: slotAgentId }
      : agentConfig;

    const envelope = createDispatchEnvelope({
      runId: this.dag.run_id,
      fromAgent: "supervisor",
      fromDoId: this.ctx.id.toString(),
      toAgent: slotAgentId,
      toDoId: node.do_id,
      inputRefs: parentRefs,
      retryCount: node.retry_count,
    });

    // Gossip — only completed peers explicitly opted-in via expose: public
    const peers = resolvePeerArtifacts(
      dispatchAgentConfig,
      this.config.agents,
      this.dag
    );

    // Cross-run memory — fetch past summaries when the agent opts in
    let priorRuns = undefined;
    if (dispatchAgentConfig.memory.include_prior_runs) {
      try {
        priorRuns = await getPriorRuns(
          this.env,
          this.config.name,
          dispatchAgentConfig.memory.max_prior_runs ?? 3,
          this.dag.run_id
        );
      } catch (e) {
        console.error(`getPriorRuns failed: ${e}`);
      }
    }

    const message: DispatchMessage = {
      type: "dispatch",
      envelope,
      agent_config: dispatchAgentConfig,
      model_defaults: this.config.model_defaults,
      ...(peers.length > 0 ? { peers } : {}),
      ...(priorRuns && priorRuns.length > 0 ? { prior_runs: priorRuns } : {}),
    };

    await this.env.DISPATCH_QUEUE.send(message);

    this.logEvent("dispatch", slotAgentId, {
      step: step.step,
      input_refs: parentRefs,
      retry_count: node.retry_count,
      ...(useAgent ? { fallback_from: useAgent.id } : {}),
    });
  }

  async handleAgentCompletion(envelope: HandoffEnvelope) {
    this.initSchema();
    if (!this.dag && !this.loadDag()) return;
    if (!this.dag || !this.config) return;

    const agentId = envelope.from.agent;
    const node = this.dag.nodes[agentId];
    if (!node) return;

    node.status = "completed";
    node.artifact_ref = envelope.artifact_ref;
    node.tokens_used = envelope.metadata.tokens_used;
    node.duration_ms = envelope.metadata.duration_ms;
    node.retry_count = envelope.metadata.retry_count;
    node.model = envelope.metadata.model;
    delete node.error;

    this.dag.total_tokens += envelope.metadata.tokens_used;
    this.dag.total_duration_ms = Math.max(
      this.dag.total_duration_ms,
      envelope.metadata.duration_ms
    );

    this.logEvent("completion", agentId, {
      tokens: envelope.metadata.tokens_used,
      model: envelope.metadata.model,
      duration_ms: envelope.metadata.duration_ms,
    });

    // Inform breaker that this role just succeeded.
    const breaker = this.getBreakerStub();
    if (breaker) {
      try {
        await breaker.success(agentId);
      } catch (e) {
        console.error(`Breaker success record failed: ${e}`);
      }
    }

    await this.advanceIfStepDone();
  }

  /**
   * If every agent in the current step has reached a terminal state
   * (completed or failed), evaluate the next gate and advance.
   */
  private async advanceIfStepDone() {
    if (!this.dag || !this.config) return;

    const currentStep = this.dag.steps[this.dag.current_step];
    if (!currentStep) {
      this.dag.status = "completed";
      this.saveDag();
      return;
    }

    const stepAgents =
      currentStep.agents ?? (currentStep.agent ? [currentStep.agent] : []);
    const allDone = stepAgents.every(
      (id) =>
        this.dag!.nodes[id]?.status === "completed" ||
        this.dag!.nodes[id]?.status === "failed"
    );

    if (!allDone) {
      this.saveDag();
      return;
    }

    this.dag.current_step++;

    const nextStep = this.dag.steps[this.dag.current_step];
    if (nextStep?.type === "gate") {
      const gateResult = evaluateGate(
        nextStep,
        stepAgents,
        this.dag.nodes,
        this.config.budget
      );
      this.logEvent("gate_eval", null, {
        gate: nextStep.step,
        pass: gateResult.pass,
        reason: gateResult.reason,
      });

      if (!gateResult.pass) {
        // Honour escalation if configured for gate failure.
        const esc = this.config.recovery.escalation;
        if (esc) {
          this.dag.status = "awaiting_human";
          this.logEvent("escalation", null, {
            reason: "gate_fail",
            gate: nextStep.step,
            channel: esc.channel,
            target: esc.target,
          });
          this.saveDag();
          return;
        }
        this.dag.status = "failed";
        this.saveDag();
        return;
      }

      this.dag.current_step++;
    }

    if (this.dag.current_step >= this.dag.steps.length) {
      this.dag.status = "completed";
      this.logEvent("state_transition", null, {
        from: "running",
        to: "completed",
      });
      this.saveDag();
      // Append a summary to cross-run memory so future runs can reference it.
      try {
        const events = await this.getEvents();
        const summary = aggregateMetrics(this.dag, events);
        await appendRunSummary(this.env, summary, new Date().toISOString());
      } catch (e) {
        console.error(`appendRunSummary failed: ${e}`);
      }
      return;
    }

    this.dag.status = "dispatching";
    this.saveDag();
    await this.dispatchCurrentStep();
  }

  async handleAgentFailure(
    agentId: string,
    error: string,
    opts: { skipBreaker?: boolean } = {}
  ) {
    this.initSchema();
    if (!this.dag && !this.loadDag()) return;
    if (!this.dag || !this.config) return;

    const node = this.dag.nodes[agentId];
    if (!node) return;

    node.status = "failed";
    node.error = error;
    this.logEvent("error", agentId, { error });

    // Tell the breaker about this failure (unless caller already handled it).
    if (!opts.skipBreaker) {
      const breaker = this.getBreakerStub();
      if (breaker) {
        try {
          await breaker.failure(agentId);
        } catch (e) {
          console.error(`Breaker failure record failed: ${e}`);
        }
      }
    }

    const agent = this.config.agents.find((a) => a.id === agentId);
    if (!agent) {
      this.dag.status = "failed";
      this.saveDag();
      return;
    }

    const action = planRecovery({ config: this.config, agent, node });
    node.last_recovery = action;
    this.logEvent("recovery_attempt", agentId, { action });

    if (action.kind === "retry") {
      node.retry_count = action.attempt;
      node.status = "pending";
      delete node.error;
      this.saveDag();
      // delay_ms is captured in the event; in-Worker delays would require DO alarms.
      // For now we redispatch immediately and rely on Queue retry semantics.
      const step = this.dag.steps[node.step_index];
      if (step) await this.dispatchAgent(agentId, step);
      return;
    }

    if (action.kind === "fallback") {
      if (action.skip) {
        // Failed agent stays failed; downstream gets N-1 inputs.
        this.saveDag();
        await this.advanceIfStepDone();
        return;
      }
      if (action.agent_id) {
        const fallbackAgent = this.config.agents.find(
          (a) => a.id === action.agent_id
        );
        if (fallbackAgent) {
          node.retry_count++;
          node.status = "pending";
          delete node.error;
          this.saveDag();
          const step = this.dag.steps[node.step_index];
          if (step) await this.dispatchAgent(agentId, step, fallbackAgent);
          return;
        }
      }
      // Fallback policy malformed — fall through to fail
    }

    if (action.kind === "escalate") {
      this.dag.status = "awaiting_human";
      this.logEvent("escalation", agentId, {
        channel: action.channel,
        target: action.target,
      });
      this.saveDag();
      return;
    }

    // fail: terminal
    this.dag.status = "failed";
    this.saveDag();
  }

  async getMetrics(): Promise<RunMetrics> {
    this.initSchema();
    if (!this.dag) this.loadDag();
    const events = await this.getEvents();
    if (!this.dag) {
      return {
        run_id: "",
        pipeline_name: "",
        status: "submitted",
        total_tokens: 0,
        total_duration_ms: 0,
        total_retries: 0,
        agents_completed: 0,
        agents_failed: 0,
        gates_passed: 0,
        gates_failed: 0,
        recovery_attempts: 0,
        circuit_trips: 0,
        per_agent: [],
      };
    }
    return aggregateMetrics(this.dag, events);
  }

  async getState(): Promise<DagState> {
    this.initSchema();
    if (!this.dag) this.loadDag();
    if (!this.dag) {
      return {
        run_id: "",
        pipeline_name: "",
        status: "submitted",
        current_step: 0,
        nodes: {},
        steps: [],
        created_at: "",
        updated_at: "",
        input_ref: "",
        total_tokens: 0,
        total_duration_ms: 0,
      };
    }
    return this.dag;
  }

  async getEvents(sinceId?: number | string): Promise<PipelineEvent[]> {
    this.initSchema();
    const cursor =
      sinceId === undefined || sinceId === null || sinceId === ""
        ? 0
        : Number(sinceId);
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM events WHERE id > ? ORDER BY id ASC", cursor)
      .toArray();
    return rows.map((r) => ({
      id: String(r.id),
      run_id: String(r.run_id),
      timestamp: String(r.timestamp),
      event_type: String(r.event_type) as PipelineEvent["event_type"],
      agent_role: r.agent_role ? String(r.agent_role) : undefined,
      details: JSON.parse(String(r.details)),
    }));
  }
}
