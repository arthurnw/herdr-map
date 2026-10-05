// A made-up herdr session for end-to-end tests: two repos plus a scratch workspace,
// with agents in every interesting state. Shaped like `herdr api snapshot` output.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

// Real git repos for the git probe, and a stub gh first on PATH that answers from GH_PRS.
// Agent panes in w1, w2, w3, and w5 run in them (`foreground_cwd`); their `cwd` stays under
// /repos, where the transcripts expect it.
export const GIT = realpathSync(mkdtempSync(join(tmpdir(), "herdr-map-e2e-git-")));
process.on("exit", () => rmSync(GIT, { recursive: true, force: true }));
const pr = (number, title, rollup, extra = {}) => ({
  number,
  title,
  url: `https://github.com/example/api/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  reviewDecision: "",
  statusCheckRollup: rollup,
  ...extra,
});
const check = (name, status, conclusion = "") => ({ __typename: "CheckRun", name, workflowName: "ci", status, conclusion });
export const GH_PRS = {
  "auth-tokens": pr(42, "Add token refresh", [check("lint", "COMPLETED", "SUCCESS"), check("test", "COMPLETED", "SUCCESS")], { reviewDecision: "APPROVED" }),
  "billing-retry": pr(57, "Retry failed charges", [check("lint", "COMPLETED", "SUCCESS"), check("test", "COMPLETED", "FAILURE")], { isDraft: true }),
  redesign: pr(88, "New landing page", [check("build", "IN_PROGRESS")]),
};
export const GIT_DIRS = { w1: join(GIT, "api"), w2: join(GIT, "api-auth"), w3: join(GIT, "api-billing"), w5: join(GIT, "web-redesign") };
function setUpRepos() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.com" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: "ignore" });
  const commit = (cwd, file) => {
    writeFileSync(join(cwd, file), `${file}\n`);
    git(cwd, "add", ".");
    git(cwd, "commit", "-q", "-m", file);
  };
  const init = (dir) => {
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    commit(dir, "README.md");
  };
  git(GIT, "init", "-q", "--bare", "-b", "main", "api.git");
  init(GIT_DIRS.w1);
  git(GIT_DIRS.w1, "remote", "add", "origin", join(GIT, "api.git"));
  git(GIT_DIRS.w1, "push", "-q", "-u", "origin", "main");
  git(GIT_DIRS.w1, "remote", "set-head", "origin", "main");
  // Pushed once, then two commits ahead, with a change, a staged file, and an untracked one.
  git(GIT_DIRS.w1, "worktree", "add", "-q", "-b", "auth-tokens", GIT_DIRS.w2);
  commit(GIT_DIRS.w2, "auth.ts");
  git(GIT_DIRS.w2, "push", "-q", "-u", "origin", "auth-tokens");
  commit(GIT_DIRS.w2, "refresh.ts");
  commit(GIT_DIRS.w2, "expiry.ts");
  writeFileSync(join(GIT_DIRS.w2, "auth.ts"), "changed\n");
  writeFileSync(join(GIT_DIRS.w2, "staged.ts"), "staged\n");
  git(GIT_DIRS.w2, "add", "staged.ts");
  writeFileSync(join(GIT_DIRS.w2, "notes.txt"), "untracked\n");
  git(GIT_DIRS.w1, "worktree", "add", "-q", "-b", "billing-retry", GIT_DIRS.w3);
  init(GIT_DIRS.w5);
  git(GIT_DIRS.w5, "checkout", "-q", "-b", "redesign");

  mkdirSync(join(GIT, "bin"));
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "gh-stub.sh"), join(GIT, "bin", "gh"));
  mkdirSync(join(GIT, "gh", "prs"), { recursive: true });
  for (const [branch, body] of Object.entries(GH_PRS)) writeFileSync(join(GIT, "gh", "prs", `${branch}.json`), JSON.stringify(body));
  process.env.GH_STUB_DIR = join(GIT, "gh");
  process.env.PATH = `${join(GIT, "bin")}:${process.env.PATH}`;
}
setUpRepos();

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
  ...(GIT_DIRS[id.split(":")[0]] && { foreground_cwd: GIT_DIRS[id.split(":")[0]] }),
  terminal_title_stripped: title,
  ...(agent && { agent: agent.kind, agent_status: agent.status }),
  ...(agent?.tokens && { tokens: agent.tokens }),
  // herdr keeps scrollback for Codex. Claude Code and Pi run fullscreen on the alternate screen, so they have none.
  ...(agent && { scroll: { max_offset_from_bottom: agent.kind === "codex" ? 400 : 0, offset_from_bottom: 0, viewport_rows: 50 } }),
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
  ...processInfo("w2:p3", 4300, "pi"),
  ...processInfo("w2:p4", 4400, "codex"),
  ...processInfo("w5:p9", 4900, "pi"),
};

function processInfo(pane, shell, argv0) {
  const fg = { pid: shell + 1, argv0, argv: [argv0], name: argv0, cwd: `/repos/${pane.split(":")[0]}` };
  const process_info = { pane_id: pane, shell_pid: shell, foreground_process_group_id: shell + 1, foreground_processes: [fg] };
  return { [pane]: { id: "cli:pane:process_info", result: { type: "pane_process_info", process_info } } };
}

// What the memory probe's `ps` prints (test/e2e/ps-stub.sh): pid, parent, RSS in KiB, command.
// It matches PROCESS_INFO; w1:p1 and w3:p5 have no process info, so they show no memory.
const MIB = 1024;
export const PS_OUTPUT = [
  [1, 0, 12, "/sbin/launchd"],
  // stylist (w4:p7): Claude Code with two MCP servers, over the 2 GB mark.
  [4700, 900, 6, "-zsh"],
  [4701, 4700, 1400, "/opt/homebrew/bin/claude"],
  [4702, 4701, 450, "node"],
  [4703, 4701, 350, "node"],
  [4300, 900, 5, "-zsh"],
  [4301, 4300, 260, "pi"],
  [4400, 900, 5, "-zsh"],
  [4401, 4400, 150, "codex"],
  [4402, 4401, 40, "codex"],
  [4900, 900, 5, "-zsh"],
  [4901, 4900, 330, "pi"],
  [900, 1, 80, "herdr"],
]
  .map(([pid, ppid, mb, comm]) => `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(mb * MIB).padStart(8)} ${comm}`)
  .join("\n");

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

// Screens that `--format ansi` reads return instead of the plain screen.
const esc = (params) => `\x1b[${params}m`;
export const WIDE_LINE = `wide:${"=".repeat(400)}:end`;
// A URL whose styles change partway through, and file references among things that only look like them.
export const SCREEN_URL = "https://example.com/token-cache?v=2";
export const SCREEN_PATH = "cache.ts:12";
export const ANSI_SCREENS = {
  // A Codex agent's colored screen, with a window title, cursor moves, a line wider than the sidebar, and links.
  "w2:p4": [
    `\x1b]0;codex\x07\x1b[?25l${esc("1;31")}error:${esc("0")} token cache <stale> & expired\r`,
    `${esc("38;5;208")}orange 256${esc("39")} ${esc("48;2;0;95;135")}truecolor bg${esc("49")} ${esc("7")}inverse${esc("27")}\r`,
    `${esc("32")}${WIDE_LINE}${esc("0")}\r`,
    `${esc("36")}docs: https://example.com/${esc("1")}token-cache${esc("22")}?v=2${esc("39")}. Changed ${SCREEN_PATH}\r`,
    "  at refresh (src/token-cache.ts:42:7) at 12:30, ratio 1:2, v1.2.3:4\r",
    "\x1b[2K$ ",
  ].join("\n"),
};

// Screens that checks write on demand, so the default session stays as it is.
export const RATE_LIMIT_SCREEN = [
  "✻ Refactoring the auth middleware",
  "  ⎿ API Error: 429 Too Many Requests · Retrying in 8 seconds… (attempt 3/10)",
  "✳ Waiting… (2m 10s · esc to interrupt)",
].join("\n");
