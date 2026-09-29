// Converts a herdr `session.snapshot` into the grouped view model the canvas renders.

export type AgentStatus = "working" | "blocked" | "done" | "idle" | "unknown";

export const STATUSES: AgentStatus[] = ["blocked", "done", "working", "idle", "unknown"];

type Tokens = Record<string, string>;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapWorkspace {
  workspace_id: string;
  label: string;
  number: number;
  focused: boolean;
  worktree?: { repo_key: string; repo_name: string; is_linked_worktree: boolean };
}

export interface SnapTab {
  tab_id: string;
  workspace_id: string;
  label: string;
  number: number;
  focused: boolean;
}

export interface SnapPane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  focused: boolean;
  cwd?: string;
  agent?: string;
  agent_status?: AgentStatus;
  terminal_title_stripped?: string;
  tokens?: Tokens;
}

export interface SnapAgent {
  pane_id: string;
  agent: string;
  agent_status: AgentStatus;
  name?: string;
}

export interface SnapLayout {
  tab_id: string;
  area: Rect;
  zoomed: boolean;
  focused_pane_id?: string;
  panes: { pane_id: string; rect: Rect }[];
}

export interface Snapshot {
  version: string;
  focused_pane_id?: string;
  workspaces: SnapWorkspace[];
  tabs: SnapTab[];
  panes: SnapPane[];
  agents: SnapAgent[];
  layouts: SnapLayout[];
}

export interface FleetAgent {
  kind: string;
  name?: string;
  status: AgentStatus;
  /** Epoch ms when this status was first observed. */
  since: number;
  /** True when the status predates the first poll, so `since` is a lower bound. */
  sinceApprox: boolean;
  summary?: string;
}

export interface FleetPane {
  id: string;
  /** Position within the tab as fractions of the tab area. */
  rect: { x: number; y: number; w: number; h: number };
  title: string;
  cwd?: string;
  focused: boolean;
  agent?: FleetAgent;
  /** Pane ID of the agent that spawned this pane, from the `parent` pane token. */
  parent?: string;
}

export interface FleetTab {
  id: string;
  label: string;
  focused: boolean;
  /** Pixel aspect ratio (width / height) of the tab's terminal area. */
  aspect: number;
  panes: FleetPane[];
}

export interface FleetWorkspace {
  id: string;
  label: string;
  number: number;
  focused: boolean;
  linkedWorktree: boolean;
  agentCount: number;
  tabs: FleetTab[];
}

export interface FleetGroup {
  key: string;
  label: string;
  workspaces: FleetWorkspace[];
}

export interface Fleet {
  version: string;
  groups: FleetGroup[];
  counts: Record<AgentStatus, number>;
  focusedPaneId?: string;
}

export interface StatusMark {
  status: AgentStatus;
  since: number;
  approx: boolean;
}

/** Remembers when each pane's agent entered its current status across polls. */
export class StatusClock {
  private marks = new Map<string, StatusMark>();
  private primed = false;

  observe(agents: { pane_id: string; agent_status: AgentStatus }[], now: number): Map<string, StatusMark> {
    const next = new Map<string, StatusMark>();
    for (const a of agents) {
      const prev = this.marks.get(a.pane_id);
      if (prev && prev.status === a.agent_status) next.set(a.pane_id, prev);
      else next.set(a.pane_id, { status: a.agent_status, since: now, approx: !this.primed });
    }
    this.marks = next;
    this.primed = true;
    return next;
  }
}

// Cell pixels are roughly twice as tall as wide in common terminal fonts.
const CELL_ASPECT = 8 / 17;

const SHELL_TITLE = /^[^\s@]+@[^\s:]+:(.*)$/;

export function paneTitle(raw: string | undefined): string {
  const title = (raw ?? "").trim();
  const shell = SHELL_TITLE.exec(title);
  if (shell) return `shell ${shell[1]}`;
  return title || "shell";
}

function fractionalRects(layout: SnapLayout | undefined, paneIds: string[]): Map<string, FleetPane["rect"]> {
  const out = new Map<string, FleetPane["rect"]>();
  if (layout && layout.area.width > 0 && layout.area.height > 0) {
    const { area } = layout;
    for (const p of layout.panes) {
      out.set(p.pane_id, {
        x: (p.rect.x - area.x) / area.width,
        y: (p.rect.y - area.y) / area.height,
        w: p.rect.width / area.width,
        h: p.rect.height / area.height,
      });
    }
  }
  // Panes missing from the layout (or a missing layout) get equal columns.
  const missing = paneIds.filter((id) => !out.has(id));
  missing.forEach((id, i) => out.set(id, { x: i / missing.length, y: 0, w: 1 / missing.length, h: 1 }));
  return out;
}

export function buildFleet(snap: Snapshot, marks: Map<string, StatusMark>): Fleet {
  const agentsByPane = new Map(snap.agents.map((a) => [a.pane_id, a]));
  const layoutsByTab = new Map(snap.layouts.map((l) => [l.tab_id, l]));
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<AgentStatus, number>;

  const panesByTab = new Map<string, SnapPane[]>();
  for (const p of snap.panes) {
    const list = panesByTab.get(p.tab_id) ?? [];
    list.push(p);
    panesByTab.set(p.tab_id, list);
  }

  const tabsByWorkspace = new Map<string, SnapTab[]>();
  for (const t of [...snap.tabs].sort((a, b) => a.number - b.number)) {
    const list = tabsByWorkspace.get(t.workspace_id) ?? [];
    list.push(t);
    tabsByWorkspace.set(t.workspace_id, list);
  }

  const groups = new Map<string, FleetGroup>();
  for (const ws of [...snap.workspaces].sort((a, b) => a.number - b.number)) {
    let agentCount = 0;
    const tabs: FleetTab[] = (tabsByWorkspace.get(ws.workspace_id) ?? []).map((t) => {
      const snapPanes = panesByTab.get(t.tab_id) ?? [];
      const layout = layoutsByTab.get(t.tab_id);
      const rects = fractionalRects(layout, snapPanes.map((p) => p.pane_id));
      const panes = snapPanes.map((p): FleetPane => {
        const a = agentsByPane.get(p.pane_id);
        let agent: FleetAgent | undefined;
        if (a) {
          const mark = marks.get(p.pane_id);
          agent = {
            kind: a.agent,
            name: a.name,
            status: a.agent_status,
            since: mark?.since ?? Date.now(),
            sinceApprox: mark?.approx ?? true,
            summary: p.tokens?.summary,
          };
          counts[a.agent_status] = (counts[a.agent_status] ?? 0) + 1;
          agentCount++;
        }
        return {
          id: p.pane_id,
          rect: rects.get(p.pane_id)!,
          title: paneTitle(p.terminal_title_stripped),
          cwd: p.cwd,
          focused: p.pane_id === snap.focused_pane_id,
          agent,
          parent: p.tokens?.parent,
        };
      });
      const area = layout?.area;
      const aspect = area && area.height > 0 ? area.width / (area.height / CELL_ASPECT) : 16 / 9;
      return { id: t.tab_id, label: t.label, focused: t.focused, aspect, panes };
    });

    const key = ws.worktree?.repo_key ?? "__other__";
    const group = groups.get(key) ?? {
      key,
      label: ws.worktree?.repo_name ?? "Other workspaces",
      workspaces: [],
    };
    group.workspaces.push({
      id: ws.workspace_id,
      label: ws.label,
      number: ws.number,
      focused: ws.focused,
      linkedWorktree: ws.worktree?.is_linked_worktree ?? false,
      agentCount,
      tabs,
    });
    groups.set(key, group);
  }

  // Repos keep the order of their first workspace; the catch-all group goes last.
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.key === "__other__") return 1;
    if (b.key === "__other__") return -1;
    return a.workspaces[0].number - b.workspaces[0].number;
  });

  return { version: snap.version, groups: ordered, counts, focusedPaneId: snap.focused_pane_id };
}
