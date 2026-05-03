import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  AgentConfig,
  ModelDefaults,
  PeerArtifact,
  PriorRunSummary,
} from "./types";
import { artifactKey, createResultEnvelope } from "./envelope";
import {
  resolveModel,
  buildPrompt,
  callAnthropic,
  type ConversationMessage,
  type LlmResponse,
  type ToolDefinition,
} from "./anthropic";
import { runToolCall, toolDefinitionsFor, type ToolContext } from "./tools/registry";

export interface TaskParams {
  runId: string;
  agentConfig: AgentConfig;
  modelDefaults: ModelDefaults;
  inputRefs: string[];
  supervisorDoId: string;
  retryCount: number;
  peers?: PeerArtifact[];
  priorRuns?: PriorRunSummary[];
}

export interface TaskResult {
  success: boolean;
  artifactRef?: string;
  tokensUsed?: number;
  model?: string;
  durationMs?: number;
  turns?: number;
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
        turn_index INTEGER NOT NULL DEFAULT 0,
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

  private recordTurn(turnIndex: number, role: string, content: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO history (turn_index, role, content) VALUES (?, ?, ?)",
      turnIndex,
      role,
      content.substring(0, 10000)
    );
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

      // Cross-run memory — prepend prior-run summaries if provided
      if (params.priorRuns && params.priorRuns.length > 0) {
        const summary = params.priorRuns
          .map(
            (r) =>
              `- ${r.completed_at} run ${r.run_id.substring(0, 8)} status=${r.status} ` +
              `tokens=${r.total_tokens} duration=${r.total_duration_ms}ms ` +
              `agents_completed=${r.agents_completed} agents_failed=${r.agents_failed}`
          )
          .join("\n");
        inputParts.push(`# Prior runs of this pipeline\n${summary}`);
      }

      // Gossip — peer artifacts the supervisor authorized
      if (params.peers && params.peers.length > 0) {
        for (const peer of params.peers) {
          const obj = await this.env.ARTIFACT_STORE.get(peer.artifact_ref);
          if (obj) {
            inputParts.push(`# Peer agent: ${peer.agent_id}\n${await obj.text()}`);
          }
        }
      }

      for (const ref of params.inputRefs) {
        const obj = await this.env.ARTIFACT_STORE.get(ref);
        if (obj) inputParts.push(await obj.text());
      }
      const input = inputParts.join("\n\n---\n\n");

      const { system } = buildPrompt(params.agentConfig, input);
      const model = resolveModel(params.agentConfig.model, params.modelDefaults);
      const tools: ToolDefinition[] = toolDefinitionsFor(params.agentConfig.tools);
      const toolCtx: ToolContext = {
        runId: params.runId,
        env: this.env,
      };

      const turnsConfig = params.agentConfig.turns;
      const maxTurns = turnsConfig?.max ?? 1;
      const stopWhen = turnsConfig?.stop_when;

      const messages: ConversationMessage[] = [
        { role: "user", content: input },
      ];
      this.recordTurn(0, "user", input);

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let last: LlmResponse | null = null;
      let finalContent = "";
      let actualTurns = 0;

      for (let t = 0; t < maxTurns; t++) {
        actualTurns = t + 1;
        const resp = await callAnthropic(
          this.env.ANTHROPIC_API_KEY,
          model,
          system,
          messages,
          params.agentConfig.memory.max_tokens,
          tools
        );
        last = resp;
        totalInputTokens += resp.input_tokens;
        totalOutputTokens += resp.output_tokens;
        if (resp.content) finalContent = resp.content;

        // Append assistant message — keep raw blocks so tool_use survives next turn
        messages.push({ role: "assistant", content: resp.blocks });
        this.recordTurn(actualTurns, "assistant", resp.content);

        // Tool-use handling: execute every tool_use block, append tool_result blocks as a user turn
        const toolUses = resp.blocks.filter((b) => b.type === "tool_use");
        if (toolUses.length > 0) {
          const resultBlocks: Array<{
            type: "tool_result";
            tool_use_id: string;
            content: string;
            is_error?: boolean;
          }> = [];
          for (const block of toolUses) {
            if (block.type !== "tool_use") continue;
            const result = await runToolCall(
              { name: block.name, input: block.input as Record<string, unknown> },
              toolCtx
            );
            this.recordTurn(actualTurns, "tool_result", `${block.name}: ${result.content.substring(0, 2000)}`);
            resultBlocks.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result.content,
              ...(result.is_error ? { is_error: true } : {}),
            });
          }
          messages.push({ role: "user", content: resultBlocks });
          // After tool_use, always continue (model needs to see tool results)
          continue;
        }

        // Stop early on stop_when match
        if (stopWhen && resp.content.includes(stopWhen)) break;

        // Stop on natural end_turn
        if (resp.stop_reason === "end_turn") break;

        // On max_tokens overflow, send "continue" so model can keep generating
        if (resp.stop_reason === "max_tokens" && t < maxTurns - 1) {
          messages.push({ role: "user", content: "continue" });
          this.recordTurn(actualTurns, "user", "continue");
          continue;
        }

        // No tool use, no continue — single iteration is done
        break;
      }

      // Write final artifact to R2
      const outputKey = artifactKey(params.runId, params.agentConfig.id);
      await this.env.ARTIFACT_STORE.put(
        outputKey,
        JSON.stringify({
          agent: params.agentConfig.id,
          model: last?.model ?? model,
          content: finalContent,
          turns: actualTurns,
          tokens: { input: totalInputTokens, output: totalOutputTokens },
        })
      );

      const durationMs = Date.now() - startTime;
      const totalTokens = totalInputTokens + totalOutputTokens;

      const envelope = createResultEnvelope({
        runId: params.runId,
        agentRole: params.agentConfig.id,
        agentDoId: this.ctx.id.toString(),
        supervisorDoId: params.supervisorDoId,
        tokensUsed: totalTokens,
        model: last?.model ?? model,
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
        model: last?.model ?? model,
        durationMs,
        turns: actualTurns,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('status', 'failed')"
      );
      this.recordTurn(0, "error", error);
      return { success: false, error, durationMs: Date.now() - startTime };
    }
  }
}
