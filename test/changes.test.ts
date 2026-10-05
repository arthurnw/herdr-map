import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { changesDiff, changesSummary, parseNameStatusZ, parseNumstatZ, parseStatusZ, truncateDiff, type ChangesRequest } from "../probe/changes.ts";
import { assertChangePath, createChangesCache, readChanges, readDiff } from "../server/changes.ts";
import { markGit } from "../server/git.ts";
import { changesRoutes } from "../server/routes/changes.ts";
import { parseDiff, type ChangedFile, type ChangesSummary } from "../shared/changes.ts";
import { buildFleet, StatusClock } from "../shared/model.ts";
import { snapshotFixture } from "./fixtures.ts";
import { routeContext, serveRoutes } from "./http.ts";

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

const base = realpathSync(mkdtempSync(join(tmpdir(), "herdr-map-changes-")));
after(() => rmSync(base, { recursive: true, force: true }));

const lines = (n: number, tag = "line") => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}\n`).join("");
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 4]);

function write(dir: string, file: string, content: string | Buffer) {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), content);
}

function commitAll(dir: string, message: string) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

/**
 * main has a.txt, old.txt, gone.txt, and logo.png. The working tree changes a.txt, stages a new
 * file and a rename, deletes gone.txt, changes the binary, and adds untracked files.
 */
function workRepo(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  write(dir, "a.txt", lines(5));
  write(dir, "old.txt", lines(20, "keep"));
  write(dir, "gone.txt", "bye\n");
  write(dir, "logo.png", BINARY);
  commitAll(dir, "first");
  write(dir, "a.txt", lines(5).replace("line 3\n", "line three\n") + "line 6\n");
  write(dir, "staged.ts", "export const x = 1;\n");
  git(dir, "add", "staged.ts");
  git(dir, "mv", "old.txt", "new.txt");
  rmSync(join(dir, "gone.txt"));
  write(dir, "logo.png", Buffer.concat([BINARY, BINARY]));
  write(dir, "notes.md", "one\ntwo\nthree");
  write(dir, "docs/guide.md", "guide\n");
  write(dir, "blob.bin", BINARY);
  return dir;
}

const byPath = (s: ChangesSummary | undefined) => new Map((s?.files ?? []).map((f) => [f.path, f]));
const summary = (req: ChangesRequest): ChangesSummary => {
  const out = changesSummary(req);
  assert.equal(out.error, undefined);
  return out.summary!;
};

test("parseNumstatZ reads counts, binary files, renames, and paths with tabs and spaces", () => {
  const out = ["3\t1\ta.txt", "-\t-\tlogo.png", "0\t0\t", "old name.txt", "new\tname.txt", "2\t0\tdir/b c.ts", ""].join("\0");
  assert.deepEqual(parseNumstatZ(out), [
    { path: "a.txt", adds: 3, dels: 1 },
    { path: "logo.png" },
    { path: "new\tname.txt", from: "old name.txt", adds: 0, dels: 0 },
    { path: "dir/b c.ts", adds: 2, dels: 0 },
  ]);
  assert.deepEqual(parseNumstatZ(""), []);
});

test("parseNameStatusZ maps git's letters and reads both paths of a rename", () => {
  const out = ["M", "a.txt", "R087", "old.txt", "new.txt", "D", "gone.txt", "A", "x.ts", "T", "link", "C100", "src.ts", "copy.ts", ""].join("\0");
  assert.deepEqual(parseNameStatusZ(out), [
    { status: "M", path: "a.txt" },
    { status: "R", path: "new.txt", from: "old.txt" },
    { status: "D", path: "gone.txt" },
    { status: "A", path: "x.ts" },
    { status: "M", path: "link" },
    { status: "A", path: "copy.ts" },
  ]);
});

test("parseStatusZ reads the branch header and untracked paths, skipping a rename's original path", () => {
  const out = [
    "# branch.oid 0123456789abcdef",
    "# branch.head feature/x",
    "# branch.upstream origin/feature/x",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 aaa bbb a b.txt",
    "2 R. N... 100644 100644 100644 aaa aaa R100 new name.txt",
    "old name.txt",
    "? notes with space.md",
    "! ignored.log",
    "",
  ].join("\0");
  assert.deepEqual(parseStatusZ(out), {
    oid: "0123456789abcdef",
    branch: "feature/x",
    upstream: "origin/feature/x",
    ahead: 2,
    behind: 1,
    dirty: 3,
    untracked: ["notes with space.md"],
  });
});

test("the uncommitted scope lists staged, unstaged, renamed, deleted, binary, and untracked files against HEAD", () => {
  const root = workRepo("uncommitted");
  const s = summary({ root, scope: "uncommitted" });
  assert.equal(s.branch, "main");
  assert.equal(s.head?.length, 7);
  assert.equal(s.base, undefined, "the uncommitted scope has no base branch");
  assert.deepEqual(
    s.files.map((f) => f.path),
    ["a.txt", "blob.bin", "docs/guide.md", "gone.txt", "logo.png", "new.txt", "notes.md", "staged.ts"],
    "sorted by path, with untracked files in nested directories listed one by one",
  );
  const files = byPath(s);
  assert.deepEqual(files.get("a.txt"), { status: "M", path: "a.txt", adds: 2, dels: 1 });
  assert.deepEqual(files.get("new.txt"), { status: "R", path: "new.txt", from: "old.txt", adds: 0, dels: 0 });
  assert.deepEqual(files.get("gone.txt"), { status: "D", path: "gone.txt", adds: 0, dels: 1 });
  assert.deepEqual(files.get("staged.ts"), { status: "A", path: "staged.ts", adds: 1, dels: 0 });
  assert.deepEqual(files.get("logo.png"), { status: "M", path: "logo.png", binary: true });
  assert.deepEqual(files.get("notes.md"), { path: "notes.md", status: "?", adds: 3, dels: 0 }, "a last line without a newline counts");
  assert.deepEqual(files.get("blob.bin"), { path: "blob.bin", status: "?", binary: true });
  assert.equal(s.adds, 2 + 1 + 3 + 1);
  assert.equal(s.dels, 1 + 1);
});

test("diffs: a modified file has numbered hunks, untracked and deleted files diff against nothing, binaries say so", () => {
  const root = workRepo("diffs");
  const req = { root, scope: "uncommitted" as const };
  const files = byPath(summary(req));
  const diff = (path: string) => changesDiff({ ...req, file: files.get(path)! });

  const a = diff("a.txt");
  assert.equal(a.truncated, undefined);
  const rows = parseDiff(a.text);
  assert.equal(rows[0].kind, "hunk");
  assert.deepEqual(rows.find((r) => r.kind === "del"), { kind: "del", text: "line 3", old: 3 });
  assert.deepEqual(rows.find((r) => r.kind === "add"), { kind: "add", text: "line three", new: 3 });
  assert.deepEqual(rows.at(-1), { kind: "add", text: "line 6", new: 6 });

  const notes = parseDiff(diff("notes.md").text);
  assert.deepEqual(
    notes.map((r) => r.kind),
    ["hunk", "add", "add", "add", "note"],
    "an untracked file is all additions, and a missing final newline is noted",
  );
  assert.deepEqual(parseDiff(diff("gone.txt").text).slice(1), [{ kind: "del", text: "bye", old: 1 }]);
  assert.deepEqual(diff("logo.png"), { path: "logo.png", binary: true, text: "" });
  assert.deepEqual(diff("blob.bin"), { path: "blob.bin", binary: true, text: "" });
  const renamed = diff("new.txt");
  assert.ok(renamed.text.includes("rename from old.txt") && !renamed.text.includes("@@"), "a pure rename has no hunks");
});

test("a large diff is cut at the line and byte limits and says it was truncated", () => {
  const root = join(base, "large");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  write(root, "big.txt", lines(3000));
  commitAll(root, "first");
  write(root, "big.txt", lines(3000, "changed"));
  const req = { root, scope: "uncommitted" as const };
  const file = byPath(summary(req)).get("big.txt")!;
  assert.deepEqual([file.adds, file.dels], [3000, 3000]);
  const d = changesDiff({ ...req, file });
  assert.equal(d.truncated, true);
  assert.equal(d.text.split("\n").length - 1, 2000, "2,000 lines by default");
  const small = changesDiff({ ...req, file, maxLines: 10_000, maxBytes: 1000 });
  assert.equal(small.truncated, true);
  assert.ok(Buffer.byteLength(small.text) <= 1000 && small.text.endsWith("\n"), "cut at a whole line within the byte limit");
});

test("truncateDiff keeps whole lines and reports whether anything was cut", () => {
  assert.deepEqual(truncateDiff("a\nb\nc\n", 2), { text: "a\nb\n", truncated: true });
  assert.deepEqual(truncateDiff("a\nb\nc\n", 3), { text: "a\nb\nc\n", truncated: false });
  assert.deepEqual(truncateDiff("aa\nbb\n", 10, 4), { text: "aa\n", truncated: true });
  assert.deepEqual(truncateDiff("no newline", 1), { text: "no newline", truncated: false });
});

test("parseDiff numbers both sides, mutes hunk headers, and skips file headers", () => {
  const text = [
    "diff --git a/x b/x",
    "index 1..2 100644",
    "--- a/x",
    "+++ b/x",
    "@@ -10,3 +10,3 @@ function f() {",
    " keep",
    "-old",
    "+new",
    " ",
    "@@ -40 +40,2 @@",
    " last",
    "+added",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  assert.deepEqual(parseDiff(text), [
    { kind: "hunk", text: "@@ -10,3 +10,3 @@ function f() {" },
    { kind: "ctx", text: "keep", old: 10, new: 10 },
    { kind: "del", text: "old", old: 11 },
    { kind: "add", text: "new", new: 11 },
    { kind: "ctx", text: "", old: 12, new: 12 },
    { kind: "hunk", text: "@@ -40 +40,2 @@" },
    { kind: "ctx", text: "last", old: 40, new: 40 },
    { kind: "add", text: "added", new: 41 },
    { kind: "note", text: "No newline at end of file" },
  ]);
});

/** A bare origin whose main moved on after `feature` branched, with commits and a change on feature. */
function branchRepo(name: string, setHead: boolean) {
  const origin = join(base, `${name}.git`);
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  const dir = join(base, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", origin);
  write(dir, "README.md", "readme\n");
  commitAll(dir, "first");
  git(dir, "push", "-q", "-u", "origin", "main");
  if (setHead) git(dir, "remote", "set-head", "origin", "main");
  git(dir, "checkout", "-q", "-b", "feature");
  write(dir, "feature.ts", "one\ntwo\n");
  commitAll(dir, "feature");
  write(dir, "more.ts", "more\n");
  commitAll(dir, "more");
  git(dir, "checkout", "-q", "main");
  write(dir, "main-only.ts", "main moved on\n");
  commitAll(dir, "main moves");
  git(dir, "push", "-q", "origin", "main");
  git(dir, "checkout", "-q", "feature");
  write(dir, "feature.ts", "one\ntwo\nthree\n");
  return dir;
}

test("the branch scope compares the working tree with the merge-base of the default branch", () => {
  const root = branchRepo("branch", true);
  const s = summary({ root, scope: "branch" });
  assert.equal(s.base, "origin/main");
  assert.equal(s.commits, 2);
  assert.equal(s.branch, "feature");
  assert.deepEqual(
    s.files.map((f) => [f.path, f.status, f.adds, f.dels]),
    [
      ["feature.ts", "A", 3, 0],
      ["more.ts", "A", 1, 0],
    ],
    "commits on the branch plus the uncommitted line, and nothing from main after the branch point",
  );
  const d = changesDiff({ root, scope: "branch", file: s.files[0] });
  assert.deepEqual(
    parseDiff(d.text).filter((r) => r.kind === "add").map((r) => r.text),
    ["one", "two", "three"],
  );
  const u = summary({ root, scope: "uncommitted" });
  assert.deepEqual(u.files.map((f) => [f.path, f.adds]), [["feature.ts", 1]]);
});

test("without origin/HEAD the branch scope falls back to origin/main, then to a local main", () => {
  const root = branchRepo("fallback", false);
  assert.equal(summary({ root, scope: "branch" }).base, "origin/main");
  const local = join(base, "local-only");
  mkdirSync(local);
  git(local, "init", "-q", "-b", "main");
  write(local, "a.txt", "a\n");
  commitAll(local, "first");
  git(local, "checkout", "-q", "-b", "topic");
  write(local, "b.txt", "b\n");
  commitAll(local, "b");
  const s = summary({ root: local, scope: "branch" });
  assert.equal(s.base, "main");
  assert.deepEqual(s.files.map((f) => f.path), ["b.txt"]);
  const none = join(base, "no-default");
  mkdirSync(none);
  git(none, "init", "-q", "-b", "trunk");
  write(none, "a.txt", "a\n");
  commitAll(none, "first");
  assert.match(changesSummary({ root: none, scope: "branch" }).error ?? "", /no default branch/);
});

test("a repo without commits lists everything against the empty tree, and a plain directory isn't a repo", () => {
  const root = join(base, "fresh");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  write(root, "a.txt", "a\nb\n");
  git(root, "add", "a.txt");
  write(root, "b.txt", "c\n");
  const s = summary({ root, scope: "uncommitted" });
  assert.deepEqual(s.files.map((f) => [f.path, f.status, f.adds]), [["a.txt", "A", 2], ["b.txt", "?", 1]]);
  assert.equal(s.head, undefined);
  assert.match(changesSummary({ root, scope: "branch" }).error ?? "", /no commits/);
  const plain = join(base, "plain");
  mkdirSync(plain);
  assert.equal(changesSummary({ root: plain, scope: "uncommitted" }).error, "not a git repository");
});

test("paths with glob characters are read literally", () => {
  const root = join(base, "globs");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  write(root, "[ab].txt", "x\n");
  write(root, "a.txt", "a\n");
  commitAll(root, "first");
  write(root, "[ab].txt", "y\n");
  const req = { root, scope: "uncommitted" as const };
  const file = byPath(summary(req)).get("[ab].txt")!;
  const d = changesDiff({ ...req, file });
  assert.ok(d.text.includes("+y") && !d.text.includes("a.txt"), "only [ab].txt is diffed");
});

test("assertChangePath accepts repo-relative paths and rejects absolute paths, .., and NUL", () => {
  for (const ok of ["a.txt", "dir/b c.ts", "[ab].txt", ".hidden/x", "a..b"]) assert.equal(assertChangePath(ok), ok);
  for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a/..", "a\0b", "C:\\x", "x".repeat(5000)]) assert.throws(() => assertChangePath(bad), bad);
});

test("the list cache answers for listed paths, refuses others, and expires", () => {
  let t = 0;
  const cache = createChangesCache(1000, () => t);
  const file: ChangedFile = { path: "a.txt", status: "M", adds: 1, dels: 0 };
  assert.equal(cache.get("/r", "uncommitted", "a.txt"), undefined);
  cache.set("/r", "uncommitted", [file]);
  assert.deepEqual(cache.get("/r", "uncommitted", "a.txt"), file);
  assert.equal(cache.get("/r", "uncommitted", "b.txt"), null);
  assert.equal(cache.get("/r", "branch", "a.txt"), undefined, "scopes are listed separately");
  t = 1000;
  assert.equal(cache.get("/r", "uncommitted", "a.txt"), undefined);
});

test("the probe runs bundled with the git probe through node", async () => {
  const root = workRepo("bundled");
  const probe = { node: process.execPath };
  const out = await readChanges(probe, { root, scope: "uncommitted" });
  assert.equal(out.summary?.files.length, 8);
  const d = await readDiff(probe, { root, scope: "uncommitted", file: out.summary!.files[0] });
  assert.ok(d.text.includes("+line three"));
});

async function serveChanges(t: TestContext, root: string | undefined, probe = true) {
  const snap = snapshotFixture();
  const fleet = buildFleet(snap, new StatusClock().observe(snap.agents, 1000));
  if (root) markGit(fleet, new Map([["w1", { root, dirty: 1 }]]));
  const ctx = routeContext({ ...(probe && { probe: { node: process.execPath } }), poller: { state: () => ({ fleet }) } });
  return serveRoutes(t, changesRoutes(ctx));
}

test("GET /api/changes lists a workspace's changes, and /api/changes/diff reads one listed file", async (t) => {
  const root = workRepo("routes");
  const call = await serveChanges(t, root);
  const list = await call("GET", "/api/changes?ws=w1&scope=uncommitted");
  assert.equal(list.status, 200);
  assert.equal(list.body.files.length, 8);
  const diff = await call("GET", `/api/changes/diff?ws=w1&scope=uncommitted&path=${encodeURIComponent("a.txt")}`);
  assert.equal(diff.status, 200);
  assert.ok(diff.body.text.includes("+line three"));
  const branch = await call("GET", "/api/changes/diff?ws=w1&scope=branch&path=notes.md");
  assert.equal(branch.status, 200, "a diff in a scope not listed yet lists it first");
  assert.ok(branch.body.text.includes("+three"));
});

test("the changes routes answer 400 for malformed input and for paths the summary didn't list", async (t) => {
  const root = workRepo("routes-400");
  writeFileSync(join(base, "outside.txt"), "secret\n");
  const call = await serveChanges(t, root);
  await call("GET", "/api/changes?ws=w1&scope=uncommitted");
  const bad = [
    "/api/changes?scope=uncommitted",
    "/api/changes?ws=w1",
    "/api/changes?ws=w1&scope=all",
    "/api/changes/diff?ws=w1&scope=uncommitted",
    `/api/changes/diff?ws=w1&scope=uncommitted&path=${encodeURIComponent("../outside.txt")}`,
    `/api/changes/diff?ws=w1&scope=uncommitted&path=${encodeURIComponent(join(base, "outside.txt"))}`,
    `/api/changes/diff?ws=w1&scope=uncommitted&path=${encodeURIComponent("a.txt\0")}`,
    "/api/changes/diff?ws=w1&scope=uncommitted&path=README.md",
    "/api/changes/diff?ws=w1&scope=uncommitted&path=new.txt%2F",
  ];
  for (const path of bad) {
    const r = await call("GET", path);
    assert.equal(r.status, 400, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.equal((await call("GET", "/api/changes?ws=w9&scope=uncommitted")).status, 404, "a workspace not in the fleet");
});

test("a workspace without a repo is 404, and --no-probe turns the routes off", async (t) => {
  const none = await serveChanges(t, undefined);
  const r = await none("GET", "/api/changes?ws=w1&scope=uncommitted");
  assert.deepEqual([r.status, r.body.error], [404, "not a git repository"]);
  const fresh = join(base, "routes-no-branch");
  mkdirSync(fresh);
  git(fresh, "init", "-q", "-b", "trunk");
  const unborn = await serveChanges(t, fresh);
  const b = await unborn("GET", "/api/changes?ws=w1&scope=branch");
  assert.deepEqual([b.status, b.body.error], [422, "no commits yet"], "a scope that can't be listed says why");
  const off = await serveChanges(t, join(base, "anything"), false);
  assert.equal((await off("GET", "/api/changes?ws=w1&scope=uncommitted")).status, 503);
});
