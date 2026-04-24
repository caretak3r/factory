import { DurableObject } from "cloudflare:workers";
import type { Env, AgentConfig, ModelDefaults } from "./types";
import { artifactKey, createResultEnvelope } from "./envelope";
import { resolveModel, buildPrompt, callAnthropic } from "./anthropic";

export interface TaskParams {
  runId: string;
  agentConfig: AgentConfig;
  modelDefaults: ModelDefaults;
  inputRefs: string[];
  supervisorDoId: string;
  retryCount: number;
}

export interface TaskResult {
  success: boolean;
  artifactRef?: string;
  tokensUsed?: number;
  model?: string;
  durationMs?: number;
  error?: string;
}

export class Agent extends DurableObject<Env> {
  private initialized = false;

  private initSchema() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    this.initialized = true;
  }

  async getStatus(): Promise<{ status: string }> {
    this.initSchema();
    const row = this.ctx.storage.sql
      .exec("SELECT value FROM config WHERE key = 'status'")
      .toArray();
    return { status: row.length > 0 ? String(row[0].value) : "idle" };
  }

  async handleTask(params: TaskParams): Promise<TaskResult> {
    this.initSchema();
    const startTime = Date.now();

    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('status', 'running')"
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('run_id', ?)",
      params.runId
    );

    try {
      // Pull input artifacts from R2
      const inputParts: string[] = [];
      for (const ref of params.inputRefs) {
        const obj = await this.env.ARTIFACT_STORE.get(ref);
        if (obj) {
          inputParts.push(await obj.text());
        }
      }
      const input = inputParts.join("\n\n---\n\n");

      // Build prompt
      const { system, user } = buildPrompt(params.agentConfig, input);
      const model = resolveModel(params.agentConfig.model, params.modelDefaults);

      // Call Anthropic
      const llmResponse = await callAnthropic(
        this.env.ANTHROPIC_API_KEY,
        model,
        system,
        user,
        params.agentConfig.memory.max_tokens
      );

      // Write output artifact to R2
      const outputKey = artifactKey(params.runId, params.agentConfig.id);
      await this.env.ARTIFACT_STORE.put(
        outputKey,
        JSON.stringify({
          agent: params.agentConfig.id,
          model: llmResponse.model,
          content: llmResponse.content,
          tokens: {
            input: llmResponse.input_tokens,
            output: llmResponse.output_tokens,
          },
        })
      );

      // Record in history
      this.ctx.storage.sql.exec(
        "INSERT INTO history (role, content) VALUES ('assistant', ?)",
        llmResponse.content.substring(0, 10000)
      );

      const durationMs = Date.now() - startTime;
      const totalTokens = llmResponse.input_tokens + llmResponse.output_tokens;

      // Send result envelope to Result Queue
      const envelope = createResultEnvelope({
        runId: params.runId,
        agentRole: params.agentConfig.id,
        agentDoId: this.ctx.id.toString(),
        supervisorDoId: params.supervisorDoId,
        tokensUsed: totalTokens,
        model: llmResponse.model,
        durationMs,
        retryCount: params.retryCount,
      });

      await this.env.RESULT_QUEUE.send({
        type: "result",
        envelope,
        supervisor_do_id: params.supervisorDoId,
      });

      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('status', 'completed')"
      );

      return {
        success: true,
        artifactRef: outputKey,
        tokensUsed: totalTokens,
        model: llmResponse.model,
        durationMs,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('status', 'failed')"
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO history (role, content) VALUES ('error', ?)",
        error.substring(0, 5000)
      );

      return { success: false, error, durationMs: Date.now() - startTime };
    }
  }
}
