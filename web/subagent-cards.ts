// Where subagent cards go: which subagents get one, their tree order, and their positions.
import type { Node } from "@xyflow/react";
import type { FleetAgent, SubagentInfo } from "../shared/model.ts";
import type { PaneData } from "./layout.ts";

// A finished subagent's card stays this long, or up to FINISHED_TURN_MS while its parent is still
// on the turn that started it: working, blocked, or done and not yet looked at.
export const FINISHED_SHOW_MS = 3 * 60_000;
export const FINISHED_TURN_MS = 30 * 60_000;
export const MAX_CARDS = 6;
const CARD_W = 220;
const CARD_H = 62;
const MORE_H = 22;
const CARD_GAP = 6;
const INDENT = 14;
// Space between the parent's card and the first column of subagent cards.
const OFFSET_X = 10;

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

export type SubagentData = { pane: string; sub?: SubagentInfo; depth: number; more?: number };

const NODE_PREFIX = "sub:";
// Agent cards are the third level of nodes (workspace, tab, pane), so React Flow stacks them at
// z 2. Cards at the same z placed before them in the node list sit under other agents' cards and
// over workspace and tab backgrounds; raised cards go over everything but notes.
const RAISED_Z = 1500;
const NONE: Node[] = [];

function absolutePosition(n: Node, byId: Map<string, Node>): { x: number; y: number } {
  let { x, y } = n.position;
  for (let p = n.parentId && byId.get(n.parentId); p; p = p.parentId && byId.get(p.parentId)) {
    x += p.position.x;
    y += p.position.y;
  }
  return { x, y };
}

/**
 * Cards for the subagents of the agent cards in `raised` (selected) or `peek` (under the pointer),
 * right of that card and above everything else. Other agents get none: the map is packed, so
 * cards drawn for every agent spill over neighboring workspaces; their card shows a count chip
 * instead. Peeked cards let clicks through to what they cover. `below` is always empty.
 */
export function subagentNodes(
  nodes: Node[],
  now: number,
  raised: ReadonlySet<string>,
  peek?: string,
): { below: Node[]; above: Node[] } {
  const below: Node[] = [];
  const above: Node[] = [];
  let byId: Map<string, Node> | undefined;
  for (const n of nodes) {
    const up = raised.has(n.id);
    if (n.type !== "pane" || n.className?.includes("status-filtered") || !(up || n.id === peek)) continue;
    const agent = (n.data as PaneData).pane.agent;
    if (!agent?.subagents?.length) continue;
    const tree = subagentTree(visibleSubagents(agent, now));
    if (tree.length === 0) continue;
    byId ??= new Map(nodes.map((m) => [m.id, m]));
    const origin = absolutePosition(n, byId);
    const out = above;
    const x = origin.x + (n.width ?? 0) + OFFSET_X;
    const base = {
      type: "subagent",
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: RAISED_Z,
      className: [n.className?.includes("dim") && "dim", up ? "raised" : "peek"].filter(Boolean).join(" ") || undefined,
    };
    tree.slice(0, MAX_CARDS).forEach(({ sub, depth }, i) => {
      const w = CARD_W - depth * INDENT;
      out.push({
        ...base,
        id: `${NODE_PREFIX}${n.id}:${sub.id}`,
        position: { x: x + depth * INDENT, y: origin.y + i * (CARD_H + CARD_GAP) },
        width: w,
        height: CARD_H,
        style: { width: w, height: CARD_H },
        data: { pane: n.id, sub, depth } satisfies SubagentData,
      });
    });
    if (tree.length > MAX_CARDS) {
      out.push({
        ...base,
        id: `${NODE_PREFIX}${n.id}:more`,
        position: { x, y: origin.y + MAX_CARDS * (CARD_H + CARD_GAP) },
        width: CARD_W,
        height: MORE_H,
        style: { width: CARD_W, height: MORE_H },
        data: { pane: n.id, depth: 0, more: tree.length - MAX_CARDS } satisfies SubagentData,
      });
    }
  }
  // The same empty lists each time, so a map without subagents doesn't re-render as the clock ticks.
  return { below: below.length > 0 ? below : NONE, above: above.length > 0 ? above : NONE };
}

