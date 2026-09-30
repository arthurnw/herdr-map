import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finalReply, REPLY_CHARS, replyText, trimReply } from "../probe/reply.ts";

// Synthetic transcript lines, shaped like each agent's own records.
const lines = (...ls: unknown[]) => ls.map((l) => `${JSON.stringify(l)}\n`).join("");

const claudeUser = (content: unknown, extra = {}) => ({ type: "user", isSidechain: false, message: { role: "user", content }, ...extra });
const claudeToolResult = (id: string) => claudeUser([{ type: "tool_result", tool_use_id: id, content: "ok" }]);
const claudeBlock = (id: string, block: unknown, extra = {}) => ({
  type: "assistant",
  isSidechain: false,
  message: { id, role: "assistant", model: "claude-opus-5-5", content: [block] },
  ...extra,
});
const text = (t: string) => ({ type: "text", text: t });
const thinking = (t: string) => ({ type: "thinking", thinking: t, signature: "sig" });
const toolUse = (id: string) => ({ type: "tool_use", id, name: "Bash", input: { command: "npm test" } });

test("Claude: the reply is the last response with text in the latest turn, without thinking or tool calls", () => {
  const transcript = lines(
    claudeUser("First prompt."),
    claudeBlock("m1", text("First turn's reply.")),
    claudeUser("Second prompt."),
    claudeBlock("m2", thinking("Let me look.")),
    claudeBlock("m2", text("I'll run the tests.")),
    claudeBlock("m2", toolUse("t1")),
    claudeToolResult("t1"),
    claudeBlock("m3", thinking("They pass.")),
    claudeBlock("m3", text("All 12 tests pass.")),
    // Tool results can land between the lines of one response.
    claudeBlock("m3", toolUse("t2")),
    claudeToolResult("t2"),
    claudeBlock("m3", text("The fix is in parse.ts.")),
    { type: "assistant", isSidechain: true, message: { id: "s1", role: "assistant", content: [text("A subagent's words.")] } },
    claudeUser("<command-caveat>local command</command-caveat>", { isMeta: true }),
    claudeUser("<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>"),
    { type: "system", subtype: "turn_duration", durationMs: 1000 },
  );
  assert.equal(replyText("claude", transcript), "All 12 tests pass.\n\nThe fix is in parse.ts.");
});

test("Claude: a turn whose last response only calls a tool keeps the text before it; a new prompt clears it", () => {
  const base = [claudeUser("Go."), claudeBlock("m1", text("Starting.")), claudeBlock("m1", toolUse("t1")), claudeToolResult("t1"), claudeBlock("m2", toolUse("t2"))];
  assert.equal(replyText("claude", lines(...base)), "Starting.");
  assert.equal(replyText("claude", lines(...base, claudeUser([text("Next prompt.")]))), undefined);
  const synthetic = { type: "assistant", isSidechain: false, message: { id: "x", role: "assistant", model: "<synthetic>", content: [text("No response requested.")] } };
  assert.equal(replyText("claude", lines(...base, synthetic)), "Starting.");
});

test("Codex: the final answer of the last turn", () => {
  const item = (payload: unknown) => ({ type: "response_item", payload });
  const event = (payload: unknown) => ({ type: "event_msg", payload });
  const say = (t: string, phase?: string) => item({ type: "message", role: "assistant", ...(phase && { phase }), content: [{ type: "output_text", text: t }] });
  const turn1 = [
    event({ type: "task_started" }),
    item({ type: "message", role: "user", content: [{ type: "input_text", text: "Run the tests." }] }),
    item({ type: "reasoning", summary: [{ type: "summary_text", text: "Thinking about tests." }] }),
    say("I'll run them.", "commentary"),
    item({ type: "function_call", name: "exec_command", arguments: "{}" }),
    item({ type: "function_call_output", output: "ok" }),
    say("Tests pass.", "final_answer"),
    event({ type: "task_complete", last_agent_message: "Tests pass." }),
  ];
  assert.equal(replyText("codex", lines(...turn1)), "Tests pass.");
  const turn2 = [event({ type: "task_started" }), item({ type: "message", role: "user", content: [{ type: "input_text", text: "Ask me." }] })];
  assert.equal(replyText("codex", lines(...turn1, ...turn2, item({ type: "function_call", name: "ask" }), event({ type: "task_complete", last_agent_message: null }))), undefined);
  // Older rollouts log the reply as an event.
  assert.equal(replyText("codex", lines(event({ type: "user_message", message: "Hi" }), event({ type: "agent_message", message: "Hello." }))), "Hello.");
  // A message from another agent in the tree starts a new turn.
  assert.equal(replyText("codex", lines(...turn1, item({ type: "agent_message", content: [{ type: "input_text", text: "Task name: /root/lint" }] }))), undefined);
});

test("Pi: the last assistant message's text parts after the last user message", () => {
  const msg = (role: string, content: unknown) => ({ type: "message", message: { role, content } });
  const transcript = lines(
    msg("user", [text("Fix it.")]),
    msg("assistant", [thinking("Hmm."), text("Looking."), { type: "toolCall", id: "c1", name: "read", arguments: {} }]),
    msg("toolResult", [text("file contents")]),
    msg("assistant", [thinking("Done."), text("Fixed the bug."), text("Tests pass.")]),
    { type: "custom", customType: "oppi-lifecycle" },
  );
  assert.equal(replyText("pi", transcript), "Fixed the bug.\n\nTests pass.");
  assert.equal(replyText("pi", transcript + lines(msg("user", "Next."))), undefined);
  assert.throws(() => replyText("gemini", transcript), /no transcript reader/);
});

test("long replies keep their end, from a word start", () => {
  const long = `${"word ".repeat(3000)}the end.`;
  const out = trimReply(long);
  assert.equal(out.trimmed, true);
  assert.ok(out.text.length <= REPLY_CHARS && out.text.startsWith("word ") && out.text.endsWith("the end."));
  assert.deepEqual(trimReply("short"), { text: "short" });
});

test("finalReply reads the tail of the given transcript, or finds it as the usage probe does", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-map-reply-"));
  const dir = join(root, "projects", "-repos-w1");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "s1.jsonl");
  const filler = lines(...Array.from({ length: 200 }, (_, i) => claudeToolResult(`t${i}`)));
  writeFileSync(path, lines(claudeUser("Old prompt.")) + filler + lines(claudeUser("Go."), claudeBlock("m1", text(`${"x".repeat(REPLY_CHARS)} done.`))));
  const ref = { pane: "w1:p1", kind: "claude", sessionKind: "id", session: "s1", cwd: "/repos/w1" };
  const byPath = finalReply({ ref, path, bytes: 20_000 });
  assert.equal(byPath.path, path);
  assert.equal(byPath.trimmed, true);
  assert.ok(byPath.text!.endsWith(" done."));
  assert.equal(finalReply({ ref, roots: { claude: root } }, { processes: () => undefined }).path, path, "no path given: herdr's session ID names the transcript");
  assert.deepEqual(finalReply({ ref: { ...ref, session: "missing" }, roots: { claude: root } }, { processes: () => undefined, screen: () => undefined }), { error: "transcript not found" });
  assert.deepEqual(finalReply({ ref, path: "/etc/passwd" }), { error: "not a transcript path" });
  writeFileSync(path, lines(claudeUser("Go.")));
  assert.deepEqual(finalReply({ ref, path }), { path }, "a turn without text has no reply");
});
