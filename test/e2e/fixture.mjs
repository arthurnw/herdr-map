// A made-up herdr session for end-to-end tests: two repos plus a scratch workspace,
// with agents in every interesting state. Shaped like `herdr api snapshot` output.

const ws = (id, label, number, repo, linked = false) => ({
  workspace_id: id,
  label,
  number,
  focused: id === "w1",
  ...(repo && { worktree: { repo_key: `/repos/${repo}/.git`, repo_name: repo, is_linked_worktree: linked } }),
});

const tab = (id, label, number = 1) => ({ tab_id: id, workspace_id: id.split(":")[0], label, number, focused: id === "w1:t1" });

const pane = (id, tabId, title, agent) => ({
  pane_id: id,
  tab_id: tabId,
  workspace_id: id.split(":")[0],
  focused: id === "w1:p1",
  cwd: `/repos/${id.split(":")[0]}`,
  terminal_title_stripped: title,
  ...(agent && { agent: agent.kind, agent_status: agent.status }),
  ...(agent?.tokens && { tokens: agent.tokens }),
});

// Two panes side by side, 60/40.
const split = (tabId, left, right) => ({
  tab_id: tabId,
  zoomed: false,
  area: { x: 0, y: 0, width: 200, height: 50 },
  panes: [
    { pane_id: left, rect: { x: 0, y: 0, width: 120, height: 50 } },
    { pane_id: right, rect: { x: 120, y: 0, width: 80, height: 50 } },
  ],
});

export const AGENTS = {
  "w1:p1": { kind: "claude", status: "working", name: "lead", tokens: { summary: "Refactor the auth middleware" } },
  "w2:p3": { kind: "pi", status: "blocked", tokens: { summary: "Pick a deploy target" } },
  "w2:p4": { kind: "codex", status: "done", tokens: { summary: "Rewrite the token cache" } },
  "w3:p5": { kind: "codex", status: "idle", tokens: { parent: "w1:p1" } },
  "w4:p7": { kind: "claude", status: "done", name: "stylist" },
  "w5:p9": { kind: "pi", status: "idle" },
};

export function snapshot() {
  const panes = [
    pane("w1:p1", "w1:t1", "✳ Claude Code", AGENTS["w1:p1"]),
    pane("w1:p2", "w1:t1", "hunk"),
    pane("w2:p3", "w2:t1", "π - api-auth", AGENTS["w2:p3"]),
    pane("w2:p4", "w2:t1", "codex", AGENTS["w2:p4"]),
    pane("w3:p5", "w3:t1", "codex", AGENTS["w3:p5"]),
    pane("w3:p6", "w3:t2", "nvim billing.ts"),
    pane("w4:p7", "w4:t1", "✳ Claude Code", AGENTS["w4:p7"]),
    pane("w4:p8", "w4:t1", "dev@host:~/repos/web"),
    pane("w5:p9", "w5:t1", "π - web-redesign", AGENTS["w5:p9"]),
    pane("w6:p10", "w6:t1", "dev@host:~/scratch"),
  ];
  return {
    id: "cli:api:snapshot",
    result: {
      snapshot: {
        version: "0.9.1",
        focused_pane_id: "w1:p1",
        workspaces: [
          ws("w1", "api", 1, "api"),
          ws("w2", "api-auth", 2, "api", true),
          ws("w3", "api-billing", 3, "api", true),
          ws("w4", "web", 4, "web"),
          ws("w5", "web-redesign", 5, "web", true),
          ws("w6", "scratch", 6),
        ],
        tabs: [tab("w1:t1", "main"), tab("w2:t1", "agents"), tab("w3:t1", "1"), tab("w3:t2", "editor", 2), tab("w4:t1", "1"), tab("w5:t1", "1"), tab("w6:t1", "1")],
        panes,
        agents: Object.entries(AGENTS).map(([pane_id, a]) => ({
          pane_id,
          agent: a.kind,
          agent_status: a.status,
          ...(a.name && { name: a.name }),
        })),
        layouts: [split("w1:t1", "w1:p1", "w1:p2"), split("w2:t1", "w2:p3", "w2:p4"), split("w4:t1", "w4:p7", "w4:p8")],
      },
    },
  };
}

/** Sets an agent's status in a snapshot, in both the agent and pane records. */
export function setStatus(snap, paneId, status) {
  const s = snap.result.snapshot;
  s.agents.find((a) => a.pane_id === paneId).agent_status = status;
  s.panes.find((p) => p.pane_id === paneId).agent_status = status;
  return snap;
}

// Screens returned by `pane read`, keyed by pane ID. Others get a generic screen.
export const SCREENS = {
  // A Pi-style ask_user picker, which herdr reports as blocked.
  "w2:p3": [
    " ask_user 1 question(s) (Deploy)",
    " Choose a target:",
    "❯ 1. Staging",
    "  2. Production",
    "  3. Type your own",
    " Enter confirm · Esc dismiss",
  ].join("\n"),
  // A Codex-style picker, which herdr leaves at idle.
  "w3:p5": [
    "  Select Model and Effort",
    "  1. Model A (default)  Fast",
    "› 2. Model B (current)  Careful",
    "  3. Model C            Cheap",
    "  enter select · esc back",
  ].join("\n"),
};
