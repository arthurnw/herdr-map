import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { failure, hunkProbe, indexPath, parseIndex, toNote, toNotes, type HunkOutput } from "../probe/hunk.ts";
import { hunkCounts, noteLocation, REPLY_AUTHOR, threadNotes, unreadNotes, type HunkNote, type HunkReview } from "../shared/hunk.ts";
import { buildFleet, fleetPanes, StatusClock, type Snapshot } from "../shared/model.ts";
import type { Context } from "../server/context.ts";
import {
  assertReply,
  createHunkWatcher,
  fleetReviews,
  HUNK_MISSING_MS,
  markHunk,
  matchReviews,
  navigateArgs,
  replyArgs,
  runHunkProbe,
} from "../server/hunk.ts";
import { createRouter } from "../server/router.ts";
import { hunkRoutes } from "../server/routes/hunk.ts";
import { snapshotFixture } from "./fixtures.ts";
import { COMMENTS, INDEX, REPO, SESSION, sessionList } from "./hunk-fixtures.ts";

const [USER_OLD, AGENT_REPLY, AGENT_NOTE, USER_SENT] = COMMENTS.comments.map((c) => c.noteId);

const dir = mkdtempSync(join(tmpdir(), "herdr-map-hunk-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A fake hunk that prints `list` for `session list` and COMMENTS for `session comment list`, and logs its arguments. */
function fakeHunk(name: string, list: unknown, status = 0): string {
  const bin = join(dir, name);
  writeFileSync(join(dir, `${name}.list.json`), JSON.stringify(list));
  writeFileSync(join(dir, `${name}.comments.json`), JSON.stringify(COMMENTS));
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >>"${join(dir, `${name}.log`)}"`,
      `if [ ${status} -ne 0 ]; then echo 'hunk: daemon unreachable' >&2; exit ${status}; fi`,
      `case "$1 $2" in`,
      `  "session list") cat "${join(dir, `${name}.list.json`)}" ;;`,
      `  "session comment") cat "${join(dir, `${name}.comments.json`)}" ;;`,
      "  *) exit 2 ;;",
      "esac",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

const indexFile = join(dir, "review-index.json");
writeFileSync(indexFile, JSON.stringify(INDEX));
process.env.HERDR_MAP_HUNK_INDEX = indexFile;

test("a note keeps its line and side, splits its summary from the rest, and knows whether it was sent", () => {
  const sent = new Set([USER_SENT]);
  const [userOld, reply, agent, userSent] = COMMENTS.comments.map((c) => toNote(c, sent)!);
  assert.deepEqual(userOld, {
    id: USER_OLD,
    source: "user",
    author: "user",
    file: "greet.ts",
    side: "old",
    line: 2,
    summary: "Keep the exclamation mark out of the greeting",
    createdAt: Date.parse("2026-09-30T22:58:07.334Z"),
  });
  assert.equal(reply.parent, USER_OLD);
  assert.equal(reply.source, "agent");
  assert.equal(agent.summary, "Added mul; should div guard against zero?");
  assert.equal(agent.detail, "A rationale follows the summary after a blank line.");
  assert.equal(agent.side, "new");
  assert.equal(userSent.sent, true);
  assert.equal(agent.sent, undefined, "only your comments are sent");
  assert.equal(noteLocation(userOld), "greet.ts:2 (old)");
  assert.equal(noteLocation(agent), "math.ts:3");
});

test("notes without an ID, file, or body are dropped", () => {
  assert.deepEqual(toNotes([{ noteId: "x", filePath: "a" }, { filePath: "a", body: "b" }, null, "note"], new Set()), []);
  assert.deepEqual(toNotes(undefined, new Set()), []);
});

test("the plugin index is read by worktree, and a broken file has no entries", () => {
  const index = parseIndex(JSON.stringify({ ...INDEX, "/work/slash/": { worktree: "/work/slash/", sent: "not a list" }, bad: 3 }));
  assert.deepEqual(index.get(REPO)?.entry, { worktree: REPO, agentPane: "w1:p1", agentName: "pi", pane: "w1:p2" });
  assert.deepEqual([...index.get(REPO)!.sent], [USER_SENT]);
  assert.equal(index.get("/work/slash")?.sent.size, 0);
  assert.equal(parseIndex("{nope").size, 0);
  assert.equal(parseIndex("[]").size, 0);
});

test("the index lives in herdr's plugin state directory unless overridden", () => {
  assert.equal(indexPath({ HOME: "/h", XDG_STATE_HOME: "/state" }), "/state/herdr/plugins/jhochenbaum.hunkdiff/review-index.json");
  assert.equal(indexPath({ HERDR_MAP_HUNK_INDEX: "/x.json" }), "/x.json");
});

test("the probe lists sessions with their notes, marks sent comments, and returns only matching index entries", () => {
  const hunk = fakeHunk("hunk-ok", sessionList());
  const out = hunkProbe({ hunk });
  assert.deepEqual(out.errors, []);
  assert.equal(out.sessions.length, 1);
  const s = out.sessions[0];
  assert.equal(s.id, SESSION);
  assert.equal(s.repo, REPO);
  assert.equal(s.title, "sandbox working tree");
  assert.equal(s.notes.length, 4);
  assert.deepEqual(s.notes.filter((n) => n.sent).map((n) => n.id), [USER_SENT]);
  assert.deepEqual(out.index, [{ worktree: REPO, agentPane: "w1:p1", agentName: "pi", pane: "w1:p2" }]);
});

test("a session without notes in its snapshot is asked for them", async () => {
  const hunk = fakeHunk("hunk-no-notes", sessionList(null));
  // Through the bundled script, as the server runs it.
  const out = await runHunkProbe({ node: process.execPath }, { hunk });
  assert.equal(out.sessions[0].notes.length, 4);
  const { readFileSync } = await import("node:fs");
  const calls = readFileSync(join(dir, "hunk-no-notes.log"), "utf8").trim().split("\n");
  assert.deepEqual(calls, ["session list --json", `session comment list ${SESSION} --type all --json`]);
});

test("a missing hunk says so, and a failing one reports its error", () => {
  assert.deepEqual(hunkProbe({ hunk: join(dir, "no-such-hunk") }), { missing: true, sessions: [], index: [], errors: [] });
  const out = hunkProbe({ hunk: fakeHunk("hunk-fail", {}, 1) });
  assert.deepEqual(out.errors, ["hunk session list: hunk: daemon unreachable"]);
});

function snap(): Snapshot {
  const s = snapshotFixture();
  for (const p of s.panes) p.cwd = p.workspace_id === "w1" ? `${REPO}/src` : "/elsewhere";
  return s;
}

const output = (over: Partial<HunkOutput> = {}): HunkOutput => ({
  sessions: [{ id: SESSION, repo: REPO, title: "t", notes: toNotes(COMMENTS.comments, new Set([USER_SENT])) }],
  index: [{ worktree: REPO, agentPane: "w1:p1", pane: "w1:p2" }],
  errors: [],
  ...over,
});

test("a review goes to the workspace with its hunk pane, owned by the agent the plugin recorded", () => {
  const s = snap();
  s.panes.find((p) => p.pane_id === "w1:p2")!.cwd = "/elsewhere";
  const byWs = matchReviews(s, output());
  assert.deepEqual([...byWs.keys()], ["w1"]);
  const [r] = byWs.get("w1")!;
  assert.equal(r.pane, "w1:p2");
  assert.equal(r.agent, "w1:p1");
});

test("without the plugin's record, a review matches by checkout path, then by pane directories", () => {
  const s = snap();
  const bare = output({ index: [] });
  assert.equal(matchReviews(s, bare).get("w1")?.[0].agent, "w1:p1", "the only agent in the repo owns it");
  s.workspaces.find((w) => w.workspace_id === "w2")!.worktree!.checkout_path = REPO;
  assert.deepEqual([...matchReviews(s, bare).keys()], ["w2"], "a checkout path beats pane directories");
  assert.equal(matchReviews(s, bare).get("w2")?.[0].agent, undefined, "w2's agent isn't in the repo");
});

test("a pane counts for the innermost repo, so a nested worktree's review isn't matched to its parent", () => {
  const s = snap();
  const nested = `${REPO}/.worktrees/feature`;
  s.panes.find((p) => p.pane_id === "w2:p1")!.cwd = nested;
  const out = output({ index: [], sessions: [...output().sessions, { id: "nested-1", repo: nested, notes: [] }] });
  const byWs = matchReviews(s, out);
  assert.deepEqual(byWs.get("w2")?.map((r) => r.session), ["nested-1"]);
  assert.deepEqual(byWs.get("w1")?.map((r) => r.session), [SESSION]);
});

test("closed panes in the plugin's record are ignored", () => {
  const byWs = matchReviews(snap(), output({ index: [{ worktree: REPO, agentPane: "w7:p1", pane: "w7:p2" }] }));
  const [r] = byWs.get("w1")!;
  assert.equal(r.pane, undefined);
  assert.equal(r.agent, "w1:p1", "falls back to the only agent in the repo");
});

test("counts: unsent comments from you, and notes from agents but not your replies from herdr-map", () => {
  const notes = toNotes(COMMENTS.comments, new Set([USER_SENT]));
  const mine: HunkNote = { id: "mcp:mine", parent: USER_OLD, source: "agent", author: REPLY_AUTHOR, file: "greet.ts", side: "old", line: 2, summary: "ok" };
  const reviews: HunkReview[] = [{ session: SESSION, repo: REPO, notes: [...notes, mine] }];
  assert.deepEqual(hunkCounts(reviews), { unsent: 1, notes: 2 });
  assert.deepEqual(unreadNotes(reviews, new Set([AGENT_NOTE])).map((n) => n.id), [AGENT_REPLY]);
  const fleet = markHunk(buildFleet(snap(), new StatusClock().observe([], 0)), matchReviews(snap(), output()));
  const lead = fleetPanes(fleet).find((p) => p.id === "w1:p1")!;
  assert.deepEqual(lead.agent?.hunk, { unsent: 1, notes: 2 });
  assert.equal(fleetPanes(fleet).find((p) => p.id === "w2:p1")!.agent?.hunk, undefined);
  assert.equal(fleetReviews(fleet).length, 1);
});

test("threads read by file and line, with replies under the note they answer", () => {
  const order = threadNotes(toNotes(COMMENTS.comments, new Set())).map(({ note, depth }) => `${depth}:${note.id}`);
  assert.deepEqual(order, [`0:${USER_OLD}`, `1:${AGENT_REPLY}`, `0:${USER_SENT}`, `0:${AGENT_NOTE}`]);
});

test("navigating uses the comment ID for agent notes and the file and line for yours", () => {
  const [userOld, , agent] = toNotes(COMMENTS.comments, new Set());
  assert.deepEqual(navigateArgs(SESSION, agent), ["session", "navigate", SESSION, `--comment=${AGENT_NOTE}`, "--json"]);
  assert.deepEqual(navigateArgs(SESSION, userOld), ["session", "navigate", SESSION, "--file=greet.ts", "--old-line=2", "--json"]);
  assert.throws(() => navigateArgs("../x", agent), /session/);
});

test("a reply is one argument per value, trimmed, and refused when empty, too long, or with control characters", () => {
  assert.deepEqual(replyArgs(SESSION, USER_OLD, "  -dash first \n second line ", REPLY_AUTHOR), [
    "session",
    "comment",
    "add",
    SESSION,
    `--reply-to=${USER_OLD}`,
    "--summary=-dash first \n second line",
    "--author=herdr-map",
    "--json",
  ]);
  for (const bad of ["", "   ", "x".repeat(2001), "bell\u0007", 42, undefined]) assert.throws(() => assertReply(bad));
  assert.throws(() => replyArgs(SESSION, "user:1 --rm", "ok", REPLY_AUTHOR), /note id/);
});

test("the watcher logs each distinct error once, reports changes, and backs off while hunk is missing", async () => {
  const logs: string[] = [];
  let changes = 0;
  let answer: () => HunkOutput | Error = () => output();
  const watcher = createHunkWatcher({
    probe: { node: "node", hunk: "/bin/hunk" },
    onChange: () => changes++,
    log: (l) => logs.push(l),
    run: async (req) => {
      assert.deepEqual(req, { hunk: "/bin/hunk" });
      const a = answer();
      if (a instanceof Error) throw a;
      return a;
    },
  });
  await watcher.refresh();
  assert.equal(changes, 1);
  assert.equal(watcher.output()?.sessions.length, 1);
  await watcher.refresh();
  assert.equal(changes, 1, "the same output is no change");
  answer = () => new Error("ssh: connect failed");
  await watcher.refresh();
  await watcher.refresh();
  assert.deepEqual(logs, ["hunk probe: ssh: connect failed"]);
  assert.equal(watcher.output()?.sessions.length, 1, "a failed run keeps the last output");
  answer = () => ({ missing: true, sessions: [], index: [], errors: [] });
  await watcher.refresh();
  await watcher.refresh();
  assert.equal(watcher.output(), undefined);
  assert.equal(changes, 2);
  assert.equal(logs.length, 2);
  assert.match(logs[1], /not installed/);
  assert.ok(HUNK_MISSING_MS > 60_000);
});

// Routes

async function serve(t: TestContext, runnerOut: (tool: string, args: string[]) => string = () => "{}") {
  const s = snap();
  const fleet = markHunk(buildFleet(s, new StatusClock().observe([], 0)), matchReviews(s, output()));
  const calls: string[] = [];
  let refreshed = 0;
  const seen: string[] = [];
  const poller = {
    state: () => ({ fleet }),
    poll: async () => {},
    markSeen: (p: string) => seen.push(p),
    refreshHunk: async () => {
      refreshed++;
    },
  };
  const ctx = { herdr: { bin: "herdr" }, hunk: "hunk", poller } as unknown as Context;
  const routes = hunkRoutes(ctx, async (tool, args) => {
    calls.push([tool, ...args].join(" "));
    return runnerOut(tool, args);
  });
  const server = createServer(createRouter(routes, (_req, res) => res.end()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { call, calls, seen, refreshed: () => refreshed };
}

test("GET /api/hunk says whether the plugin is installed and enabled", async (t) => {
  const on = await serve(t, () => JSON.stringify({ result: { plugins: [{ plugin_id: "jhochenbaum.hunkdiff", enabled: true }] } }));
  assert.deepEqual((await on.call("GET", "/api/hunk")).body, { available: true });
  assert.deepEqual(on.calls, ["herdr plugin list --json --plugin jhochenbaum.hunkdiff"]);
  const off = await serve(t, () => JSON.stringify({ result: { plugins: [{ plugin_id: "jhochenbaum.hunkdiff", enabled: false }] } }));
  assert.deepEqual((await off.call("GET", "/api/hunk")).body, { available: false });
});

test("navigating to a note moves hunk there, then focuses its pane", async (t) => {
  const { call, calls } = await serve(t);
  assert.equal((await call("POST", "/api/hunk/navigate", { session: SESSION, note: AGENT_NOTE })).status, 200);
  assert.equal((await call("POST", "/api/hunk/navigate", { session: SESSION, note: USER_OLD })).status, 200);
  assert.deepEqual(calls, [
    `hunk session navigate ${SESSION} --comment=${AGENT_NOTE} --json`,
    "herdr plugin pane focus w1:p2",
    `hunk session navigate ${SESSION} --file=greet.ts --old-line=2 --json`,
    "herdr plugin pane focus w1:p2",
  ]);
});

test("a reply is added as a threaded comment and the sessions are read again", async (t) => {
  const { call, calls, refreshed } = await serve(t, () => JSON.stringify({ result: { commentId: "mcp:new" } }));
  const res = await call("POST", "/api/hunk/reply", { session: SESSION, note: USER_OLD, text: " Sounds good " });
  assert.deepEqual(res, { status: 200, body: { ok: true, id: "mcp:new" } });
  assert.deepEqual(calls, [`hunk session comment add ${SESSION} --reply-to=${USER_OLD} --summary=Sounds good --author=herdr-map --json`]);
  assert.equal(refreshed(), 1);
});

test("plugin actions run from the agent's pane, and comment steps then focus the review", async (t) => {
  const { call, calls, seen } = await serve(t);
  assert.equal((await call("POST", "/api/hunk/action", { pane: "w1:p1", action: "send-review" })).status, 200);
  assert.equal((await call("POST", "/api/hunk/action", { pane: "w1:p1", action: "next-comment" })).status, 200);
  assert.deepEqual(calls, [
    "herdr agent focus w1:p1",
    "herdr plugin action invoke send-review --plugin jhochenbaum.hunkdiff",
    "herdr agent focus w1:p1",
    "herdr plugin action invoke next-comment --plugin jhochenbaum.hunkdiff",
    "herdr plugin pane focus w1:p2",
  ]);
  assert.deepEqual(seen, ["w1:p1", "w1:p1"]);
});

test("requests naming anything the probe didn't report are refused before any command runs", async (t) => {
  const { call, calls } = await serve(t);
  const bad: [string, object][] = [
    ["/api/hunk/navigate", { session: "not-live", note: AGENT_NOTE }],
    ["/api/hunk/navigate", { session: "a;b", note: AGENT_NOTE }],
    ["/api/hunk/navigate", { session: SESSION, note: "mcp:gone" }],
    ["/api/hunk/navigate", { session: SESSION, note: ["x"] }],
    ["/api/hunk/reply", { session: SESSION, note: USER_OLD, text: "" }],
    ["/api/hunk/reply", { session: SESSION, note: USER_OLD, text: "x".repeat(2001) }],
    ["/api/hunk/reply", { session: SESSION, note: USER_OLD, text: "a\u0000b" }],
    ["/api/hunk/reply", { session: SESSION, note: "mcp:gone", text: "hi" }],
    ["/api/hunk/action", { pane: "w1:p1", action: "close-review" }],
    ["/api/hunk/action", { pane: "w1:p2", action: "send-review" }],
    ["/api/hunk/action", { pane: "w1:p1; rm", action: "review" }],
    ["/api/hunk/action", { action: "review" }],
  ];
  for (const [path, body] of bad) {
    const res = await call("POST", path, body);
    assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}: ${JSON.stringify(res.body)}`);
  }
  assert.deepEqual(calls, []);
});

test("a failed hunk call reports the error hunk printed as JSON", () => {
  const out = JSON.stringify({ error: { message: "The session daemon is an older Hunk build.", recommendedAction: "restart-daemon" } });
  assert.equal(failure({ ok: false, out, err: "" }), "The session daemon is an older Hunk build. Run `hunk daemon restart`.");
  assert.equal(failure({ ok: false, out: JSON.stringify({ error: { message: "No session." } }), err: "" }), "No session.");
  assert.equal(failure({ ok: false, out: "", err: "boom\nmore" }), "boom");
  assert.equal(failure({ ok: false, out: "", err: "" }), "failed");
});
