import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStatus, FleetPane, FleetWorkspace } from "../shared/model.ts";
import { agentMatches, commandMatches, parseQuery, shortcutLabel, workspaceItemMatches } from "../web/palette.ts";

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
const hits = (q: string) => all.filter((a) => agentMatches(a, parseQuery(q))).map((a) => a.pane.id);

test("parseQuery splits prefixes from free text", () => {
  assert.deepEqual(parseQuery("  S:Blocked a:codex w:api  deploy Target "), {
    statuses: ["blocked"],
    kinds: ["codex"],
    workspaces: ["api"],
    tags: [],
    text: ["deploy", "target"],
  });
  assert.deepEqual(parseQuery("s: x:y t:Infra"), { statuses: [], kinds: [], workspaces: [], tags: ["infra"], text: ["x:y"] });
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
  const tags: Record<string, string[]> = { "api-auth": ["infra", "urgent"], web: ["design"] };
  const tagHits = (q: string) =>
    all.filter((a) => agentMatches(a, parseQuery(q), tags[a.workspace.label])).map((a) => a.pane.id);
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
