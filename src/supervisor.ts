import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  DagState,
  DagNode,
  PipelineConfig,
  PipelineStep,
  PipelineEvent,
  HandoffEnvelope,
  DispatchMessage,
} from "./types";
import { parsePipelineYaml, validatePipelineConfig } from "./schema";
import { evaluateGate } from "./gate";
import { createDispatchEnvelope, inputKey, artifactKey } from "./envelope";

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
    eventType: PipelineEvent["event_type"],
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

  async initializeRun(params: InitParams): Promise<InitResult> {
    this.initSchema();

    const parsed = parsePipelineYaml(params.pipelineYaml);
    if (!parsed.success) {
      return {
        success: false,
        error: `YAML validation failed: ${parsed.errors.join("; ")}`,
      };
    }

    const validationErrors = validatePipelineConfig(parsed.data);
    if (validationErrors.length > 0) {
      return {
        success: false,
        error: `Config validation failed: ${validationErrors.join("; ")}`,
      };
    }

    this.config = parsed.data;

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

    const agentIds = step.agents ?? (step.agent ? [step.agent] : []);
    const supervisorDoId = this.ctx.id.toString();

    for (const agentId of agentIds) {
      const node = this.dag.nodes[agentId];
      if (!node) continue;

      node.status = "dispatched";

      let parentRefs: string[];
      if (step.inputs && step.inputs.length > 0) {
        parentRefs = step.inputs.map((id) =>
          artifactKey(this.dag!.run_id, id)
        );
      } else {
        parentRefs = [this.dag.input_ref];
      }

      const agentConfig = this.config.agents.find((a) => a.id === agentId)!;

      const envelope = createDispatchEnvelope({
        runId: this.dag.run_id,
        fromAgent: "supervisor",
        fromDoId: supervisorDoId,
        toAgent: agentId,
        toDoId: node.do_id,
        inputRefs: parentRefs,
      });

      const message: DispatchMessage = {
        type: "dispatch",
        envelope,
        agent_config: agentConfig,
        model_defaults: this.config.model_defaults,
      };

      await this.env.DISPATCH_QUEUE.send(message);

      this.logEvent("dispatch", agentId, {
        step: step.step,
        input_refs: parentRefs,
      });
    }

    this.dag.status = "running";
    this.saveDag();
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
      return;
    }

    this.dag.status = "dispatching";
    this.saveDag();
    await this.dispatchCurrentStep();
  }

  async handleAgentFailure(agentId: string, error: string) {
    this.initSchema();
    if (!this.dag && !this.loadDag()) return;
    if (!this.dag) return;

    const node = this.dag.nodes[agentId];
    if (node) {
      node.status = "failed";
      node.error = error;
    }

    this.logEvent("error", agentId, { error });

    this.dag.status = "failed";
    this.saveDag();
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

  async getEvents(): Promise<PipelineEvent[]> {
    this.initSchema();
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM events ORDER BY id ASC")
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
