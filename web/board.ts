// Columns, card order, and arrow-key movement for the board view, kept free of React so they run under node:test.
import type { Fleet, FleetAgent, FleetPane, FleetWorkspace } from "../shared/model.ts";
import { attentionReason, waitingSince } from "./needs-you.ts";
import type { Direction } from "./spatial.ts";

export type ColumnId = "needs" | "working" | "done" | "idle" | "unknown";

export const COLUMN_TITLES: Record<ColumnId, string> = {
  needs: "Needs you",
  working: "Working",
  done: "Done",
  idle: "Idle",
  unknown: "Unknown",
};

const ORDER: ColumnId[] = ["needs", "working", "done", "idle", "unknown"];

/** An agent card on the board: a Located agent pane with its repo's label. */
export interface BoardCard {
  pane: FleetPane;
  tabId: string;
  tabLabel: string;
  workspace: FleetWorkspace;
  repo: string;
}

export interface BoardColumn {
  id: ColumnId;
  title: string;
  /** The cards the filters leave, in display order. */
  cards: BoardCard[];
}

/** Every agent in the fleet, in fleet order. */
export function boardCards(fleet: Fleet | undefined): BoardCard[] {
  const out: BoardCard[] = [];
  for (const g of fleet?.groups ?? [])
    for (const ws of g.workspaces)
      for (const tab of ws.tabs)
        for (const pane of tab.panes)
          if (pane.agent) out.push({ pane, tabId: tab.id, tabLabel: tab.label, workspace: ws, repo: g.label });
  return out;
}

/**
 * The column an agent belongs in. Needs you takes whatever Needs you lists except finished
 * agents, which get their own column, unless they also have unread review notes.
 */
export function columnFor(agent: FleetAgent, unread: number): ColumnId {
  const reason = attentionReason(agent, unread);
  if (reason && (reason !== "done" || unread > 0)) return "needs";
  return agent.status === "blocked" ? "needs" : agent.status;
}

/** When the card's current wait or status began. */
function sinceFor(column: ColumnId, agent: FleetAgent): number {
  return column === "needs" ? waitingSince(agent) : agent.since;
}

interface ColumnOptions {
  unread: (paneId: string) => number;
  isStarred: (paneId: string) => boolean;
  /** False for cards the status and text filters hide. */
  shown: (card: BoardCard) => boolean;
}

/**
 * Cards sorted into columns: starred first, then the longest waiting first in Needs you and
 * Done, and the most recent first elsewhere. Unknown appears only when an agent is in it,
 * filtered or not.
 */
export function boardColumns(cards: BoardCard[], { unread, isStarred, shown }: ColumnOptions): BoardColumn[] {
  const byColumn = new Map<ColumnId, BoardCard[]>(ORDER.map((id) => [id, []]));
  const present = new Set<ColumnId>();
  for (const card of cards) {
    const id = columnFor(card.pane.agent!, unread(card.pane.id));
    present.add(id);
    if (shown(card)) byColumn.get(id)!.push(card);
  }
  return ORDER.filter((id) => id !== "unknown" || present.has(id)).map((id) => {
    const oldestFirst = id === "needs" || id === "done";
    const sorted = byColumn.get(id)!.sort((a, b) => {
      const star = Number(isStarred(b.pane.id)) - Number(isStarred(a.pane.id));
      if (star) return star;
      const diff = sinceFor(id, a.pane.agent!) - sinceFor(id, b.pane.agent!);
      return (oldestFirst ? diff : -diff) || a.pane.id.localeCompare(b.pane.id);
    });
    return { id, title: COLUMN_TITLES[id], cards: sorted };
  });
}

/**
 * The card an arrow key moves to. Up and down stay in the column and stop at its ends; left
 * and right go to the nearest column with cards, at the same row or its last card. With
 * nothing selected, or a selection that isn't on the board, the first card is picked.
 */
export function moveOnBoard(columns: string[][], selected: string | undefined, dir: Direction): string | undefined {
  const filled = columns.filter((c) => c.length > 0);
  const col = filled.findIndex((c) => selected !== undefined && c.includes(selected));
  if (col < 0) return filled[0]?.[0];
  const row = filled[col].indexOf(selected!);
  if (dir === "up") return filled[col][row - 1];
  if (dir === "down") return filled[col][row + 1];
  const next = filled[col + (dir === "right" ? 1 : -1)];
  return next?.[Math.min(row, next.length - 1)];
}
