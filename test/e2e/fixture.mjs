// A made-up herdr session for end-to-end tests: two repos plus a scratch workspace,
// with agents in every interesting state. Shaped like `herdr api snapshot` output.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Synthetic agent transcripts for the usage probe, copied so checks can append to them.
// run.mjs passes its environment to the server, and the probe finds Claude Code, Codex,
// and Pi files through these variables instead of the real home directory.
export const TRANSCRIPTS = mkdtempSync(join(tmpdir(), "herdr-map-e2e-transcripts-"));
cpSync(join(dirname(fileURLToPath(import.meta.url)), "transcripts"), TRANSCRIPTS, { recursive: true });
process.on("exit", () => rmSync(TRANSCRIPTS, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = join(TRANSCRIPTS, "claude");
process.env.CODEX_HOME = join(TRANSCRIPTS, "codex");
process.env.PI_CODING_AGENT_DIR = join(TRANSCRIPTS, "pi");
const piSession = (dir, file) => join(TRANSCRIPTS, "pi", "sessions", dir, file);

// Codex files a subagent's rollout under the day it starts, and the probe looks only at recent
// days, so these are written at startup: a running subagent of the w2:p4 thread with a finished
// subagent of its own, and a running approval review.
export const CODEX_PARENT = "01a08b30-6600-7000-8000-00000000c0de";
export const CODEX_CHILD = codexId(1);
export const CODEX_GRANDCHILD = codexId(2);
function codexId(n) {
  const hex = Date.now().toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-00000000e2e${n}`;
}
function writeCodexRollout(id, source, events, meta = {}) {
  const d = new Date();
  const dir = join(TRANSCRIPTS, "codex", "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const at = (ago) => new Date(Date.now() - ago).toISOString();
  const lines = [{ timestamp: at(120_000), ordinal: 0, type: "session_meta", payload: { id, timestamp: at(120_000), source, subagent_history_start_ordinal: 2, ...meta } }];
  events.forEach(([ago, type, payload], i) => lines.push({ timestamp: at(ago), ordinal: i + 1, type, payload }));
  writeFileSync(join(dir, `rollout-e2e-${id}.jsonl`), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}
const spawn = (parent, path, depth, role) => ({ subagent: { thread_spawn: { parent_thread_id: parent, depth, agent_path: path, agent_nickname: "Noether", agent_role: role } } });
writeCodexRollout(CODEX_CHILD, spawn(CODEX_PARENT, "/root/token_cache_review", 1, "reviewer"), [
  // Copied from the parent's history, before `subagent_history_start_ordinal`.
  [100_000, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic parent history." }] }],
  [100_000, "event_msg", { type: "task_complete" }],
  [90_000, "event_msg", { type: "task_started" }],
  [85_000, "response_item", { type: "custom_tool_call", name: "exec", input: "tools.exec_command({cmd: 'git diff'})" }],
  [60_000, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic review note." }] }],
  [60_000, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 41_900, output_tokens: 100, total_tokens: 42_000 } } }],
], { subagent_history_start_ordinal: 3 });
writeCodexRollout(CODEX_GRANDCHILD, spawn(CODEX_CHILD, "/root/token_cache_review/lint", 2, null), [
  [100_000, "event_msg", { type: "task_complete" }],
  [80_000, "event_msg", { type: "task_started" }],
  [70_000, "response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "npm run lint" }) }],
  [40_000, "event_msg", { type: "task_complete" }],
]);
writeCodexRollout(codexId(3), { subagent: { other: "guardian" } }, [[5000, "event_msg", { type: "task_started" }]], { parent_thread_id: CODEX_PARENT });

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
  ...(agent?.session && { agent_session: { source: `herdr:${agent.kind}`, agent: agent.kind, kind: "id", value: agent.session } }),
  ...(agent?.sessionPath && { agent_session: { source: `herdr:${agent.kind}`, agent: agent.kind, kind: "path", value: agent.sessionPath } }),
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
  "w1:p1": {
    kind: "claude",
    status: "working",
    name: "lead",
    tokens: { summary: "Refactor the auth middleware" },
    session: "1fcd536a-ca43-43bf-8d03-a6ed74098343",
  },
  "w2:p3": {
    kind: "pi",
    status: "blocked",
    tokens: { summary: "Pick a deploy target" },
    sessionPath: piSession("--repos-w2--", "2026-09-29T09-00-00-000Z_01a0e000-0000-7000-8000-0000000000a2.jsonl"),
  },
  "w2:p4": { kind: "codex", status: "done", tokens: { summary: "Rewrite the token cache" }, session: "01a08b30-6600-7000-8000-00000000c0de" },
  "w3:p5": { kind: "codex", status: "idle", tokens: { parent: "w1:p1" } },
  // herdr reports this agent's first session, but the conversation has moved to a background
  // job (see PROCESS_INFO and transcripts/claude/sessions), whose transcript has the real numbers.
  "w4:p7": { kind: "claude", status: "done", name: "stylist", session: "5a1e0bad-0000-4000-8000-00000000c1a0" },
  "w5:p9": {
    kind: "pi",
    status: "idle",
    sessionPath: piSession("--repos-w5--", "2026-09-29T10-00-00-000Z_01a0e000-0000-7000-8000-0000000000a5.jsonl"),
  },
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

// `pane process-info` results, keyed by pane ID. Other panes aren't found.
export const PROCESS_INFO = {
  "w4:p7": {
    id: "cli:pane:process_info",
    result: {
      type: "pane_process_info",
      process_info: {
        pane_id: "w4:p7",
        shell_pid: 4700,
        foreground_process_group_id: 4701,
        foreground_processes: [{ pid: 4701, argv0: "claude", argv: ["claude"], name: "2.1.284", cwd: "/repos/w4" }],
      },
    },
  },
};

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

// Screens that checks write on demand, so the default session stays as it is.
export const RATE_LIMIT_SCREEN = [
  "✻ Refactoring the auth middleware",
  "  ⎿ API Error: 429 Too Many Requests · Retrying in 8 seconds… (attempt 3/10)",
  "✳ Waiting… (2m 10s · esc to interrupt)",
].join("\n");
