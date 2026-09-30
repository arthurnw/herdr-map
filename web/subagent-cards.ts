// Which of an agent's subagents are listed, and in what tree order.
import type { FleetAgent, SubagentInfo } from "../shared/model.ts";

// A finished subagent stays listed this long, or up to FINISHED_TURN_MS while its parent is still
// on the turn that started it: working, blocked, or done and not yet looked at.
export const FINISHED_SHOW_MS = 3 * 60_000;
export const FINISHED_TURN_MS = 30 * 60_000;

export function visibleSubagents(agent: FleetAgent, now: number): SubagentInfo[] {
  const onTurn = agent.status === "working" || agent.status === "blocked" || agent.status === "done";
  return (agent.subagents ?? []).filter((s) => {
    if (s.status === "running") return true;
    const ago = now - (s.endedAt ?? 0);
    return ago < FINISHED_SHOW_MS || (onTurn && ago < FINISHED_TURN_MS);
  });
}

/** Depth-first order with each subagent's depth. One whose parent isn't listed goes at the top level. */
export function subagentTree(list: SubagentInfo[]): { sub: SubagentInfo; depth: number }[] {
  const ids = new Set(list.map((s) => s.id));
  const children = new Map<string | undefined, SubagentInfo[]>();
  for (const s of list) {
    const parent = s.parent && ids.has(s.parent) ? s.parent : undefined;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const out: { sub: SubagentInfo; depth: number }[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const sub of children.get(parent) ?? []) {
      out.push({ sub, depth });
      walk(sub.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
}
