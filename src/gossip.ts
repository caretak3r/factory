import type {
  AgentConfig,
  DagState,
  PeerArtifact,
} from "./types";

/**
 * Compute the list of peer artifact refs an agent is allowed to read mid-run.
 *
 * An agent X may read peer Y's artifact iff:
 *   - X declared `gossip.read_peers` listing Y, AND
 *   - Y declared `gossip.expose: "public"`, AND
 *   - Y's node has reached `completed` status (artifact_ref present)
 *
 * Pure: no I/O. Returns the refs only — actual R2 reads happen in the agent.
 */
export function resolvePeerArtifacts(
  reader: AgentConfig,
  allAgents: AgentConfig[],
  dag: DagState
): PeerArtifact[] {
  const wants = reader.gossip?.read_peers;
  if (!wants || wants.length === 0) return [];

  const byId = new Map(allAgents.map((a) => [a.id, a]));
  const out: PeerArtifact[] = [];

  for (const peerId of wants) {
    if (peerId === reader.id) continue; // can't gossip with self
    const peer = byId.get(peerId);
    if (!peer) continue;
    if (peer.gossip?.expose !== "public") continue;
    const node = dag.nodes[peerId];
    if (!node || node.status !== "completed" || !node.artifact_ref) continue;
    out.push({ agent_id: peerId, artifact_ref: node.artifact_ref });
  }

  return out;
}
