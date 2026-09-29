import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDialogOptions } from "../shared/dialog.ts";

test("reads a Claude Code permission dialog", () => {
  const screen = [
    "⏺ Bash(rm -rf build)",
    "╭──────────────────────────────────────────────╮",
    "│ Bash command                                 │",
    "│   rm -rf build                               │",
    "│ Do you want to proceed?                      │",
    "│ ❯ 1. Yes                                     │",
    "│   2. Yes, and don't ask again for rm in /x   │",
    "│   3. No, and tell Claude what to do differently (esc) │",
    "╰──────────────────────────────────────────────╯",
  ].join("\n");
  assert.deepEqual(parseDialogOptions(screen), [
    { key: "1", label: "Yes", selected: true },
    { key: "2", label: "Yes, and don't ask again for rm in /x", selected: false },
    { key: "3", label: "No, and tell Claude what to do differently (esc)", selected: false },
  ]);
});

test("reads a Codex approval menu with descriptions between options", () => {
  const screen = [
    "Allow command?",
    "  › 1. Yes, proceed (y)",
    "    2. Yes, and don't ask again for these files (a)",
    "       Applies to this session only",
    "    3. No, and tell Codex what to do differently (esc)",
  ].join("\n");
  assert.deepEqual(
    parseDialogOptions(screen).map((o) => [o.key, o.selected]),
    [
      ["1", true],
      ["2", false],
      ["3", false],
    ],
  );
});

test("uses the last list on screen and ignores earlier numbered output", () => {
  const screen = ["Summary:", "1. Rewrote the parser", "2. Added tests", "", "Pick one:", "❯ 1. Ship it", "  2. Wait"].join("\n");
  assert.deepEqual(
    parseDialogOptions(screen).map((o) => o.label),
    ["Ship it", "Wait"],
  );
});

test("returns nothing without a numbered list starting at 1", () => {
  assert.deepEqual(parseDialogOptions("Thinking…\n3. stray\n4. lines"), []);
  assert.deepEqual(parseDialogOptions("❯ 1. only one"), []);
});
