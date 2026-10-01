// Which agents need you and why, kept free of React so the board's tests can run it under node:test.
import type { FleetAgent, FleetPane } from "../shared/model.ts";

export type AttentionReason = "blocked" | "stuck" | "done" | "notes";

/** Order in Needs you: blocked, then stuck, then finished, then with unread review notes. */
const ORDER: AttentionReason[] = ["blocked", "stuck", "done", "notes"];

/** Why an agent is in Needs you, or undefined when it isn't. `unread` counts its unread hunk review notes. */
export function attentionReason(agent: FleetAgent, unread: number): AttentionReason | undefined {
  if (agent.status === "blocked") return "blocked";
  if (agent.stuck) return "stuck";
  if (agent.status === "done") return "done";
  if (unread > 0) return "notes";
  return undefined;
}

/** When the agent started waiting on you: when it got stuck, or else when it entered its status. */
export function waitingSince(agent: FleetAgent): number {
  return agent.stuck?.since ?? agent.since;
}

/** Agents that need you, each reason oldest first. `unread` counts an agent's hunk review notes you haven't read. */
export function needsYou<L extends { pane: FleetPane }>(panes: Map<string, L>, unread: (pane: string) => number = () => 0): L[] {
  const ranked = [...panes.values()].flatMap((l) => {
    const reason = l.pane.agent && attentionReason(l.pane.agent, unread(l.pane.id));
    return reason === undefined ? [] : [{ l, r: ORDER.indexOf(reason) }];
  });
  return ranked
    .sort((a, b) => a.r - b.r || waitingSince(a.l.pane.agent!) - waitingSince(b.l.pane.agent!))
    .map(({ l }) => l);
}
