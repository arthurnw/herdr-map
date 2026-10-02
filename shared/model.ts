// Converts a herdr `session.snapshot` into the grouped view model the canvas renders.
import type { WorkspaceGit } from "./git.ts";
import type { AgentHunk, HunkReview } from "./hunk.ts";

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
  worktree?: { repo_key: string; repo_name: string; is_linked_worktree: boolean; checkout_path?: string; repo_root?: string };
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
  /** Working directory of the pane's foreground process, such as the agent. */
  foreground_cwd?: string;
  agent?: string;
  agent_status?: AgentStatus;
  terminal_title_stripped?: string;
  tokens?: Tokens;
  /** The agent's own session, reported by herdr's Claude Code and Codex integrations. */
  agent_session?: { source: string; agent: string; kind: string; value: string };
  /** Rows of herdr's own scrollback; 0 for an app on the alternate screen, such as fullscreen Claude Code. */
  scroll?: { max_offset_from_bottom: number; offset_from_bottom: number; viewport_rows: number };
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
  /** Set while a working agent looks stuck: no screen change for a while, or a limit or error banner. */
  stuck?: { reason: StuckReason; since: number };
  /** The agent's native session ID, when herdr knows it. */
  sessionId?: string;
  /** Context use and recorded cost, read from the agent's transcript by the usage probe. */
  usage?: AgentUsage;
  /** Subagents running or finished recently, running first. Nested ones name their `parent`. */
  subagents?: SubagentInfo[];
  /** Codex's automatic approval reviews, which run as hidden subagents. */
  reviews?: { running: number; done: number };
  /** Progress through the agent's own todo list. */
  tasks?: TaskProgress;
  /** Resident memory of the pane's process tree, measured by the memory probe. */
  memory?: AgentMemory;
  /** Counts from the hunk reviews this agent owns; the notes are on its workspace's `hunk`. */
  hunk?: AgentHunk;
}

export interface AgentMemory {
  bytes: number;
  processes: number;
  /** The heaviest commands in the tree by basename, heaviest first. */
  top: { name: string; bytes: number; count: number }[];
}

/** Memory across the agent panes the probe measured, each process counted once. */
export interface FleetMemory {
  bytes: number;
  agents: number;
  /** Physical memory of the machine the agents run on. */
  machineBytes?: number;
}

export interface SubagentInfo {
  id: string;
  type?: string;
  /** Codex: the nickname Codex gave the thread. */
  name?: string;
  description?: string;
  status: "running" | "done" | "failed" | "stopped";
  /** Epoch ms, from the transcripts. */
  startedAt?: number;
  endedAt?: number;
  /** Tokens of its latest turn: the context it saw plus its output. */
  tokens?: number;
  costUsd?: number;
  toolCalls?: number;
  /** ID of the subagent that started this one. */
  parent?: string;
  /** Whether its transcript can be read with `/api/subagent`. */
  transcript?: boolean;
}

export interface TaskProgress {
  done: number;
  total: number;
  /** The task in progress. */
  current?: string;
}

export interface AgentUsage {
  model?: string;
  /** Input-side tokens of the latest turn. */
  contextTokens?: number;
  /** The model's context window, when the transcript records it or the model is known. */
  contextWindow?: number;
  /** Total the agent recorded as spent in this session. Only Pi records cost. */
  costUsd?: number;
  /** Epoch ms when these numbers last changed. */
  updatedAt: number;
}

export type StuckReason = "no-output" | "rate-limit" | "error";

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
  /** Branch, changes, and PR of the repo its agents work in, from the git probe. */
  git?: WorkspaceGit;
  /** Live hunk reviews of the repo this workspace works in, from the hunk probe. */
  hunk?: HunkReview[];
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
  memory?: FleetMemory;
}

export interface StatusMark {
  status: AgentStatus;
  since: number;
  approx: boolean;
}

/** Remembers when each pane's agent entered its current status across polls. */
/** How long an agent must stay idle after working before its turn counts as finished. */
export const FINISH_GRACE_MS = 2500;

interface Track {
  /** The status herdr reported. */
  raw: AgentStatus;
  /** When the agent left working or blocked for idle; cleared once the grace period passes. */
  finishing?: number;
  /** Finished and not yet looked at. */
  held: boolean;
  mark: StatusMark;
}

/**
 * Tracks each agent's status across polls and when it entered it.
 *
 * herdr turns `done` into `idle` as soon as its server counts the finish as seen, often
 * within seconds, so a finished agent would fade before you notice it. The clock keeps
 * reporting `done` from the end of a turn until the pane is next focused, the same rule
 * herdr-radar uses: a pane counts as looked at when focus moves to it, or when
 * herdr-map focuses it (`markSeen`).
 */
export class StatusClock {
  private tracks = new Map<string, Track>();
  private primed = false;
  private lastFocused?: string;
  private seen = new Set<string>();

  /** Clears a held `done`, for example after herdr-map focuses the pane. */
  markSeen(paneId: string) {
    this.seen.add(paneId);
  }

  observe(
    agents: { pane_id: string; agent_status: AgentStatus }[],
    now: number,
    focusedPaneId?: string,
  ): Map<string, StatusMark> {
    const next = new Map<string, Track>();
    for (const a of agents) {
      const prev = this.tracks.get(a.pane_id);
      const raw = a.agent_status;
      let held = prev?.held ?? false;
      let finishing = prev?.finishing;
      if (raw === "working" || raw === "blocked") {
        held = false;
        finishing = undefined;
      } else if (raw === "done") {
        held = true;
        finishing = undefined;
      } else if (raw === "idle" && prev && (prev.raw === "working" || prev.raw === "blocked")) {
        finishing = now;
      }
      // A short idle between steps of one turn doesn't count as finishing.
      if (finishing !== undefined && raw === "idle" && now - finishing >= FINISH_GRACE_MS) {
        held = true;
        finishing = undefined;
      }
      const focusedNow = focusedPaneId === a.pane_id && this.lastFocused !== a.pane_id;
      if (held && (focusedNow || this.seen.has(a.pane_id)) && raw !== "done") held = false;

      const status: AgentStatus = held ? "done" : raw;
      const mark = prev && prev.mark.status === status ? prev.mark : { status, since: now, approx: !this.primed };
      next.set(a.pane_id, { raw, finishing, held, mark });
    }
    this.tracks = next;
    this.primed = true;
    this.lastFocused = focusedPaneId;
    this.seen.clear();
    return new Map([...next].map(([id, t]) => [id, t.mark]));
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
  const counts: Record<AgentStatus, number> = { blocked: 0, done: 0, working: 0, idle: 0, unknown: 0 };

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
          // The clock's status holds `done` until the pane is looked at; see StatusClock.
          const status = mark?.status ?? a.agent_status;
          agent = {
            kind: a.agent,
            name: a.name,
            status,
            since: mark?.since ?? Date.now(),
            sinceApprox: mark?.approx ?? true,
            summary: p.tokens?.summary,
            sessionId: p.agent_session?.kind === "id" ? p.agent_session.value : undefined,
          };
          counts[status] = (counts[status] ?? 0) + 1;
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

/** Every pane in the fleet, in workspace and tab order. */
export function fleetPanes(fleet: Fleet | undefined): FleetPane[] {
  return (fleet?.groups ?? []).flatMap((g) => g.workspaces.flatMap((ws) => ws.tabs.flatMap((t) => t.panes)));
}
