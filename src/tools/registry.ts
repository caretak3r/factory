import type { Env } from "../types";
import type { ToolDefinition } from "../anthropic";
import { readScopedArtifact, withTimeout } from "./sandbox";
import { vetGrepPattern, boundedGrepScan, MAX_GREP_MATCHES } from "./grep-guard";

export interface ToolContext {
  runId: string;
  env: Env;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  is_error?: boolean;
}

export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: ToolContext
) => Promise<ToolResult>;

interface ToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// ─── Tool implementations ─────────────────────────

const readArtifact: ToolHandler = async (input, ctx) => {
  const path = String(input.path ?? "");
  if (!path) return { content: "missing required field: path", is_error: true };
  try {
    const text = await readScopedArtifact(ctx.env, ctx.runId, path);
    return { content: text };
  } catch (e) {
    return { content: e instanceof Error ? e.message : String(e), is_error: true };
  }
};

const GREP_FLAGS_RE = /^[gimsu]*$/;

const grepArtifact: ToolHandler = async (input, ctx) => {
  const path = String(input.path ?? "");
  const pattern = String(input.pattern ?? "");
  const flags = typeof input.flags === "string" ? input.flags : "";
  if (!path || !pattern) {
    return { content: "missing required fields: path, pattern", is_error: true };
  }
  const verdict = vetGrepPattern(pattern);
  if (!verdict.ok) {
    return { content: `pattern rejected: ${verdict.reason}`, is_error: true };
  }
  if (!GREP_FLAGS_RE.test(flags)) {
    return {
      content: `unsupported regex flags: "${flags}" (allowed: gimsu)`,
      is_error: true,
    };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags || "g");
  } catch (e) {
    return { content: `invalid regex: ${e instanceof Error ? e.message : e}`, is_error: true };
  }
  let text: string;
  try {
    text = await readScopedArtifact(ctx.env, ctx.runId, path);
  } catch (e) {
    return { content: e instanceof Error ? e.message : String(e), is_error: true };
  }

  const scan = boundedGrepScan(text, regex);
  const notes: string[] = [];
  if (scan.capped) {
    notes.push(
      `[match cap ${MAX_GREP_MATCHES} reached; stopped after line ${scan.scannedLines} of ${scan.totalLines}]`
    );
  }
  if (scan.aborted) {
    notes.push(
      `[grep time budget exceeded; scanned ${scan.scannedLines} of ${scan.totalLines} lines]`
    );
  }
  const suffix = notes.length > 0 ? "\n" + notes.join("\n") : "";
  if (scan.matches.length === 0) {
    return { content: `(no matches for /${pattern}/${flags} in ${path})` + suffix };
  }
  return { content: scan.matches.join("\n") + suffix };
};

const semgrepStub: ToolHandler = async (input) => ({
  content: `semgrep is stubbed in this environment. Requested: ${JSON.stringify(input)}`,
});

const testRunnerStub: ToolHandler = async (input) => ({
  content: `test-runner is stubbed in this environment. Requested: ${JSON.stringify(input)}`,
});

// ─── Registry ─────────────────────────────────────

const REGISTRY: Record<string, ToolEntry> = {
  read: {
    definition: {
      name: "read",
      description: "Read a single artifact from this run's R2 scope. Path must be scoped under runs/{runId}/.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Artifact path, either a key like 'runs/{runId}/agents/x/output.json' or relative like 'agents/x/output.json'",
          },
        },
        required: ["path"],
      },
    },
    handler: readArtifact,
  },
  grep: {
    definition: {
      name: "grep",
      description: "Search a single run-scoped artifact for lines matching a regex. ReDoS guard: pattern max 128 chars; backreferences, lookbehind, and quantified groups are rejected.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Artifact path under the run's scope" },
          pattern: { type: "string", description: "Regular expression (max 128 chars; no quantified groups, backreferences, or lookbehind)" },
          flags: { type: "string", description: "Regex flags (allowed: gimsu)" },
        },
        required: ["path", "pattern"],
      },
    },
    handler: grepArtifact,
  },
  semgrep: {
    definition: {
      name: "semgrep",
      description: "(stub) Run semgrep over the run's artifacts.",
      input_schema: {
        type: "object",
        properties: {
          rule: { type: "string" },
          path: { type: "string" },
        },
        required: ["rule"],
      },
    },
    handler: semgrepStub,
  },
  "test-runner": {
    definition: {
      name: "test-runner",
      description: "(stub) Run the test suite — not available in the Worker sandbox.",
      input_schema: {
        type: "object",
        properties: {
          target: { type: "string" },
        },
      },
    },
    handler: testRunnerStub,
  },
};

export function toolDefinitionsFor(names: string[]): ToolDefinition[] {
  if (!names || names.length === 0) return [];
  const defs: ToolDefinition[] = [];
  for (const name of names) {
    const entry = REGISTRY[name];
    if (entry) defs.push(entry.definition);
  }
  return defs;
}

export function listAvailableTools(): string[] {
  return Object.keys(REGISTRY);
}

export async function runToolCall(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const entry = REGISTRY[call.name];
  if (!entry) return { content: `Unknown tool: ${call.name}`, is_error: true };
  try {
    return await withTimeout(entry.handler(call.input ?? {}, ctx));
  } catch (e) {
    return {
      content: e instanceof Error ? e.message : String(e),
      is_error: true,
    };
  }
}
