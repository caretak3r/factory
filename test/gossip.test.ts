import { describe, it, expect } from "vitest";
import { resolvePeerArtifacts } from "../src/gossip";
import type { AgentConfig, DagState } from "../src/types";

function agent(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    role: "x",
    model: "execution",
    tools: [],
    memory: { max_tokens: 1000 },
    ...overrides,
  };
}

function dagWith(nodes: Record<string, Partial<DagState["nodes"][string]>>): DagState {
  const fullNodes: DagState["nodes"] = {};
  for (const [id, n] of Object.entries(nodes)) {
    fullNodes[id] = {
      agent_id: id,
      do_id: "id",
      status: "completed",
      step_index: 0,
      tokens_used: 0,
      duration_ms: 0,
      retry_count: 0,
      ...n,
    };
  }
  return {
    run_id: "r",
    pipeline_name: "p",
    status: "running",
    current_step: 0,
    nodes: fullNodes,
    steps: [],
    created_at: "t",
    updated_at: "t",
    input_ref: "r",
    total_tokens: 0,
    total_duration_ms: 0,
  };
}

describe("gossip.resolvePeerArtifacts", () => {
  it("returns [] when reader has no read_peers", () => {
    const reader = agent("synth");
    const peers = resolvePeerArtifacts(reader, [reader, agent("a")], dagWith({ a: {} }));
    expect(peers).toEqual([]);
  });

  it("only returns peers that opted in via expose: public", () => {
    const reader = agent("synth", { gossip: { read_peers: ["public-a", "private-b"] } });
    const peers = resolvePeerArtifacts(
      reader,
      [
        reader,
        agent("public-a", { gossip: { expose: "public" } }),
        agent("private-b", { gossip: { expose: "private" } }),
      ],
      dagWith({
        "public-a": { artifact_ref: "runs/r/agents/public-a/output.json" },
        "private-b": { artifact_ref: "runs/r/agents/private-b/output.json" },
      })
    );
    expect(peers).toHaveLength(1);
    expect(peers[0].agent_id).toBe("public-a");
  });

  it("excludes peers that haven't completed yet", () => {
    const reader = agent("synth", { gossip: { read_peers: ["pending"] } });
    const peers = resolvePeerArtifacts(
      reader,
      [reader, agent("pending", { gossip: { expose: "public" } })],
      dagWith({ pending: { status: "running" } })
    );
    expect(peers).toEqual([]);
  });

  it("excludes self even if listed", () => {
    const reader = agent("self", { gossip: { read_peers: ["self"], expose: "public" } });
    const peers = resolvePeerArtifacts(
      reader,
      [reader],
      dagWith({ self: { artifact_ref: "x" } })
    );
    expect(peers).toEqual([]);
  });

  it("ignores unknown peer ids", () => {
    const reader = agent("synth", { gossip: { read_peers: ["ghost"] } });
    const peers = resolvePeerArtifacts(reader, [reader], dagWith({}));
    expect(peers).toEqual([]);
  });

  it("returns artifact_ref directly (no I/O)", () => {
    const reader = agent("synth", { gossip: { read_peers: ["a"] } });
    const peers = resolvePeerArtifacts(
      reader,
      [reader, agent("a", { gossip: { expose: "public" } })],
      dagWith({ a: { artifact_ref: "runs/r/agents/a/output.json" } })
    );
    expect(peers[0].artifact_ref).toBe("runs/r/agents/a/output.json");
  });
});
