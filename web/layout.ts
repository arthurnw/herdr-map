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
import type { GroupMeta, WorkspaceMeta } from "../shared/layout-types.ts";
import type { AgentStatus, Fleet, FleetGroup, FleetPane, FleetTab, FleetWorkspace } from "../shared/model.ts";

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
  /** Draw only agent panes, one row per agent, instead of each tab's full split layout. */
  agentPanesOnly?: boolean;
  /**
   * Agent statuses to filter out. Those agents are removed in the agent-panes-only view
   * and dimmed in the full layout, and they don't count toward `agentsOnly`.
   */
  hiddenStatuses?: AgentStatus[];
  /**
   * Workspace IDs being dragged. Their repo box is drawn around the other members only,
   * so it no longer stretches to follow the drag, and each gets a drop hint.
   */
  dragging?: ReadonlySet<string>;
  /** Saved metadata keyed by workspace ID; a collapsed workspace is drawn as its header only. */
  workspaceMeta?: Record<string, WorkspaceMeta>;
  /** Saved metadata keyed by repo group key. */
  groupMeta?: Record<string, GroupMeta>;
}

// When only agent panes are drawn, each agent gets a full-width row so names and
// statuses have room for long lines.
const COMPACT_TAB_W = 280;
const COMPACT_ROW_H = 76;
const COMPACT_BODY_H = 120;

export interface SavedPosition {
  x: number;
  y: number;
  detached?: boolean;
}

/** Saved workspace positions keyed by workspace ID. Empty means automatic layout. */
export type SavedLayout = Record<string, SavedPosition>;

export type GroupData = { group: FleetGroup; memberIds: string[]; color?: string };
/** What dropping a dragged workspace will do: leave its repo box, or go back into it. */
export type DropHint = "detach" | "rejoin";

export type WorkspaceData = {
  workspace: FleetWorkspace;
  groupKey: string;
  groupLabel: string;
  detached: boolean;
  /** Set only while the workspace is being dragged and the drop would change its box. */
  dropHint?: DropHint;
  /** Other workspaces still in this repo's box; a lone workspace can't leave its own box. */
  groupMates: number;
  /** Drawn as its header only, without tabs or panes. */
  collapsed: boolean;
  color?: string;
};
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

/** A tab as drawn. Compact tabs hold only agent panes, stacked as equal-height rows. */
type ViewTab = FleetTab & { compact?: boolean };

function tabSize(tab: ViewTab) {
  if (tab.compact) {
    return { w: COMPACT_TAB_W, h: TAB_HEADER + Math.max(COMPACT_BODY_H, COMPACT_ROW_H * tab.panes.length) };
  }
  const body = Math.min(TAB_MAX_H, Math.max(TAB_MIN_H, TAB_W / tab.aspect));
  return { w: TAB_W, h: TAB_HEADER + body };
}

export function workspaceSize(ws: FleetWorkspace) {
  const tabs = ws.tabs.map(tabSize);
  const compact = ws.tabs.length > 0 && ws.tabs.every((t: ViewTab) => t.compact);
  const minTabH = compact ? TAB_HEADER + COMPACT_BODY_H : TAB_MIN_H;
  const w = tabs.reduce((sum, t) => sum + t.w, 0) + GAP * Math.max(0, tabs.length - 1) + PAD * 2;
  const h = WS_HEADER + Math.max(minTabH, ...tabs.map((t) => t.h)) + PAD;
  return { w: Math.max(w, (compact ? COMPACT_TAB_W : TAB_W) + PAD * 2), h };
}

const COLLAPSED_MAX_W = 340;

/** A collapsed workspace keeps its header and, up to a limit, its width. */
function collapsedSize(ws: FleetWorkspace) {
  return { w: Math.min(workspaceSize(ws).w, COLLAPSED_MAX_W), h: WS_HEADER };
}

type SizeOf = (ws: FleetWorkspace) => { w: number; h: number };

/** Keeps a tab's agent panes in their on-screen order (left to right, then top to bottom). */
function compactTab(tab: FleetTab, shown: (p: FleetPane) => boolean): ViewTab | undefined {
  const agents = tab.panes
    .filter(shown)
    .sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
  if (agents.length === 0) return undefined;
  const n = agents.length;
  return {
    ...tab,
    compact: true,
    panes: agents.map((p, i) => ({ ...p, rect: { x: 0, y: i / n, w: 1, h: 1 / n } })),
  };
}

function statusFilter(opts: LayoutOptions) {
  const hidden = new Set(opts.hiddenStatuses ?? []);
  return {
    /** True for an agent pane whose status passes the filter. */
    shown: (p: FleetPane) => !!p.agent && !hidden.has(p.agent.status),
    /** True for an agent pane the filter removes. */
    filtered: (p: FleetPane) => !!p.agent && hidden.has(p.agent.status),
  };
}

function visibleGroups(fleet: Fleet, opts: LayoutOptions): FleetGroup[] {
  const { shown } = statusFilter(opts);
  return fleet.groups
    .map((g) => ({
      ...g,
      workspaces: g.workspaces
        .filter((ws) => !opts.agentsOnly || ws.tabs.some((t) => t.panes.some(shown)))
        .map((ws) =>
          opts.agentPanesOnly
            ? {
                ...ws,
                tabs: ws.tabs.map((t) => compactTab(t, shown)).filter((t): t is ViewTab => t !== undefined),
              }
            : ws,
        )
        // With agent panes only, a workspace with no agents has nothing left to draw.
        .filter((ws) => ws.tabs.length > 0 || !opts.agentPanesOnly),
    }))
    .filter((g) => g.workspaces.length > 0);
}

/** Shelf-packs workspaces into groups, then groups into a roughly landscape map. */
function autoPositions(groups: FleetGroup[], sizeOf: SizeOf): Map<string, { x: number; y: number }> {
  const packed = groups.map((group) => {
    const local = new Map<string, { x: number; y: number }>();
    let x = PAD;
    let y = GROUP_HEADER;
    let rowH = 0;
    let w = 0;
    for (const ws of group.workspaces) {
      const size = sizeOf(ws);
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

function placeWorkspaces(groups: FleetGroup[], saved: SavedLayout, sizeOf: SizeOf): Placed[] {
  const all = groups.flatMap((group) => group.workspaces.map((ws) => ({ ws, group, ...sizeOf(ws) })));
  if (Object.keys(saved).length === 0) {
    const auto = autoPositions(groups, sizeOf);
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

function boundsOf(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
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
  const meta = opts.workspaceMeta ?? {};
  const isCollapsed = (ws: FleetWorkspace) => !!meta[ws.id]?.collapsed;
  const placed = placeWorkspaces(groups, saved, (ws) => (isCollapsed(ws) ? collapsedSize(ws) : workspaceSize(ws)));
  const { filtered } = statusFilter(opts);
  const nodes: Node[] = [];

  const dragging = opts.dragging ?? new Set<string>();
  const hints = new Map<string, DropHint>();
  const mates = new Map<string, number>();

  // Group boxes go first so they render beneath their workspaces.
  for (const group of groups) {
    const inGroup = placed.filter((p) => p.group.key === group.key);
    const attached = inGroup.filter((p) => !p.detached);
    for (const p of inGroup) mates.set(p.ws.id, attached.filter((q) => q.ws.id !== p.ws.id).length);
    // While workspaces are dragged, the box is drawn around the members staying put, and the
    // dragged ones learn whether dropping here would take them out of the box or back in.
    const moving = inGroup.filter((p) => dragging.has(p.ws.id));
    const staying = attached.filter((p) => !dragging.has(p.ws.id));
    if (moving.length > 0 && staying.length > 0) {
      const leaving = isDetachedDrop(boundsOf(moving), staying);
      for (const p of moving) {
        if (leaving && !p.detached) hints.set(p.ws.id, "detach");
        if (!leaving && p.detached) hints.set(p.ws.id, "rejoin");
      }
    }
    const members = staying.length > 0 ? staying : attached;
    if (members.length === 0) continue;
    const r = groupRect(members);
    nodes.push({
      id: `group:${group.key}`,
      type: "group-box",
      position: { x: r.x, y: r.y },
      width: r.w,
      height: r.h,
      style: { width: r.w, height: r.h },
      data: { group, memberIds: members.map((m) => m.ws.id), color: opts.groupMeta?.[group.key]?.color } satisfies GroupData,
      selectable: false,
    });
  }

  const paneIds = new Set<string>();
  for (const p of placed) {
    const wsNode = `ws:${p.ws.id}`;
    // Shared by the workspace node and its zoomed-out label.
    const wsData: WorkspaceData = {
      workspace: p.ws,
      groupKey: p.group.key,
      groupLabel: p.group.label,
      detached: p.detached,
      dropHint: hints.get(p.ws.id),
      groupMates: mates.get(p.ws.id) ?? 0,
      collapsed: isCollapsed(p.ws),
      color: meta[p.ws.id]?.color,
    };
    nodes.push({
      id: wsNode,
      type: "workspace",
      position: { x: p.x, y: p.y },
      width: p.w,
      height: p.h,
      style: { width: p.w, height: p.h },
      data: wsData,
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
      data: wsData,
    });

    if (wsData.collapsed) continue;
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
          className: filtered(pane) ? "status-filtered" : undefined,
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
