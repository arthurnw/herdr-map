import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gitProbe, lookupPr, parseStatus, summarizeChecks, toPullRequest } from "../probe/git.ts";
import { checkText } from "../shared/git.ts";
import { runGitProbe } from "../server/git.ts";

// Commits here must not pick up the user's signing or hooks.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();

const base = realpathSync(mkdtempSync(join(tmpdir(), "herdr-map-git-")));
after(() => rmSync(base, { recursive: true, force: true }));

function repo(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

function commit(dir: string, file: string) {
  writeFileSync(join(dir, file), `${file}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", file);
}

/** A stand-in gh that logs each call's directory and runs `body`. */
function ghStub(name: string, body: string): { path: string; calls: () => string[] } {
  const dir = join(base, `gh-${name}`);
  mkdirSync(dir);
  const path = join(dir, "gh");
  const log = join(dir, "calls.log");
  writeFileSync(path, `#!/bin/sh\nprintf '%s %s\\n' "$PWD" "$*" >>'${log}'\n${body}\n`);
  chmodSync(path, 0o755);
  return { path, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

const prJson = (rollup: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ number: 42, title: "Add retries", url: "https://github.com/o/r/pull/42", state: "OPEN", isDraft: false, reviewDecision: "", statusCheckRollup: rollup, ...extra });
const run = (name: string, status: string, conclusion = "") => ({ __typename: "CheckRun", name, workflowName: "ci", status, conclusion, startedAt: "2026-09-30T10:00:00Z" });

test("parseStatus reads branch, upstream, ahead/behind, and counts entries", () => {
  const out = [
    "# branch.oid 0123456789abcdef",
    "# branch.head feature/x",
    "# branch.upstream origin/feature/x",
    "# branch.ab +2 -5",
    "1 .M N... 100644 100644 100644 a a a.txt",
    "2 R. N... 100644 100644 100644 a a R100 new.txt\told.txt",
    "u UU N... 100644 100644 100644 100644 a a a c.txt",
    "? untracked.txt",
    "",
  ].join("\n");
  assert.deepEqual(parseStatus(out), { oid: "0123456789abcdef", branch: "feature/x", upstream: "origin/feature/x", ahead: 2, behind: 5, dirty: 4 });
  assert.deepEqual(parseStatus("# branch.oid (initial)\n# branch.head (detached)\n"), { dirty: 0 });
});

test("summarizeChecks buckets check runs and commit statuses like gh pr checks", () => {
  assert.deepEqual(summarizeChecks([]), { state: "none", passed: 0, failed: 0, pending: 0 });
  assert.equal(summarizeChecks([run("lint", "COMPLETED", "SUCCESS"), run("docs", "COMPLETED", "SKIPPED"), { __typename: "StatusContext", context: "ci/x", state: "SUCCESS" }]).state, "pass");
  assert.deepEqual(summarizeChecks([run("lint", "COMPLETED", "SUCCESS"), run("test", "IN_PROGRESS"), { __typename: "StatusContext", context: "deploy", state: "PENDING" }]), {
    state: "pending",
    passed: 1,
    failed: 0,
    pending: 2,
  });
  assert.deepEqual(summarizeChecks([run("lint", "COMPLETED", "FAILURE"), run("test", "QUEUED"), { __typename: "StatusContext", context: "ci/x", state: "ERROR" }]), {
    state: "fail",
    passed: 0,
    failed: 2,
    pending: 1,
    failing: ["lint", "ci/x"],
  });
});

test("summarizeChecks counts only the latest run of a re-run check", () => {
  const old = { ...run("test", "COMPLETED", "FAILURE"), startedAt: "2026-09-30T09:00:00Z" };
  assert.equal(summarizeChecks([old, run("test", "COMPLETED", "SUCCESS")]).state, "pass");
  assert.equal(checkText(summarizeChecks([run("a", "COMPLETED", "SUCCESS"), run("b", "COMPLETED", "TIMED_OUT")])), "1 passed, 1 failed (b)");
});

test("toPullRequest maps gh's fields", () => {
  const pr = toPullRequest(JSON.parse(prJson([], { state: "MERGED", isDraft: true, reviewDecision: "APPROVED" })));
  assert.deepEqual(pr, {
    number: 42,
    title: "Add retries",
    url: "https://github.com/o/r/pull/42",
    state: "merged",
    draft: true,
    review: "APPROVED",
    checks: { state: "none", passed: 0, failed: 0, pending: 0 },
  });
});

test("a clean repo on main: branch and HEAD, no changes, and no PR lookup on the default branch", () => {
  const dir = repo("clean");
  const gh = ghStub("clean", "exit 1");
  const out = gitProbe({ dirs: [dir, join(dir, ".")], gh: gh.path });
  assert.equal(out.roots[dir], dir);
  assert.equal(out.repos.length, 1);
  const [r] = out.repos;
  assert.deepEqual({ ...r, head: r.head?.length }, { root: dir, branch: "main", head: 7, dirty: 0, key: `main@${git(dir, "rev-parse", "HEAD")}`, pr: null });
  assert.deepEqual(gh.calls(), []);
  assert.deepEqual(out.errors, []);
});

test("a dirty repo counts changed, staged, and untracked entries, from any directory inside it", () => {
  const dir = repo("dirty");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.txt"), "changed\n");
  writeFileSync(join(dir, "staged.txt"), "s\n");
  git(dir, "add", "staged.txt");
  writeFileSync(join(dir, "sub", "new.txt"), "n\n");
  const out = gitProbe({ dirs: [join(dir, "sub")], gh: "/nonexistent/gh" });
  assert.equal(out.roots[join(dir, "sub")], dir);
  assert.equal(out.repos[0].dirty, 3);
});

test("a detached HEAD gives the short SHA and no branch, and skips gh", () => {
  const dir = repo("detached");
  commit(dir, "b.txt");
  git(dir, "checkout", "-q", "--detach", "HEAD~1");
  const gh = ghStub("detached", "exit 1");
  const [r] = gitProbe({ dirs: [dir], gh: gh.path }).repos;
  assert.equal(r.branch, undefined);
  assert.equal(r.head, git(dir, "rev-parse", "--short=7", "HEAD"));
  assert.equal(r.pr, null);
  assert.deepEqual(gh.calls(), []);
});

test("a branch ahead of its upstream in a local bare remote, with its PR from gh", () => {
  const bare = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", bare);
  const dir = repo("ahead");
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "-u", "origin", "main");
  git(dir, "remote", "set-head", "origin", "main");
  git(dir, "checkout", "-q", "-b", "feature");
  commit(dir, "b.txt");
  git(dir, "push", "-q", "-u", "origin", "feature");
  commit(dir, "c.txt");
  commit(dir, "d.txt");
  const gh = ghStub("ahead", `cat <<'EOF'\n${prJson([run("test", "COMPLETED", "SUCCESS")])}\nEOF`);
  const [r] = gitProbe({ dirs: [dir], gh: gh.path }).repos;
  assert.deepEqual([r.branch, r.upstream, r.ahead, r.behind], ["feature", "origin/feature", 2, 0]);
  assert.equal(r.pr?.number, 42);
  assert.equal(r.pr?.checks.state, "pass");
  assert.deepEqual(gh.calls(), [`${dir} pr view --json number,title,url,state,isDraft,reviewDecision,statusCheckRollup`]);

  // A lookup the server still has for this branch and HEAD is skipped; a new HEAD is looked up.
  const again = gitProbe({ dirs: [dir], gh: gh.path, fresh: { [dir]: r.key } }).repos[0];
  assert.equal(again.pr, undefined);
  assert.equal(gh.calls().length, 1);
  commit(dir, "e.txt");
  const moved = gitProbe({ dirs: [dir], gh: gh.path, fresh: { [dir]: r.key } }).repos[0];
  assert.notEqual(moved.key, r.key);
  assert.equal(moved.pr?.number, 42);
  assert.equal(gh.calls().length, 2);

  // origin/HEAD names the default branch, which isn't looked up.
  git(dir, "checkout", "-q", "main");
  assert.equal(gitProbe({ dirs: [dir], gh: gh.path }).repos[0].pr, null);
  assert.equal(gh.calls().length, 2);
});

test("no gh lookups start once the budget is spent", () => {
  const dir = repo("budget");
  git(dir, "checkout", "-q", "-b", "topic");
  const gh = ghStub("budget", "exit 1");
  assert.equal(gitProbe({ dirs: [dir], gh: gh.path, ghBudgetMs: -1 }).repos[0].pr, undefined);
  assert.deepEqual(gh.calls(), []);
});

test("gh: each check state, no PR, not logged in, and not installed", () => {
  const dir = repo("gh");
  git(dir, "checkout", "-q", "-b", "topic");
  const cases: [string, unknown[], string][] = [
    ["pass", [run("a", "COMPLETED", "SUCCESS")], "pass"],
    ["fail", [run("a", "COMPLETED", "SUCCESS"), run("b", "COMPLETED", "FAILURE")], "fail"],
    ["pending", [run("a", "IN_PROGRESS")], "pending"],
    ["none", [], "none"],
  ];
  for (const [name, rollup, state] of cases) {
    const gh = ghStub(`state-${name}`, `cat <<'EOF'\n${prJson(rollup)}\nEOF`);
    const out = gitProbe({ dirs: [dir], gh: gh.path });
    assert.equal(out.repos[0].pr?.checks.state, state, name);
    assert.deepEqual(out.errors, []);
  }

  const none = ghStub("none", `echo 'no pull requests found for branch "topic"' >&2; exit 1`);
  assert.deepEqual(lookupPr(none.path, dir), { pr: null });
  const out = gitProbe({ dirs: [dir], gh: none.path });
  assert.equal(out.repos[0].pr, null);
  assert.deepEqual(out.errors, []);

  const noRemote = ghStub("no-remote", `echo 'none of the git remotes configured for this repository point to a known GitHub host.' >&2; exit 1`);
  assert.deepEqual(lookupPr(noRemote.path, dir), { pr: null });

  const loggedOut = ghStub("logged-out", `echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4`);
  assert.deepEqual(lookupPr(loggedOut.path, dir), { pr: null, error: "gh pr view: To get started with GitHub CLI, please run:  gh auth login" });

  const missing = gitProbe({ dirs: [dir], gh: "/nonexistent/gh" });
  assert.equal(missing.repos[0].pr, null);
  assert.deepEqual(missing.errors, ["/nonexistent/gh is not installed or not on PATH"]);
});

test("directories outside a repo, or gone, have no root and no error", () => {
  const plain = join(base, "plain");
  mkdirSync(plain);
  const out = gitProbe({ dirs: [plain, join(base, "gone")] });
  assert.deepEqual(out, { roots: { [plain]: null, [join(base, "gone")]: null }, repos: [], errors: [] });
});

test("the git probe runs as a script in a child Node", async () => {
  const dir = repo("script");
  writeFileSync(join(dir, "x.txt"), "x\n");
  const out = await runGitProbe({ node: process.execPath }, { dirs: [dir], gh: "/nonexistent/gh" });
  assert.equal(out.roots[dir], dir);
  assert.deepEqual([out.repos[0].branch, out.repos[0].dirty, out.repos[0].pr], ["main", 1, null]);
});
