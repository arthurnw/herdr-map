import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceGit } from "../shared/git.ts";
import type { AgentStatus, FleetPane, FleetWorkspace } from "../shared/model.ts";
import {
  agentMatches,
  commandMatches,
  parseMemoryThreshold,
  parseQuery,
  shortcutLabel,
  showsMemory,
  sortAgents,
  toggleMemorySort,
  workspaceItemMatches,
} from "../web/palette.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;

function workspace(label: string): FleetWorkspace {
  return { id: label, label, number: 1, focused: false, linkedWorktree: false, agentCount: 1, tabs: [] };
}

function agent(kind: string, status: AgentStatus, ws: string, extra: { name?: string; summary?: string } = {}) {
  const pane: FleetPane = {
    id: `${ws}:${kind}`,
    rect: { x: 0, y: 0, w: 1, h: 1 },
    title: `${kind} title`,
    focused: false,
    agent: { kind, status, since: 0, sinceApprox: false, ...extra },
  };
  return { pane, workspace: workspace(ws) };
}

const blockedPi = agent("pi", "blocked", "api-auth", { summary: "Pick a deploy target" });
const doneCodex = agent("codex", "done", "api-billing", { name: "cache", summary: "Rewrite the token cache" });
const idleClaude = agent("claude", "idle", "web", { name: "stylist" });
const all = [blockedPi, doneCodex, idleClaude];
const hits = (q: string) => all.flatMap((a) => (agentMatches(a, parseQuery(q)) ? [a.pane.id] : []));

test("parseQuery splits prefixes from free text", () => {
  assert.deepEqual(parseQuery("  S:Blocked a:codex w:api  deploy Target "), {
    filters: { s: ["blocked"], a: ["codex"], w: ["api"] },
    text: ["deploy", "target"],
  });
  assert.deepEqual(parseQuery("s: x:y t:Infra"), { filters: { t: ["infra"] }, text: ["x:y"] });
  assert.deepEqual(parseQuery("PR:Open ci:fail ci:pending dirty:yes"), {
    filters: { pr: ["open"], ci: ["fail", "pending"], dirty: ["yes"] },
    text: [],
  });
  assert.deepEqual(parseQuery("mem:>1G sort:mem"), { filters: { mem: [{ op: ">", bytes: GB }] }, text: [], sort: "mem" });
  // Values still being typed don't filter, and `toString:` isn't a prefix.
  assert.deepEqual(parseQuery("mem:> mem:1x sort: sort:cpu tostring:x"), { filters: {}, text: ["tostring:x"] });
});

test("status, kind, and workspace prefixes narrow agents", () => {
  assert.deepEqual(hits("s:blocked"), [blockedPi.pane.id]);
  assert.deepEqual(hits("s:bl"), [blockedPi.pane.id]);
  assert.deepEqual(hits("a:codex"), [doneCodex.pane.id]);
  assert.deepEqual(hits("w:api"), [blockedPi.pane.id, doneCodex.pane.id]);
});

test("a repeated prefix matches any value, different prefixes all must match", () => {
  assert.deepEqual(hits("s:blocked s:done"), [blockedPi.pane.id, doneCodex.pane.id]);
  assert.deepEqual(hits("s:done a:pi"), []);
});

test("free text matches names, workspaces, and summaries", () => {
  assert.deepEqual(hits("stylist"), [idleClaude.pane.id]);
  assert.deepEqual(hits("billing"), [doneCodex.pane.id]);
  assert.deepEqual(hits("deploy target"), [blockedPi.pane.id]);
  assert.deepEqual(hits("w:api token"), [doneCodex.pane.id]);
  assert.deepEqual(hits(""), all.map((a) => a.pane.id));
});

test("workspaces and commands drop out when a prefix doesn't apply to them", () => {
  const ws = workspace("api-auth");
  assert.ok(workspaceItemMatches(ws, "api", parseQuery("auth")));
  assert.ok(workspaceItemMatches(ws, "api", parseQuery("w:auth")));
  assert.ok(!workspaceItemMatches(ws, "api", parseQuery("s:blocked")));
  assert.ok(commandMatches("Next in Needs you", parseQuery("needs")));
  assert.ok(!commandMatches("Next in Needs you", parseQuery("w:needs")));
});

test("shortcutLabel names keys and modifiers", () => {
  assert.equal(shortcutLabel({ key: "k", meta: true }), "⌘K");
  assert.equal(shortcutLabel({ key: "k", ctrl: true }), "⌃K");
  assert.equal(shortcutLabel({ key: "n" }), "n");
  assert.equal(shortcutLabel({ key: "N" }), "⇧N");
  assert.equal(shortcutLabel({ key: "Enter" }), "↵");
  assert.equal(shortcutLabel({ key: "ArrowLeft" }), "←");
  assert.equal(shortcutLabel({ key: "/" }), "/");
});

test("t: narrows agents and workspaces by tag prefix, and free text matches tags", () => {
  const tags = new Map([["api-auth", ["infra", "urgent"]], ["web", ["design"]]]);
  const tagHits = (q: string) => all.flatMap((a) => (agentMatches(a, parseQuery(q), tags.get(a.workspace.label)) ? [a.pane.id] : []));
  assert.deepEqual(tagHits("t:infra"), [blockedPi.pane.id]);
  assert.deepEqual(tagHits("t:inf"), [blockedPi.pane.id]);
  assert.deepEqual(tagHits("t:urgent t:design"), [blockedPi.pane.id, idleClaude.pane.id]);
  assert.deepEqual(tagHits("t:design s:blocked"), []);
  assert.deepEqual(tagHits("urgent"), [blockedPi.pane.id]);
  assert.deepEqual(tagHits("t:nope"), []);
  const ws = workspace("web");
  assert.ok(workspaceItemMatches(ws, "web", parseQuery("t:des"), ["design"]));
  assert.ok(workspaceItemMatches(ws, "web", parseQuery("design"), ["design"]));
  assert.ok(!workspaceItemMatches(ws, "web", parseQuery("t:des"), []));
  assert.ok(!commandMatches("Next in Needs you", parseQuery("t:needs")));
});

// Workspaces with git state like the e2e fixture's, and an agent in each.
function gitWorkspace(label: string, git?: Partial<WorkspaceGit>, pr?: { state: "open" | "merged" | "closed"; draft?: boolean; checks?: "pass" | "fail" | "pending" | "none" }) {
  const ws = workspace(label);
  if (git || pr)
    ws.git = {
      root: `/repos/${label}`,
      dirty: 0,
      ...git,
      ...(pr && {
        pr: {
          number: 1,
          title: label,
          url: "",
          state: pr.state,
          draft: pr.draft ?? false,
          checks: { state: pr.checks ?? "none", passed: 0, failed: 0, pending: 0 },
        },
      }),
    };
  return ws;
}

const repos = {
  main: gitWorkspace("main", {}),
  open: gitWorkspace("open", { dirty: 3 }, { state: "open", checks: "pass" }),
  draft: gitWorkspace("draft", {}, { state: "open", draft: true, checks: "fail" }),
  pending: gitWorkspace("pending", {}, { state: "open", checks: "pending" }),
  merged: gitWorkspace("merged", {}, { state: "merged", checks: "pass" }),
  closed: gitWorkspace("closed", { dirty: 1 }, { state: "closed", draft: true, checks: "fail" }),
  scratch: gitWorkspace("scratch"),
};
type Repo = keyof typeof repos;
const repoAgents = Object.entries(repos).map(([name, workspace], i) => ({ ...agent("claude", i % 2 ? "idle" : "working", name), workspace }));
const wsHits = (q: string) => Object.entries(repos).flatMap(([name, ws]) => (workspaceItemMatches(ws, name, parseQuery(q)) ? [name] : []));
const repoAgentHits = (q: string) => repoAgents.filter((a) => agentMatches(a, parseQuery(q))).map((a) => a.workspace.label);

test("pr: narrows by the workspace's PR, with drafts apart from open PRs", () => {
  const both = (q: string, expected: Repo[]) => {
    assert.deepEqual(wsHits(q), expected, `workspaces for ${q}`);
    assert.deepEqual(repoAgentHits(q), expected, `agents for ${q}`);
  };
  both("pr:open", ["open", "pending"]);
  both("pr:draft", ["draft"]);
  both("pr:merged", ["merged"]);
  both("pr:closed", ["closed"]);
  both("pr:none", ["main", "scratch"]);
  both("pr:any", ["open", "draft", "pending", "merged", "closed"]);
  both("pr:dr", ["draft"]);
  both("pr:open pr:draft", ["open", "draft", "pending"]);
  both("pr:nope", []);
});

test("ci: narrows by the checks of an open PR", () => {
  assert.deepEqual(wsHits("ci:pass"), ["open"]);
  // A closed PR's checks no longer count, as its badge shows none.
  assert.deepEqual(wsHits("ci:fail"), ["draft"]);
  assert.deepEqual(wsHits("ci:pending"), ["pending"]);
  assert.deepEqual(wsHits("ci:pass ci:fail"), ["open", "draft"]);
  assert.deepEqual(wsHits("ci:none"), ["main", "merged", "closed", "scratch"]);
  assert.deepEqual(repoAgentHits("ci:fail"), ["draft"]);
});

test("dirty: narrows to repos with or without uncommitted changes", () => {
  assert.deepEqual(wsHits("dirty:yes"), ["open", "closed"]);
  assert.deepEqual(wsHits("dirty:no"), ["main", "draft", "pending", "merged"]);
  assert.deepEqual(wsHits("dirty:y"), ["open", "closed"]);
  assert.deepEqual(repoAgentHits("dirty:no"), ["main", "draft", "pending", "merged"]);
  assert.deepEqual(wsHits("dirty:maybe"), []);
});

test("git prefixes combine with each other and with the others", () => {
  assert.deepEqual(wsHits("pr:open dirty:yes"), ["open"]);
  assert.deepEqual(wsHits("pr:any ci:fail dirty:no"), ["draft"]);
  assert.deepEqual(wsHits("pr:open pending"), ["pending"]);
  assert.deepEqual(wsHits("pr:open w:pend"), ["pending"]);
  assert.deepEqual(repoAgentHits("pr:open s:idle"), ["open", "pending"]);
  assert.deepEqual(repoAgentHits("pr:any s:working"), ["draft", "merged"]);
  assert.deepEqual(repoAgentHits("pr:any a:codex"), []);
  assert.ok(!commandMatches("Next in Needs you", parseQuery("pr:open")));
  assert.ok(!commandMatches("Next in Needs you", parseQuery("dirty:yes needs")));
});

test("parseMemoryThreshold reads an operator, a number, and a binary unit", () => {
  assert.deepEqual(parseMemoryThreshold(">1g"), { op: ">", bytes: GB });
  assert.deepEqual(parseMemoryThreshold(">500m"), { op: ">", bytes: 500 * MB });
  assert.deepEqual(parseMemoryThreshold("<256k"), { op: "<", bytes: 256 * 1024 });
  assert.deepEqual(parseMemoryThreshold(">=1.5GB"), { op: ">=", bytes: 1.5 * GB });
  assert.deepEqual(parseMemoryThreshold("<=.5g"), { op: "<=", bytes: 0.5 * GB });
  assert.deepEqual(parseMemoryThreshold("800"), { op: ">=", bytes: 800 * MB });
  assert.deepEqual(parseMemoryThreshold("2mb"), { op: ">=", bytes: 2 * MB });
  for (const bad of ["", ">", "<g", "1x", "1gg", "=1g", "1.g", "-1g", ">>1g"]) assert.equal(parseMemoryThreshold(bad), undefined, bad);
});

function heavy(id: string, mb: number | undefined, status: AgentStatus = "idle", since = 0) {
  const a = agent("claude", status, id);
  a.pane.agent!.since = since;
  if (mb !== undefined) a.pane.agent!.memory = { bytes: mb * MB, processes: 1, top: [] };
  return a;
}
const big = heavy("big", 2200);
const mid = heavy("mid", 700, "blocked");
const small = heavy("small", 195, "done");
const unmeasured = heavy("unmeasured", undefined, "blocked");
const fleet = [small, unmeasured, big, mid];
const ids = (list: { workspace: FleetWorkspace }[]) => list.map((a) => a.workspace.label);
const memHits = (q: string) => ids(fleet.filter((a) => agentMatches(a, parseQuery(q))));

test("mem: keeps agents over or under a threshold, and repeated thresholds all apply", () => {
  assert.deepEqual(memHits("mem:>1g"), ["big"]);
  assert.deepEqual(memHits("mem:>500m"), ["big", "mid"]);
  assert.deepEqual(memHits("mem:<500m"), ["small"]);
  assert.deepEqual(memHits("mem:>=700m"), ["big", "mid"]);
  assert.deepEqual(memHits("mem:>700m"), ["big"]);
  assert.deepEqual(memHits("mem:<=700m"), ["small", "mid"]);
  assert.deepEqual(memHits("mem:>100m mem:<1g"), ["small", "mid"]);
  assert.deepEqual(memHits("mem:>100m s:blocked"), ["mid"]);
  // Unfinished values don't filter yet.
  assert.deepEqual(memHits("mem:>"), ["small", "unmeasured", "big", "mid"]);
  assert.ok(!workspaceItemMatches(workspace("big"), "big", parseQuery("mem:>1g")));
  assert.ok(!commandMatches("Sort agents by memory", parseQuery("mem:>1g")));
});

test("sortAgents orders by status and wait, or by memory with sort:mem", () => {
  const waited = heavy("waited", 100, "blocked", -5);
  assert.deepEqual(ids(sortAgents([...fleet, waited], parseQuery(""))), ["waited", "unmeasured", "mid", "small", "big"]);
  assert.deepEqual(ids(sortAgents([...fleet, waited], parseQuery("sort:mem"))), ["big", "mid", "small", "waited", "unmeasured"]);
  assert.deepEqual(ids(sortAgents(fleet.filter((a) => agentMatches(a, parseQuery("mem:<1g sort:m"))), parseQuery("mem:<1g sort:m"))), ["mid", "small"]);
  assert.deepEqual(ids(fleet), ["small", "unmeasured", "big", "mid"], "sorting copies the list");
});

test("sort:mem and mem: show memory figures, and sort:mem alone filters nothing", () => {
  assert.ok(showsMemory(parseQuery("sort:mem")));
  assert.ok(showsMemory(parseQuery("mem:>1g")));
  assert.ok(!showsMemory(parseQuery("s:blocked mem:")));
  assert.deepEqual(memHits("sort:mem"), ["small", "unmeasured", "big", "mid"]);
  assert.ok(workspaceItemMatches(workspace("web"), "web", parseQuery("sort:mem web")));
  assert.ok(commandMatches("Sort agents by memory", parseQuery("sort:mem memory")));
});

test("toggleMemorySort adds sort:mem or takes it out, dropping the words that found the command", () => {
  assert.equal(toggleMemorySort(""), "sort:mem ");
  assert.equal(toggleMemorySort("sort agents"), "sort:mem ");
  assert.equal(toggleMemorySort("s: sort"), "s: sort:mem ");
  assert.equal(toggleMemorySort("sort:mem by memory"), "");
  assert.equal(toggleMemorySort("w: Sort:Mem memory"), "w:");
});
