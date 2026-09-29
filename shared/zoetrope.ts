// zoetrope (github.com/furkankly/zoetrope) draws an agent session as a live flow graph.
// Its herdr plugin opens the session of the focused pane.
import type { FleetAgent } from "./model.ts";

export const ZOETROPE_PLUGIN = "furkankly.zoetrope";

/** zoetrope reads Claude Code and Codex sessions, and needs the session ID herdr reports. */
export function hasZoetropeSession(agent: FleetAgent | undefined): boolean {
  return !!agent?.sessionId && (agent.kind === "claude" || agent.kind === "codex");
}
