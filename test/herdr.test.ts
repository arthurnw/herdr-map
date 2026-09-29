import assert from "node:assert/strict";
import { test } from "node:test";
import { assertId, assertKeys, commandFor, herdrMessage } from "../server/herdr.ts";

test("runs herdr directly without --ssh", () => {
  assert.deepEqual(commandFor({ bin: "herdr" }, ["agent", "focus", "w1:p2"]), ["herdr", ["agent", "focus", "w1:p2"]]);
});

test("quotes each argument for the remote shell with --ssh", () => {
  const [cmd, argv] = commandFor({ ssh: "mini", bin: "herdr" }, ["pane", "read", "it's"]);
  assert.equal(cmd, "ssh");
  assert.deepEqual(argv, ["-o", "BatchMode=yes", "mini", `'herdr' 'pane' 'read' 'it'\\''s'`]);
});

test("rejects IDs that are not herdr handles", () => {
  assert.equal(assertId("w3:p2W"), "w3:p2W");
  assert.throws(() => assertId("w1; rm -rf ~"));
  assert.throws(() => assertId(""));
});

test("accepts herdr key names and rejects anything else", () => {
  assert.deepEqual(assertKeys(["1", "enter", "esc", "up", "shift+tab", "ctrl+c"]), ["1", "enter", "esc", "up", "shift+tab", "ctrl+c"]);
  assert.throws(() => assertKeys([]));
  assert.throws(() => assertKeys(["enter; rm -rf ~"]));
  assert.throws(() => assertKeys(["ab"]));
  assert.throws(() => assertKeys("enter"));
});

test("herdrMessage pulls herdr's message out of a failed command", () => {
  const err = new Error(`herdr agent rename w1:p1 lead: {"error":{"code":"name_taken","message":"agent name lead is already used"}}`);
  assert.equal(herdrMessage(err), "agent name lead is already used");
  assert.equal(herdrMessage(new Error("ssh: connect to host mini: timed out")), "ssh: connect to host mini: timed out");
});
