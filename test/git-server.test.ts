import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitOutput, GitRepo, GitRequest } from "../probe/git.ts";
import type { PullRequest } from "../shared/git.ts";
import { buildFleet, StatusClock } from "../shared/model.ts";
import { createGitWatcher, DONE_PR_TTL_MS, GIT_INTERVAL_MS, markGit, pickRoot, PR_TTL_MS, workspaceDirs } from "../server/git.ts";
import { snapshotFixture } from "./fixtures.ts";

const pr = (state: PullRequest["state"] = "open"): PullRequest => ({
  number: 7,
  title: "t",
  url: "https://github.com/o/r/pull/7",
  state,
  draft: false,
  checks: { state: "pass", passed: 1, failed: 0, pending: 0 },
});

const repo = (root: string, branch: string, sha: string, found?: PullRequest | null): GitRepo => ({
  root,
  branch,
  head: sha.slice(0, 7),
  dirty: 0,
  key: `${branch}@${sha}`,
  ...(found !== undefined && { pr: found }),
});

/** A watcher on a fake clock whose probe answers with whatever `answer` returns. */
function setup(dirs: Map<string, string[]>) {
  let t = 1_000_000;
  const requests: GitRequest[] = [];
  const logs: string[] = [];
  let changes = 0;
  let answer: (req: GitRequest) => GitOutput | Error = () => ({ roots: {}, repos: [], errors: [] });
  const watcher = createGitWatcher({
    probe: { node: "node" },
    dirs: () => dirs,
    onChange: () => changes++,
    log: (l) => logs.push(l),
    now: () => t,
    run: async (req) => {
      requests.push(req);
      const out = answer(req);
      if (out instanceof Error) throw out;
      return out;
    },
  });
  return {
    watcher,
    requests,
    logs,
    changes: () => changes,
    advance: (ms: number) => (t += ms),
    answer: (fn: typeof answer) => (answer = fn),
  };
}

test("workspaceDirs lists agent panes' directories, preferring the agent process's", () => {
  const snap = snapshotFixture();
  snap.panes[0].cwd = "/r/api";
  snap.panes[0].foreground_cwd = "/r/api/sub";
  snap.panes[1].cwd = "/r/api-shell";
  snap.panes[2].cwd = "/r/api-feature";
  assert.deepEqual(
    [...workspaceDirs(snap)],
    [
      ["w1", ["/r/api/sub"]],
      ["w2", ["/r/api-feature"]],
    ],
  );
  assert.deepEqual([...workspaceDirs(undefined)], []);
});

test("pickRoot takes the repo most directories are in, the first one on a tie", () => {
  const roots = new Map([
    ["/a", "/A"],
    ["/a/x", "/A"],
    ["/b", "/B"],
    ["/c", null],
  ]);
  assert.equal(pickRoot(["/b", "/a", "/a/x", "/c"], roots), "/A");
  assert.equal(pickRoot(["/b", "/a"], roots), "/B");
  assert.equal(pickRoot(["/c", "/unknown"], roots), undefined);
});

test("markGit sets git on the matching workspaces", () => {
  const snap = snapshotFixture();
  const fleet = markGit(buildFleet(snap, new StatusClock().observe(snap.agents, 1000)), new Map([["w2", { root: "/r", branch: "x", dirty: 1 }]]));
  const all = fleet.groups.flatMap((g) => g.workspaces);
  assert.deepEqual(all.find((w) => w.id === "w2")?.git, { root: "/r", branch: "x", dirty: 1 });
  assert.equal(all.find((w) => w.id === "w1")?.git, undefined);
});

test("the watcher attaches each workspace's repo and PR, and reports changes", async () => {
  const s = setup(
    new Map([
      ["w1", ["/r/api", "/r/api/sub", "/r/other"]],
      ["w2", ["/r/api-feature"]],
      ["w3", ["/tmp"]],
    ]),
  );
  s.answer(() => ({
    roots: { "/r/api": "/r/api", "/r/api/sub": "/r/api", "/r/other": "/r/other", "/r/api-feature": "/r/api-feature", "/tmp": null },
    repos: [repo("/r/api", "main", "aaaaaaaa", null), repo("/r/other", "x", "cccccccc", null), repo("/r/api-feature", "feature", "bbbbbbbb", pr())],
    errors: [],
  }));
  await s.watcher.tick();
  assert.deepEqual(s.requests[0], { dirs: ["/r/api", "/r/api/sub", "/r/other", "/r/api-feature", "/tmp"], fresh: {} });
  const ws = s.watcher.workspaces();
  assert.deepEqual(ws.get("w1"), { root: "/r/api", branch: "main", head: "aaaaaaa", dirty: 0 });
  assert.deepEqual(ws.get("w2"), { root: "/r/api-feature", branch: "feature", head: "bbbbbbb", dirty: 0, pr: pr() });
  assert.equal(ws.has("w3"), false);
  assert.equal(s.changes(), 1);
  s.advance(GIT_INTERVAL_MS);
  await s.watcher.tick();
  assert.equal(s.changes(), 1, "an unchanged round reports nothing");
});

test("git runs every interval, and right away for a directory it hasn't read", async () => {
  const dirs = new Map([["w1", ["/r/a"]]]);
  const s = setup(dirs);
  await s.watcher.tick();
  s.advance(GIT_INTERVAL_MS - 1);
  await s.watcher.tick();
  assert.equal(s.requests.length, 1);
  dirs.set("w2", ["/r/b"]);
  await s.watcher.tick();
  assert.equal(s.requests.length, 2);
  s.advance(1);
  await s.watcher.tick();
  assert.equal(s.requests.length, 2, "the interval counts from the last run");
  s.advance(GIT_INTERVAL_MS);
  await s.watcher.tick();
  assert.equal(s.requests.length, 3);
});

test("a PR lookup is cached by branch and HEAD for a minute, and ten for a merged PR", async () => {
  const s = setup(new Map([["w1", ["/r/a"]], ["w2", ["/r/b"]]]));
  let prA: PullRequest | null | undefined = pr();
  let prB: PullRequest | null | undefined = pr("merged");
  let shaA = "aaaaaaaa";
  s.answer((req) => {
    const repos = [repo("/r/a", "feature", shaA), repo("/r/b", "done", "bbbbbbbb")];
    // Like the probe: gh runs only for roots whose fresh key doesn't match.
    for (const r of repos) if (req.fresh?.[r.root] !== r.key) r.pr = r.root === "/r/a" ? prA : prB;
    return { roots: { "/r/a": "/r/a", "/r/b": "/r/b" }, repos, errors: [] };
  });
  await s.watcher.tick();
  assert.deepEqual(s.requests[0].fresh, {});

  s.advance(GIT_INTERVAL_MS);
  await s.watcher.tick();
  assert.deepEqual(s.requests[1].fresh, { "/r/a": "feature@aaaaaaaa", "/r/b": "done@bbbbbbbb" });

  s.advance(PR_TTL_MS - GIT_INTERVAL_MS);
  await s.watcher.tick();
  assert.deepEqual(s.requests[2].fresh, { "/r/b": "done@bbbbbbbb" }, "an open PR is looked up again after a minute");

  // A new HEAD misses the cache, so the probe looks it up again on the next run.
  shaA = "dddddddd";
  prA = { ...pr(), checks: { state: "pending", passed: 0, failed: 0, pending: 1 } };
  s.advance(GIT_INTERVAL_MS);
  await s.watcher.tick();
  assert.deepEqual(s.requests[3].fresh, { "/r/a": "feature@aaaaaaaa", "/r/b": "done@bbbbbbbb" });
  assert.equal(s.watcher.workspaces().get("w1")?.pr?.checks.state, "pending");

  s.advance(DONE_PR_TTL_MS);
  await s.watcher.tick();
  assert.deepEqual(s.requests[4].fresh, {}, "a merged PR is looked up again after ten minutes");
});

test("a skipped lookup keeps the PR for the same branch, and drops it for another", async () => {
  const s = setup(new Map([["w1", ["/r/a"]]]));
  let next = repo("/r/a", "feature", "aaaaaaaa", pr());
  s.answer(() => ({ roots: { "/r/a": "/r/a" }, repos: [next], errors: [] }));
  await s.watcher.tick();
  next = repo("/r/a", "feature", "bbbbbbbb");
  s.advance(GIT_INTERVAL_MS);
  await s.watcher.tick();
  assert.equal(s.watcher.workspaces().get("w1")?.pr?.number, 7);
  next = repo("/r/a", "other", "cccccccc");
  s.advance(GIT_INTERVAL_MS);
  await s.watcher.tick();
  assert.equal(s.watcher.workspaces().get("w1")?.pr, undefined);
});

test("each distinct error is logged once, and a failed run keeps the last results", async () => {
  const s = setup(new Map([["w1", ["/r/a"]]]));
  s.answer(() => ({ roots: { "/r/a": "/r/a" }, repos: [repo("/r/a", "main", "aaaaaaaa", null)], errors: ["gh is not installed or not on PATH"] }));
  await s.watcher.tick();
  s.advance(GIT_INTERVAL_MS);
  await s.watcher.tick();
  s.answer(() => new Error("ssh: connect to host mini: Connection refused"));
  s.advance(GIT_INTERVAL_MS);
  await s.watcher.tick();
  s.advance(GIT_INTERVAL_MS);
  await s.watcher.tick();
  assert.deepEqual(s.logs, ["git probe: gh is not installed or not on PATH", "git probe: ssh: connect to host mini: Connection refused"]);
  assert.equal(s.watcher.workspaces().get("w1")?.branch, "main");
  await s.watcher.tick();
  assert.equal(s.requests.length, 4, "a failing run waits for the interval, not the next tick");
});
