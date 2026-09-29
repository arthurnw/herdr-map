import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  advance,
  claudeTranscript,
  claudeWindow,
  codexTranscript,
  piWindows,
  probe,
  readLines,
  summarize,
  type Cursor,
  type Roots,
} from "../probe/usage.ts";

// Synthetic transcript lines, shaped like each agent's own records.
const claude = (input: number, cacheRead: number, cacheWrite: number, model = "claude-opus-5-5", extra = {}) =>
  JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: { model, usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 50 } },
    ...extra,
  });
const claudeUser = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const codexTurn = (model: string) => JSON.stringify({ type: "turn_context", payload: { model } });
const codexTokens = (input: number, window: number) =>
  JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, cached_input_tokens: input - 10 }, model_context_window: window } },
  });
const piAssistant = (input: number, cacheRead: number, cacheWrite: number, cost: number, model = "claude-opus-5-5", provider = "anthropic") =>
  JSON.stringify({
    type: "message",
    message: { role: "assistant", provider, model, usage: { input, output: 20, cacheRead, cacheWrite, cost: { total: cost } } },
  });
const piWarm = (cost: number) => JSON.stringify({ type: "usage", kind: "cache_warm", usage: { input: 1, cacheRead: 900, cost: { total: cost } } });
const lines = (...ls: string[]) => ls.map((l) => `${l}\n`).join("");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "herdr-map-probe-"));
}

test("Claude: the latest main-thread assistant turn gives the context, including cache reads and writes", () => {
  const t = readLines(
    "claude",
    lines(claude(10, 1000, 200, "claude-sonnet-5"), claudeUser("hi"), claude(2, 5000, 300), claude(1, 99_000, 0, "claude-haiku-4-5", { isSidechain: true })),
    {},
  );
  assert.deepEqual(t, { contextTokens: 5302, model: "claude-opus-5-5" });
});

test("Claude: synthetic messages and lines that aren't JSON are skipped", () => {
  const t = readLines("claude", lines(claude(5, 100, 0), claude(0, 0, 0, "<synthetic>"), `{"usage": truncated`), {});
  assert.deepEqual(t, { contextTokens: 105, model: "claude-opus-5-5" });
});

test("Codex: the last token count gives the context and the recorded window", () => {
  const t = readLines("codex", lines(codexTurn("gpt-6-astra"), codexTokens(40_000, 258_400), codexTokens(71_189, 258_400)), {});
  assert.deepEqual(t, { model: "gpt-6-astra", contextTokens: 71_189, contextWindow: 258_400 });
});

test("Pi: context comes from the latest assistant message and cost sums every recorded cost", () => {
  const t = readLines("pi", lines(piAssistant(4, 0, 1000, 0.5), piWarm(0.25), piAssistant(2, 1000, 500, 0.125, "gpt-6-luna", "openai-codex")), {});
  assert.deepEqual(t, { costUsd: 0.875, contextTokens: 1502, model: "gpt-6-luna", provider: "openai-codex" });
});

test("readLines refuses an unknown agent kind", () => {
  assert.throws(() => readLines("aider", "{}", {}), /no transcript reader for aider/);
});

test("advance reads complete lines from the offset and leaves a partial last line for later", () => {
  const dir = tempDir();
  const path = join(dir, "t.jsonl");
  const first = lines(claude(1, 100, 0));
  const partial = claude(1, 200, 0).slice(0, 40);
  writeFileSync(path, first + partial);
  const c: Cursor = { path, offset: 0, tally: {} };
  assert.equal(advance(c, "claude", 1 << 20, 1 << 20, 1 << 20), first.length + partial.length);
  assert.equal(c.offset, first.length);
  assert.equal(c.tally.contextTokens, 101);
  assert.equal(c.caughtUp, true);
  appendFileSync(path, `${claude(1, 200, 0).slice(40)}\n`);
  advance(c, "claude", 1 << 20, 1 << 20, 1 << 20);
  assert.equal(c.tally.contextTokens, 201);
  assert.equal(advance(c, "claude", 1 << 20, 1 << 20, 1 << 20), 0, "nothing new to read");
});

test("advance stops at the byte budget and continues from there", () => {
  const dir = tempDir();
  const path = join(dir, "p.jsonl");
  const a = lines(piAssistant(1, 0, 10, 1));
  writeFileSync(path, a + lines(piAssistant(1, 0, 20, 2)));
  const c: Cursor = { path, offset: 0, tally: {} };
  advance(c, "pi", a.length + 5, 1 << 20, 1 << 20);
  assert.equal(c.offset, a.length);
  assert.equal(c.caughtUp, undefined, "not at the end yet");
  assert.equal(c.tally.costUsd, 1);
  advance(c, "pi", 1 << 20, 1 << 20, 1 << 20);
  assert.equal(c.tally.costUsd, 3);
  assert.equal(c.caughtUp, true);
});

test("advance reads only the tail of a long Claude transcript, dropping the cut line", () => {
  const dir = tempDir();
  const path = join(dir, "t.jsonl");
  const filler = lines(...Array.from({ length: 200 }, (_, i) => claudeUser(`message ${i} `.repeat(20))));
  const last = lines(claude(3, 7000, 0));
  writeFileSync(path, lines(claude(1, 1, 1)) + filler + last);
  const c: Cursor = { path, offset: 0, tally: {} };
  const read = advance(c, "claude", 1 << 20, 4096, 1 << 20);
  assert.equal(read, 4096);
  assert.equal(c.tally.contextTokens, 7003);
});

test("advance drops a line longer than the line limit and resumes after it", () => {
  const dir = tempDir();
  const path = join(dir, "t.jsonl");
  const huge = claudeUser("x".repeat(5000));
  writeFileSync(path, lines(huge, claude(1, 50, 0)));
  const c: Cursor = { path, offset: 0, tally: {} };
  advance(c, "claude", 1000, 1 << 20, 1000);
  assert.equal(c.skip, true);
  advance(c, "claude", 1 << 20, 1 << 20, 1000);
  assert.equal(c.tally.contextTokens, 51);
});

test("advance starts over when the file got shorter", () => {
  const dir = tempDir();
  const path = join(dir, "p.jsonl");
  writeFileSync(path, lines(piAssistant(1, 0, 10, 1), piAssistant(1, 0, 10, 1)));
  const c: Cursor = { path, offset: 0, tally: {} };
  advance(c, "pi", 1 << 20, 1 << 20, 1 << 20);
  assert.equal(c.tally.costUsd, 2);
  writeFileSync(path, lines(piAssistant(1, 0, 10, 0.5)));
  advance(c, "pi", 1 << 20, 1 << 20, 1 << 20);
  assert.equal(c.tally.costUsd, 0.5);
});

test("claudeTranscript finds a session by the cwd slug, or in another project folder", () => {
  const root = tempDir();
  const id = "1fcd536a-ca43-43bf-8d03-a6ed74098343";
  mkdirSync(join(root, "projects", "-Users-me-code-app--worktrees-x"), { recursive: true });
  writeFileSync(join(root, "projects", "-Users-me-code-app--worktrees-x", `${id}.jsonl`), "");
  assert.equal(claudeTranscript(root, id, "/Users/me/code/app__worktrees/x"), join(root, "projects", "-Users-me-code-app--worktrees-x", `${id}.jsonl`));
  assert.equal(claudeTranscript(root, id, "/somewhere/else"), join(root, "projects", "-Users-me-code-app--worktrees-x", `${id}.jsonl`));
  assert.equal(claudeTranscript(root, "00000000-0000-0000-0000-000000000000", "/x"), undefined);
});

test("codexTranscript finds a rollout from the date in its UUIDv7 thread ID", () => {
  const root = tempDir();
  const ms = Date.UTC(2026, 8, 10, 15, 43, 3);
  const id = `${ms.toString(16).padStart(12, "0").replace(/^(.{8})(.{4})$/, "$1-$2")}-7ca2-9a44-97310a5f4861`;
  const d = new Date(ms);
  const day = join(root, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-09-10T08-43-03-${id}.jsonl`), "");
  assert.equal(codexTranscript(root, id), join(day, `rollout-2026-09-10T08-43-03-${id}.jsonl`));
  assert.equal(codexTranscript(root, "01a08bfc-0000-7000-8000-000000000000"), undefined);
});

test("windows: Codex's recorded window, Pi's model registry, then the Claude table", () => {
  const root = tempDir();
  writeFileSync(join(root, "models-store.json"), JSON.stringify({ "openai-codex": { models: [{ id: "gpt-6-luna", contextWindow: 272_000 }] } }));
  writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { local: { models: [{ id: "tiny", contextWindow: 8000 }] } } }));
  const lookup = piWindows(root);
  const pi = () => lookup;
  assert.equal(summarize("codex", { contextTokens: 10, contextWindow: 258_400 }, pi).contextWindow, 258_400);
  assert.equal(summarize("pi", { contextTokens: 10, model: "gpt-6-luna", provider: "openai-codex" }, pi).contextWindow, 272_000);
  assert.equal(summarize("pi", { contextTokens: 10, model: "tiny", provider: "local" }, pi).contextWindow, 8000);
  assert.equal(summarize("pi", { contextTokens: 10, model: "claude-opus-5-5", provider: "anthropic" }, pi).contextWindow, 1_000_000);
  assert.equal(summarize("claude", { contextTokens: 10, model: "claude-mystery-9" }, pi).contextWindow, undefined);
  assert.equal(summarize("claude", { contextTokens: 300_000, model: "claude-haiku-4-5" }, pi).contextWindow, undefined, "a window smaller than the context is dropped");
});

test("claudeWindow knows current and older Claude models", () => {
  assert.equal(claudeWindow("claude-opus-5-5"), 1_000_000);
  assert.equal(claudeWindow("claude-fable-5-1"), 1_000_000);
  assert.equal(claudeWindow("claude-sonnet-4-6"), 1_000_000);
  assert.equal(claudeWindow("claude-haiku-4-5-20251001"), 200_000);
  assert.equal(claudeWindow("claude-opus-4-5-20251101"), 200_000);
  assert.equal(claudeWindow("claude-sonnet-4-20250514"), 200_000);
  assert.equal(claudeWindow("sonnet"), undefined);
});

test("probe returns usage per pane, round-trips cursors, and reports per-pane errors", () => {
  const dir = tempDir();
  const roots: Roots = { claude: join(dir, "claude"), codex: join(dir, "codex"), pi: join(dir, "pi") };
  const id = "5a1e0000-0000-4000-8000-000000000001";
  mkdirSync(join(roots.claude, "projects", "-repos-web"), { recursive: true });
  writeFileSync(join(roots.claude, "projects", "-repos-web", `${id}.jsonl`), lines(claude(1, 500_000, 120_000)));
  const piPath = join(dir, "pi-session.jsonl");
  writeFileSync(piPath, lines(piAssistant(4, 0, 43_000, 1.25)));
  const refs = [
    { pane: "w1:p1", kind: "claude", sessionKind: "id", session: id, cwd: "/repos/web" },
    { pane: "w2:p1", kind: "pi", sessionKind: "path", session: piPath },
    { pane: "w3:p1", kind: "codex", sessionKind: "id", session: "01a08bfc-9ca2-7ca2-9a44-97310a5f4861" },
    { pane: "w4:p1", kind: "claude", sessionKind: "id", session: "../../etc/passwd" },
    { pane: "w5:p1", kind: "pi", sessionKind: "path", session: "relative.jsonl" },
  ];
  const out = probe({ refs, roots });
  const by = new Map(out.results.map((r) => [r.pane, r]));
  assert.deepEqual(by.get("w1:p1")!.usage, { model: "claude-opus-5-5", contextTokens: 620_001, contextWindow: 1_000_000, costUsd: undefined });
  assert.deepEqual(by.get("w2:p1")!.usage, { model: "claude-opus-5-5", contextTokens: 43_004, contextWindow: 1_000_000, costUsd: 1.25 });
  assert.equal(by.get("w3:p1")!.error, "transcript not found");
  assert.equal(by.get("w4:p1")!.error, "unexpected session id");
  assert.equal(by.get("w5:p1")!.error, "session path is not absolute");
  assert.equal(out.bytesRead > 0, true);

  appendFileSync(piPath, lines(piAssistant(4, 43_000, 2000, 0.5)));
  const again = probe({ refs: refs.slice(0, 2).map((r) => ({ ...r, cursor: by.get(r.pane)!.cursor })), roots });
  assert.equal(again.results[0].usage!.contextTokens, 620_001);
  assert.deepEqual(again.results[1].usage, { model: "claude-opus-5-5", contextTokens: 45_004, contextWindow: 1_000_000, costUsd: 1.75 });
  assert.equal(again.bytesRead, lines(piAssistant(4, 43_000, 2000, 0.5)).length, "only new bytes are read");
});

test("probe withholds a Pi agent's numbers until its whole transcript is read, within the byte budget", () => {
  const dir = tempDir();
  const path = join(dir, "pi.jsonl");
  const line = lines(piAssistant(1, 0, 100, 0.5));
  writeFileSync(path, line.repeat(10));
  const ref = { pane: "w1:p1", kind: "pi", sessionKind: "path", session: path };
  const first = probe({ refs: [ref], maxBytes: line.length * 4 });
  assert.equal(first.results[0].usage, undefined);
  assert.equal(first.bytesRead, line.length * 4);
  let cursor = first.results[0].cursor;
  let usage;
  for (let i = 0; i < 3 && !usage; i++) {
    const r = probe({ refs: [{ ...ref, cursor }], maxBytes: line.length * 4 }).results[0];
    cursor = r.cursor;
    usage = r.usage;
  }
  assert.equal(usage?.costUsd, 5);
});
