import assert from "node:assert/strict";
import { test } from "node:test";
import { assertId, assertKeys, commandFor } from "../server/herdr.ts";

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
