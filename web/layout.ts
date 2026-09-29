// Places repo groups, workspaces, tabs, and panes on the canvas.
//
// Workspaces are top-level nodes. A repo group is drawn as the bounding box of its
// attached workspaces, so moving a workspace resizes its group, and a workspace
// dropped away from its group detaches from it.
//
// Until the user drags something, positions come from an automatic packing. After
// that, every workspace position is saved, and new workspaces are placed next to
// the other members of their group.
import type { Edge, Node } from "@xyflow/react";
import type { Fleet, FleetGroup, FleetPane, FleetTab, FleetWorkspace } from "../shared/model.ts";

export const TAB_W = 300;
const TAB_HEADER = 22;
const TAB_MIN_H = 110;
const TAB_MAX_H = 240;
export const WS_HEADER = 30;
const GROUP_HEADER = 56;
const PAD = 12;
const GAP = 16;
const GROUP_GAP = GAP * 3;
const ROW_MAX_W = 2400;
// Target width-to-height ratio of the whole map, close to a landscape viewport.
const MAP_ASPECT = 1.5;

export interface LayoutOptions {
  /** Hide workspaces that have no agents. */
  agentsOnly: boolean;
  /** Draw only agent panes, one column per agent, instead of each tab's full split layout. */
  agentPanesOnly?: boolean;
}

// Size of one agent column when only agent panes are drawn.
const COMPACT_PANE_W = 180;
const COMPACT_BODY_H = 120;
const COMPACT_MIN_W = 220;

export interface SavedPosition {
  x: number;
  y: number;
  detached?: boolean;
}

/** Saved workspace positions keyed by workspace ID. Empty means automatic layout. */
export type SavedLayout = Record<string, SavedPosition>;

export type GroupData = { group: FleetGroup; memberIds: string[] };
export type WorkspaceData = { workspace: FleetWorkspace; groupKey: string; groupLabel: string; detached: boolean };
export type TabData = { tab: FleetTab; workspaceId: string };
export type PaneData = { pane: FleetPane };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Placed extends Rect {
  ws: FleetWorkspace;
  group: FleetGroup;
  detached: boolean;
}

/** A tab as drawn. Compact tabs hold only agent panes, laid out as equal columns. */
type ViewTab = FleetTab & { compact?: boolean };

function tabSize(tab: ViewTab) {
  if (tab.compact) return { w: Math.max(COMPACT_MIN_W, COMPACT_PANE_W * tab.panes.length), h: TAB_HEADER + COMPACT_BODY_H };
  const body = Math.min(TAB_MAX_H, Math.max(TAB_MIN_H, TAB_W / tab.aspect));
  return { w: TAB_W, h: TAB_HEADER + body };
}

export function workspaceSize(ws: FleetWorkspace) {
  const tabs = ws.tabs.map(tabSize);
  const compact = ws.tabs.length > 0 && ws.tabs.every((t: ViewTab) => t.compact);
  const minTabH = compact ? TAB_HEADER + COMPACT_BODY_H : TAB_MIN_H;
  const w = tabs.reduce((sum, t) => sum + t.w, 0) + GAP * Math.max(0, tabs.length - 1) + PAD * 2;
  const h = WS_HEADER + Math.max(minTabH, ...tabs.map((t) => t.h)) + PAD;
  return { w: Math.max(w, (compact ? COMPACT_MIN_W : TAB_W) + PAD * 2), h };
}

/** Keeps a tab's agent panes in their on-screen order (left to right, then top to bottom). */
function compactTab(tab: FleetTab): ViewTab | undefined {
  const agents = tab.panes
    .filter((p) => p.agent)
    .sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
  if (agents.length === 0) return undefined;
  const n = agents.length;
  return {
    ...tab,
    compact: true,
    panes: agents.map((p, i) => ({ ...p, rect: { x: i / n, y: 0, w: 1 / n, h: 1 } })),
  };
}

function visibleGroups(fleet: Fleet, opts: LayoutOptions): FleetGroup[] {
  return fleet.groups
    .map((g) => ({
      ...g,
      workspaces: g.workspaces
        .filter((ws) => !opts.agentsOnly || ws.agentCount > 0)
        .map((ws) =>
          opts.agentPanesOnly
            ? { ...ws, tabs: ws.tabs.map(compactTab).filter((t): t is ViewTab => t !== undefined) }
            : ws,
        )
        // With agent panes only, a workspace with no agents has nothing left to draw.
        .filter((ws) => ws.tabs.length > 0 || !opts.agentPanesOnly),
    }))
    .filter((g) => g.workspaces.length > 0);
}

/** Shelf-packs workspaces into groups, then groups into a roughly landscape map. */
function autoPositions(groups: FleetGroup[]): Map<string, { x: number; y: number }> {
  const packed = groups.map((group) => {
    const local = new Map<string, { x: number; y: number }>();
    let x = PAD;
    let y = GROUP_HEADER;
    let rowH = 0;
    let w = 0;
    for (const ws of group.workspaces) {
      const size = workspaceSize(ws);
      if (x > PAD && x + size.w > ROW_MAX_W) {
        x = PAD;
        y += rowH + GAP;
        rowH = 0;
      }
      local.set(ws.id, { x, y });
      x += size.w + GAP;
      rowH = Math.max(rowH, size.h);
      w = Math.max(w, x - GAP + PAD);
    }
    return { local, w, h: y + rowH + PAD };
  });

  const area = packed.reduce((sum, g) => sum + (g.w + GROUP_GAP) * (g.h + GROUP_GAP), 0);
  const rowMax = Math.max(Math.sqrt(area * MAP_ASPECT), ...packed.map((g) => g.w));
  const out = new Map<string, { x: number; y: number }>();
  let gx = 0;
  let gy = 0;
  let shelfH = 0;
  for (const g of packed) {
    if (gx > 0 && gx + g.w > rowMax) {
      gx = 0;
      gy += shelfH + GROUP_GAP;
      shelfH = 0;
    }
    for (const [id, p] of g.local) out.set(id, { x: gx + p.x, y: gy + p.y });
    gx += g.w + GROUP_GAP;
    shelfH = Math.max(shelfH, g.h);
  }
  return out;
}

function placeWorkspaces(groups: FleetGroup[], saved: SavedLayout): Placed[] {
  const all = groups.flatMap((group) => group.workspaces.map((ws) => ({ ws, group, ...workspaceSize(ws) })));
  if (Object.keys(saved).length === 0) {
    const auto = autoPositions(groups);
    return all.map((p) => ({ ...p, ...auto.get(p.ws.id)!, detached: false }));
  }

  const placed: Placed[] = [];
  for (const p of all) {
    const s = saved[p.ws.id];
    if (s) placed.push({ ...p, x: s.x, y: s.y, detached: !!s.detached });
  }
  // A workspace with no saved position goes to the right of its group's first row,
  // or below the whole map when its group has no placed members yet.
  for (const p of all) {
    if (saved[p.ws.id]) continue;
    const mates = placed.filter((q) => q.group.key === p.group.key && !q.detached);
    let x: number;
    let y: number;
    if (mates.length > 0) {
      y = Math.min(...mates.map((q) => q.y));
      x = Math.max(...mates.map((q) => q.x + q.w)) + GAP;
    } else {
      x = PAD;
      y = placed.length ? Math.max(...placed.map((q) => q.y + q.h)) + GROUP_GAP + GROUP_HEADER : GROUP_HEADER;
    }
    placed.push({ ...p, x, y, detached: false });
  }
  return placed;
}

function groupRect(members: Rect[]): Rect {
  const x0 = Math.min(...members.map((m) => m.x)) - PAD;
  const y0 = Math.min(...members.map((m) => m.y)) - GROUP_HEADER;
  const x1 = Math.max(...members.map((m) => m.x + m.w)) + PAD;
  const y1 = Math.max(...members.map((m) => m.y + m.h)) + PAD;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function overlaps(a: Rect, b: Rect, margin: number): boolean {
  return a.x < b.x + b.w + margin && a.x + a.w > b.x - margin && a.y < b.y + b.h + margin && a.y + a.h > b.y - margin;
}

/**
 * Decides whether a dropped workspace should detach from its group: it detaches when
 * it no longer overlaps the box around the group's other attached members.
 */
export function isDetachedDrop(dropped: Rect, otherMembers: Rect[]): boolean {
  if (otherMembers.length === 0) return false;
  return !overlaps(dropped, groupRect(otherMembers), GAP * 2);
}

export function layoutFleet(
  fleet: Fleet,
  opts: LayoutOptions,
  saved: SavedLayout = {},
): { nodes: Node[]; edges: Edge[] } {
  const groups = visibleGroups(fleet, opts);
  const placed = placeWorkspaces(groups, saved);
  const nodes: Node[] = [];

  // Group boxes go first so they render beneath their workspaces.
  for (const group of groups) {
    const members = placed.filter((p) => p.group.key === group.key && !p.detached);
    if (members.length === 0) continue;
    const r = groupRect(members);
    nodes.push({
      id: `group:${group.key}`,
      type: "group-box",
      position: { x: r.x, y: r.y },
      width: r.w,
      height: r.h,
      style: { width: r.w, height: r.h },
      data: { group, memberIds: members.map((m) => m.ws.id) } satisfies GroupData,
      selectable: false,
    });
  }

  const paneIds = new Set<string>();
  for (const p of placed) {
    const wsNode = `ws:${p.ws.id}`;
    nodes.push({
      id: wsNode,
      type: "workspace",
      position: { x: p.x, y: p.y },
      width: p.w,
      height: p.h,
      style: { width: p.w, height: p.h },
      data: { workspace: p.ws, groupKey: p.group.key, groupLabel: p.group.label, detached: p.detached } satisfies WorkspaceData,
    });
    // A label that sits above the workspace's panes, shown when zoomed out. A high zIndex
    // keeps it over the tab and pane nodes, which React Flow stacks above their parents.
    nodes.push({
      id: `label:${p.ws.id}`,
      type: "ws-label",
      parentId: wsNode,
      position: { x: 0, y: 0 },
      width: p.w,
      height: WS_HEADER,
      zIndex: 1000,
      draggable: false,
      selectable: false,
      focusable: false,
      data: { workspace: p.ws, groupKey: p.group.key, groupLabel: p.group.label, detached: p.detached } satisfies WorkspaceData,
    });

    let tabX = PAD;
    for (const tab of p.ws.tabs) {
      const tb = tabSize(tab);
      const tabNode = `tab:${tab.id}`;
      nodes.push({
        id: tabNode,
        type: "tab",
        parentId: wsNode,
        position: { x: tabX, y: WS_HEADER },
        width: tb.w,
        height: tb.h,
        style: { width: tb.w, height: tb.h },
        draggable: false,
        data: { tab, workspaceId: p.ws.id } satisfies TabData,
      });
      const bodyH = tb.h - TAB_HEADER;
      for (const pane of tab.panes) {
        paneIds.add(pane.id);
        nodes.push({
          id: pane.id,
          type: "pane",
          parentId: tabNode,
          position: { x: pane.rect.x * tb.w + 2, y: TAB_HEADER + pane.rect.y * bodyH + 2 },
          width: Math.max(8, pane.rect.w * tb.w - 4),
          height: Math.max(8, pane.rect.h * bodyH - 4),
          draggable: false,
          data: { pane } satisfies PaneData,
        });
      }
      tabX += tb.w + GAP;
    }
  }

  // Lineage edges come from a `parent` pane token; see README.
  const edges: Edge[] = [];
  for (const node of nodes) {
    if (node.type !== "pane") continue;
    const { pane } = node.data as PaneData;
    if (pane.parent && paneIds.has(pane.parent)) {
      edges.push({
        id: `edge:${pane.parent}->${pane.id}`,
        source: pane.parent,
        target: pane.id,
        animated: pane.agent?.status === "working",
        zIndex: 10,
      });
    }
  }

  return { nodes, edges };
}
