import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  herdrScreen,
  matchScreen,
  probe,
  repoRoots,
  SCREEN_RETRY_MS,
  screenLines,
  screenText,
  transcriptText,
  type PaneProcess,
  type ProbeRef,
  type Roots,
} from "../probe/usage.ts";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "herdr-map-screen-"));
}

// Synthetic Claude Code transcript records.
const assistantText = (text: string, read = 90_000) =>
  JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], usage: { input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: 0 } },
  });
const userText = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const thinking = (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: text, signature: "x" }] } });
const lines = (...ls: string[]) => ls.map((l) => `${l}\n`).join("");
const slug = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");

const REPLY = [
  "The nightly export stopped after the vendor renamed the bucket prefix, so every file since Tuesday landed in the old folder.",
  "I moved the three missed files by hand and reran the loader; row counts now match the vendor's manifest for each day.",
  "Next I'd add a check that fails the job when the manifest lists a file the loader didn't see, instead of passing silently.",
].join("\n");

// A screen as Claude Code draws it: conversation text among prompts, spinners, rules, and footers.
const SCREEN = [
  "❯ why did the export stop on tuesday?",
  "",
  "⏺ The nightly export stopped after the vendor renamed the bucket prefix, so every file since Tuesday landed in the",
  "  old folder.",
  "",
  "  I moved the three missed files by hand and reran the loader; row counts now match the vendor's manifest for each",
  "  day.",
  "",
  "  Next I'd add a check that fails the job when the manifest lists a file the loader didn't see, instead of passing",
  "  silently.",
  "",
  "✻ Worked for 2m 10s · done 4:12 PM · plenty of words to be long enough here",
  "─────────────────────────────────────────────────────────── export-fix ─",
  "❯ ok add that check to the loader and open a pull request for it when done",
  "────────────────────────────────────────────────────────────────────────",
  "   main ↗0 ↘2 ⋅  loader ⋅ Concise ⋅ 18% ⋅ $4.20 ⋅ +61 -2 and some more words",
  "  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents running here now",
].join("\n");

test("screenLines picks long conversation lines and skips prompts, spinners, rules, and footers", () => {
  const picked = screenLines(SCREEN);
  assert.deepEqual(picked.toSorted(), [
    "i moved the three missed files by hand and reran the loader row counts now match the vendor s manifest for each",
    "next i d add a check that fails the job when the manifest lists a file the loader didn t see instead of passing",
    "the nightly export stopped after the vendor renamed the bucket prefix so every file since tuesday landed in the",
  ]);
  assert.equal(screenLines("⏺ a short line with only a few words\n  but this other line has plenty more words in it than that one does")[0], "but this other line has plenty more words in it than that one does");
  assert.deepEqual(screenLines("│ a table cell with plenty of words in it to be long enough │\n  short line here"), []);
  assert.equal(screenLines(SCREEN, 2).length, 2);
});

test("transcript text matches the screen through JSON escaping, markdown, and unicode", () => {
  const dir = tempDir();
  const path = join(dir, "t.jsonl");
  const text = 'The "Björn" brand filter used `ILIKE \'%bjorn%\'` and **dropped** the accented rows — 12 of 40 in total.\nSecond paragraph.';
  // Claude Code writes non-ASCII as is; escape it here as other writers might.
  const escaped = assistantText(text).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.match(escaped, /\\u00f6/);
  writeFileSync(path, lines(userText("filler"), escaped, thinking("the screen never shows this thinking text at all, however long it is")));
  const shown = transcriptText(path);
  const screen = `⏺ The "Björn" brand filter used ILIKE '%bjorn%' and dropped the accented rows — 12 of 40 in total.\n  Second paragraph.`;
  const [line] = screenLines(screen);
  assert.equal(line, "the björn brand filter used ilike bjorn and dropped the accented rows 12 of 40 in total");
  assert.ok(shown.includes(line));
  assert.ok(!shown.includes(screenText("the screen never shows this thinking text")), "thinking isn't searched");
});

test("transcriptText reads only the tail and drops the line it cuts", () => {
  const dir = tempDir();
  const path = join(dir, "t.jsonl");
  writeFileSync(path, lines(assistantText("an old reply from long ago that is no longer in the tail"), userText("x".repeat(2000)), assistantText("the latest reply")));
  const shown = transcriptText(path, 1000);
  assert.ok(shown.includes("the latest reply"));
  assert.ok(!shown.includes("old reply"));
});

test("matchScreen accepts one candidate with two or more lines, or the only one with any", () => {
  const texts: Record<string, string> = { a: "one two", b: "two", c: "three" };
  const read = (p: string) => texts[p];
  assert.equal(matchScreen(["one", "two"], ["a", "b", "c"], read), "a", "only a has two");
  assert.equal(matchScreen(["three", "four"], ["a", "b", "c"], read), "c", "only c has any");
  assert.equal(matchScreen(["two"], ["a", "b"], read), undefined, "two candidates, one line each");
  texts.b = "one two";
  assert.equal(matchScreen(["one", "two"], ["a", "b", "c"], read), undefined, "two candidates with two lines");
  assert.equal(matchScreen([], ["a"], read), undefined);
  assert.equal(matchScreen(["one"], ["missing", "a"], (p) => (p === "missing" ? assert.fail("unreadable") : read(p))), "a");
});

test("repoRoots lists a repository's working trees from its .git files", () => {
  const dir = tempDir();
  const main = join(dir, "code", "app");
  const wt = join(dir, "worktrees", "app", "fix");
  mkdirSync(join(main, ".git", "worktrees", "fix"), { recursive: true });
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "fix")}\n`);
  writeFileSync(join(main, ".git", "worktrees", "fix", "commondir"), "../..\n");
  writeFileSync(join(main, ".git", "worktrees", "fix", "gitdir"), `${join(wt, ".git")}\n`);
  assert.deepEqual(repoRoots(join(wt, "src")), [wt, main]);
  assert.deepEqual(repoRoots(main), [main, wt]);
  const outside = join(dir, "plain");
  mkdirSync(outside);
  assert.equal(repoRoots(outside).at(0), outside);
});

// The case this is for: the pane's process names a session with no transcript and a parked job
// with no entry, and the conversation it shows is a background job's session in the main checkout.
const STALE = "5e551043-0000-4000-8000-000000000001";
const JOB = "b0b0cafe-0000-4000-8000-000000000002";
const OTHER = "0badcafe-0000-4000-8000-000000000003";
const claudeProc = (pid: number): PaneProcess => ({ pid, argv0: "claude", name: "2.1.300" });

function unlinkedFixture() {
  const dir = tempDir();
  const roots: Roots = { claude: join(dir, "claude"), codex: join(dir, "codex"), pi: join(dir, "pi") };
  const main = join(dir, "code", "app");
  const wt = join(dir, "worktrees", "app", "audit");
  mkdirSync(join(main, ".git", "worktrees", "audit"), { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "audit")}\n`);
  writeFileSync(join(main, ".git", "worktrees", "audit", "commondir"), "../..\n");
  writeFileSync(join(main, ".git", "worktrees", "audit", "gitdir"), `${join(wt, ".git")}\n`);
  const project = join(roots.claude, "projects", slug(main));
  mkdirSync(project, { recursive: true });
  mkdirSync(join(roots.claude, "sessions"), { recursive: true });
  const entry = (pid: number, o: object) => writeFileSync(join(roots.claude, "sessions", `${pid}.json`), JSON.stringify({ pid, ...o }));
  entry(100, { sessionId: STALE, kind: "interactive", cwd: wt, parkedJobId: "d00dfeed" });
  entry(200, { sessionId: JOB, kind: "bg", jobId: "b0b0cafe", cwd: main });
  const job = join(project, `${JOB}.jsonl`);
  writeFileSync(job, lines(userText("why did the export stop on tuesday?"), assistantText(REPLY, 184_000)));
  const other = join(project, `${OTHER}.jsonl`);
  writeFileSync(other, lines(userText("something else"), assistantText("An unrelated conversation about dashboards and their owners, nothing like the export.", 5_000)));
  const ref: ProbeRef = { pane: "w2D:pC", kind: "claude", sessionKind: "id", session: STALE, cwd: wt, status: "idle" };
  let t = Date.now();
  let screen: string | undefined = SCREEN;
  const reads: string[] = [];
  const deps = {
    processes: () => [claudeProc(100)],
    screen: (pane: string) => (reads.push(pane), screen),
    now: () => t,
  };
  return {
    roots,
    main,
    project,
    job,
    other,
    ref,
    deps,
    reads,
    advance: (ms: number) => (t += ms),
    setScreen: (s: string | undefined) => (screen = s),
  };
}

test("probe finds an unlinked pane's transcript from its screen and caches the match", () => {
  const f = unlinkedFixture();
  const r = probe({ refs: [f.ref], roots: f.roots }, f.deps).results[0];
  assert.equal(r.error, undefined);
  assert.equal(r.cursor?.path, f.job);
  assert.equal(r.cursor?.claude?.session, JOB);
  assert.ok(r.cursor?.claude?.screen);
  assert.equal(r.usage?.contextTokens, 184_002);
  assert.deepEqual(f.reads, ["w2D:pC"]);

  // Cached: neither the minute's session re-check nor the next few minutes read the screen again.
  f.advance(SCREEN_RETRY_MS - 1);
  const again = probe({ refs: [{ ...f.ref, cursor: r.cursor }], roots: f.roots }, f.deps);
  assert.equal(again.results[0].usage?.contextTokens, 184_002);
  assert.equal(again.bytesRead, 0);
  assert.equal(f.reads.length, 1);
});

test("a match in the pane's repository is found without a sessions entry", () => {
  const f = unlinkedFixture();
  writeFileSync(join(f.roots.claude, "sessions", "200.json"), "{}");
  const r = probe({ refs: [f.ref], roots: f.roots }, f.deps).results[0];
  assert.equal(r.cursor?.path, f.job);
});

test("screen lines in two transcripts match neither", () => {
  const f = unlinkedFixture();
  appendFileSync(f.other, lines(assistantText(REPLY)));
  const r = probe({ refs: [f.ref], roots: f.roots }, f.deps).results[0];
  assert.equal(r.error, "transcript not found");
  assert.equal(r.usage, undefined);
  assert.equal(r.cursor?.path, "", "the failed match is recorded");

  // Looked for again only after a few minutes.
  f.advance(SCREEN_RETRY_MS - 1);
  let next = probe({ refs: [{ ...f.ref, cursor: r.cursor }], roots: f.roots }, f.deps).results[0];
  assert.equal(next.error, "transcript not found");
  assert.equal(f.reads.length, 1);
  f.advance(1);
  writeFileSync(f.other, lines(assistantText("An unrelated conversation.")));
  next = probe({ refs: [{ ...f.ref, cursor: next.cursor }], roots: f.roots }, f.deps).results[0];
  assert.equal(f.reads.length, 2);
  assert.equal(next.cursor?.path, f.job);
});

test("a transcript another pane is on isn't matched", () => {
  const f = unlinkedFixture();
  const owner: ProbeRef = { pane: "w9:p1", kind: "claude", sessionKind: "id", session: JOB, cwd: f.main, status: "idle" };
  const out = probe({ refs: [f.ref, owner], roots: f.roots }, { ...f.deps, processes: (p: string) => (p === "w9:p1" ? [] : [claudeProc(100)]) });
  assert.equal(out.results[0].error, "transcript not found");
  assert.equal(out.results[1].cursor?.path, f.job, "the owner reads it");
  // The server names panes that aren't in this run.
  const r = probe({ refs: [f.ref], roots: f.roots, claimed: [JOB] }, f.deps).results[0];
  assert.equal(r.error, "transcript not found");
});

test("a match is kept while the screen is unchanged or the transcript grows, and dropped otherwise", () => {
  const f = unlinkedFixture();
  let r = probe({ refs: [f.ref], roots: f.roots }, f.deps).results[0];
  const run = () => (r = probe({ refs: [{ ...f.ref, cursor: r.cursor }], roots: f.roots }, f.deps).results[0]);

  f.advance(SCREEN_RETRY_MS);
  run();
  assert.equal(f.reads.length, 2, "re-read after a few minutes");
  assert.equal(r.cursor?.path, f.job, "same screen");

  // The screen shows a reply still being written, which no transcript has yet, but the transcript grows.
  f.advance(1000);
  f.setScreen("⏺ A long reply that is still streaming onto the screen and isn't in the transcript yet.");
  appendFileSync(f.job, lines(assistantText("A tool call finished.", 190_000)));
  run();
  f.advance(SCREEN_RETRY_MS);
  run();
  assert.equal(f.reads.length, 3);
  assert.equal(r.cursor?.path, f.job, "the transcript grew");
  assert.equal(r.usage?.contextTokens, 190_002);

  // The pane moves on to a conversation that isn't anywhere; the matched transcript stays put.
  f.setScreen("⏺ Something that isn't in any transcript at all, written after the pane moved on elsewhere.");
  f.advance(SCREEN_RETRY_MS);
  run();
  assert.equal(r.error, "transcript not found");
  assert.equal(r.cursor?.path, "");
});

test("at most one screen is read per run, and none when herdr can't read it", () => {
  const f = unlinkedFixture();
  const second = { ...f.ref, pane: "w2D:pD" };
  const out = probe({ refs: [f.ref, second], roots: f.roots }, f.deps);
  assert.deepEqual(f.reads, ["w2D:pC"]);
  assert.equal(out.results[1].error, "transcript not found");
  assert.equal(out.results[1].cursor, undefined, "left for the next run");

  const g = unlinkedFixture();
  g.setScreen(undefined);
  const r = probe({ refs: [g.ref], roots: g.roots }, g.deps).results[0];
  assert.equal(r.error, "transcript not found");
  g.advance(1000);
  probe({ refs: [{ ...g.ref, cursor: r.cursor }], roots: g.roots }, g.deps);
  assert.equal(g.reads.length, 1, "not retried every run");
});

test("herdrScreen reads the visible screen, and a failing herdr gives nothing", () => {
  const dir = tempDir();
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!/bin/sh\n[ "$*" = "pane read w2P:p1 --source visible --lines 80" ] || exit 1\nprintf 'hello\\n'\n`);
  chmodSync(bin, 0o755);
  const read = herdrScreen(bin);
  assert.equal(read("w2P:p1"), "hello\n");
  assert.equal(read("w9:p9"), undefined);
  assert.equal(read("--help"), undefined);
  assert.equal(herdrScreen(join(dir, "missing"))("w2P:p1"), undefined);
});
