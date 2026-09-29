import type { Snapshot } from "../shared/model.ts";

// A two-repo session: one agent tab with a hunk split, one spawned child agent,
// and a shell-only workspace.
export function snapshotFixture(): Snapshot {
  return {
    version: "0.9.1",
    focused_pane_id: "w1:p2",
    workspaces: [
      {
        workspace_id: "w2",
        label: "api-feature",
        number: 2,
        focused: false,
        worktree: { repo_key: "/r/api/.git", repo_name: "api", is_linked_worktree: true },
      },
      {
        workspace_id: "w1",
        label: "api",
        number: 1,
        focused: true,
        worktree: { repo_key: "/r/api/.git", repo_name: "api", is_linked_worktree: false },
      },
      { workspace_id: "w3", label: "scratch", number: 3, focused: false },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "main", number: 1, focused: true },
      { tab_id: "w2:t1", workspace_id: "w2", label: "work", number: 1, focused: false },
      { tab_id: "w3:t1", workspace_id: "w3", label: "shell", number: 1, focused: false },
    ],
    panes: [
      {
        pane_id: "w1:p1",
        tab_id: "w1:t1",
        workspace_id: "w1",
        focused: false,
        agent: "claude",
        agent_status: "working",
        terminal_title_stripped: "✳ Claude Code",
        tokens: { summary: "Refactor the auth middleware" },
      },
      { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", focused: true, terminal_title_stripped: "hunk" },
      {
        pane_id: "w2:p1",
        tab_id: "w2:t1",
        workspace_id: "w2",
        focused: false,
        agent: "pi",
        agent_status: "blocked",
        terminal_title_stripped: "π - api",
        tokens: { parent: "w1:p1" },
      },
      {
        pane_id: "w3:p1",
        tab_id: "w3:t1",
        workspace_id: "w3",
        focused: false,
        terminal_title_stripped: "anw@host:~/scratch",
      },
    ],
    agents: [
      { pane_id: "w1:p1", agent: "claude", agent_status: "working", name: "lead" },
      { pane_id: "w2:p1", agent: "pi", agent_status: "blocked" },
    ],
    layouts: [
      {
        tab_id: "w1:t1",
        zoomed: false,
        area: { x: 0, y: 0, width: 200, height: 50 },
        panes: [
          { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 120, height: 50 } },
          { pane_id: "w1:p2", rect: { x: 120, y: 0, width: 80, height: 50 } },
        ],
      },
    ],
  };
}
