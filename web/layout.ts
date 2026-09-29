// Places repo groups, workspaces, tabs, and panes on the canvas.
// Positions are deterministic so the map keeps its shape between polls.
import type { Edge, Node } from "@xyflow/react";
import type { Fleet, FleetGroup, FleetPane, FleetTab, FleetWorkspace } from "../shared/model.ts";

export const TAB_W = 300;
const TAB_HEADER = 22;
const TAB_MIN_H = 110;
const TAB_MAX_H = 240;
const WS_HEADER = 30;
const GROUP_HEADER = 56;
const PAD = 12;
const GAP = 16;
const ROW_MAX_W = 2400;
// Target width-to-height ratio of the whole map, close to a landscape viewport.
const MAP_ASPECT = 1.5;

export interface LayoutOptions {
  agentsOnly: boolean;
}

export type GroupData = { group: FleetGroup };
export type WorkspaceData = { workspace: FleetWorkspace };
export type TabData = { tab: FleetTab; workspaceId: string };
export type PaneData = { pane: FleetPane };

interface Box {
  w: number;
  h: number;
}

function tabBox(tab: FleetTab): Box {
  const body = Math.min(TAB_MAX_H, Math.max(TAB_MIN_H, TAB_W / tab.aspect));
  return { w: TAB_W, h: TAB_HEADER + body };
}

function workspaceBox(ws: FleetWorkspace): Box {
  const tabs = ws.tabs.map(tabBox);
  const w = tabs.reduce((sum, t) => sum + t.w, 0) + GAP * Math.max(0, tabs.length - 1) + PAD * 2;
  const h = WS_HEADER + Math.max(TAB_MIN_H, ...tabs.map((t) => t.h)) + PAD;
  return { w: Math.max(w, TAB_W + PAD * 2), h };
}

export function layoutFleet(fleet: Fleet, opts: LayoutOptions): { nodes: Node[]; edges: Edge[] } {
  const edges: Edge[] = [];
  const paneIds = new Set<string>();
  const packed: { node: Node; children: Node[]; w: number; h: number }[] = [];

  for (const group of fleet.groups) {
    const workspaces = group.workspaces.filter((ws) => !opts.agentsOnly || ws.agentCount > 0);
    if (workspaces.length === 0) continue;

    // Shelf-pack workspaces into rows inside the group.
    const groupId = `group:${group.key}`;
    const children: Node[] = [];
    let x = PAD;
    let y = GROUP_HEADER;
    let rowH = 0;
    let groupW = 0;
    for (const ws of workspaces) {
      const box = workspaceBox(ws);
      if (x > PAD && x + box.w > ROW_MAX_W) {
        x = PAD;
        y += rowH + GAP;
        rowH = 0;
      }
      const wsId = `ws:${ws.id}`;
      children.push({
        id: wsId,
        type: "workspace",
        parentId: groupId,
        position: { x, y },
        width: box.w,
        height: box.h,
        style: { width: box.w, height: box.h },
        data: { workspace: ws } satisfies WorkspaceData,
      });

      let tabX = PAD;
      for (const tab of ws.tabs) {
        const tb = tabBox(tab);
        const tabId = `tab:${tab.id}`;
        children.push({
          id: tabId,
          type: "tab",
          parentId: wsId,
          position: { x: tabX, y: WS_HEADER },
          width: tb.w,
          height: tb.h,
          style: { width: tb.w, height: tb.h },
          data: { tab, workspaceId: ws.id } satisfies TabData,
        });
        const bodyH = tb.h - TAB_HEADER;
        for (const pane of tab.panes) {
          paneIds.add(pane.id);
          children.push({
            id: pane.id,
            type: "pane",
            parentId: tabId,
            position: { x: pane.rect.x * tb.w + 2, y: TAB_HEADER + pane.rect.y * bodyH + 2 },
            width: Math.max(8, pane.rect.w * tb.w - 4),
            height: Math.max(8, pane.rect.h * bodyH - 4),
            data: { pane } satisfies PaneData,
          });
        }
        tabX += tb.w + GAP;
      }

      x += box.w + GAP;
      rowH = Math.max(rowH, box.h);
      groupW = Math.max(groupW, x - GAP + PAD);
    }
    const groupH = y + rowH + PAD;
    packed.push({
      node: {
        id: groupId,
        type: "group-box",
        position: { x: 0, y: 0 },
        width: groupW,
        height: groupH,
        style: { width: groupW, height: groupH },
        data: { group: { ...group, workspaces } } satisfies GroupData,
        selectable: false,
      },
      children,
      w: groupW,
      h: groupH,
    });
  }

  // Shelf-pack the groups into rows sized so the whole map is roughly landscape.
  const GROUP_GAP = GAP * 3;
  const area = packed.reduce((sum, g) => sum + (g.w + GROUP_GAP) * (g.h + GROUP_GAP), 0);
  const rowMax = Math.max(Math.sqrt(area * MAP_ASPECT), ...packed.map((g) => g.w));
  const nodes: Node[] = [];
  let gx = 0;
  let gy = 0;
  let shelfH = 0;
  for (const g of packed) {
    if (gx > 0 && gx + g.w > rowMax) {
      gx = 0;
      gy += shelfH + GROUP_GAP;
      shelfH = 0;
    }
    g.node.position = { x: gx, y: gy };
    nodes.push(g.node, ...g.children);
    gx += g.w + GROUP_GAP;
    shelfH = Math.max(shelfH, g.h);
  }

  // Lineage edges come from a `parent` pane token; see README.
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
