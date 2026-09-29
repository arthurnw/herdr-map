import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchShortcut, findShortcut, isIgnoredTarget, type KeyEventLike, type Registration, type Shortcut } from "../web/shortcuts.ts";

// A stand-in for a DOM element: `closest` matches when the element is, or sits inside, one of `tags`.
function element(...tags: string[]) {
  return {
    closest: (selector: string) =>
      selector
        .split(",")
        .map((s) => s.trim())
        .some((s) => tags.includes(s))
        ? {}
        : null,
  };
}

function key(k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike & { prevented: boolean } {
  return {
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: element("div"),
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    ...mods,
  };
}

function reg(binding: Omit<Shortcut, "description">): Registration & { calls: number } {
  const r = { binding: { description: binding.key, ...binding }, calls: 0, handler: () => void r.calls++ };
  return r;
}

test("keys typed into a field or an open menu are ignored", () => {
  const n = reg({ key: "n" });
  for (const tag of ["input", "textarea", "select", "[contenteditable]", "[role=menu]"]) {
    assert.equal(findShortcut([n], key("n", { target: element(tag) })), undefined, tag);
  }
  assert.equal(findShortcut([n], key("n")), n);
  assert.ok(!isIgnoredTarget(null));
  assert.ok(!isIgnoredTarget({}), "a target without closest (window, document) is not a field");
});

test("Cmd, Ctrl, and Alt are ignored unless a binding asks for them", () => {
  const plain = reg({ key: "k" });
  for (const mod of ["metaKey", "ctrlKey", "altKey"] as const) {
    assert.equal(findShortcut([plain], key("k", { [mod]: true })), undefined, mod);
  }
  const cmdK = reg({ key: "k", meta: true });
  assert.equal(findShortcut([plain, cmdK], key("k", { metaKey: true })), cmdK);
  assert.equal(findShortcut([cmdK], key("k")), undefined, "a Cmd binding needs Cmd held");
  assert.equal(findShortcut([cmdK], key("k", { metaKey: true, ctrlKey: true })), undefined);
});

test("n and Shift+n are separate bindings", () => {
  const next = reg({ key: "n" });
  const prev = reg({ key: "N" });
  assert.equal(findShortcut([next, prev], key("n")), next);
  assert.equal(findShortcut([next, prev], key("N", { shiftKey: true })), prev);
});

test("Shift is only checked when a binding sets it", () => {
  const slash = reg({ key: "/" });
  // Some layouts need Shift to type "/".
  assert.equal(findShortcut([slash], key("/", { shiftKey: true })), slash);
  const shiftEnter = reg({ key: "Enter", shift: true });
  assert.equal(findShortcut([shiftEnter], key("Enter")), undefined);
  assert.equal(findShortcut([shiftEnter], key("Enter", { shiftKey: true })), shiftEnter);
});

test("disabled bindings don't fire or prevent the default action", () => {
  let on = false;
  const off = reg({ key: "o", enabled: false });
  const dynamic = reg({ key: "r", enabled: () => on });
  const e = key("o");
  assert.equal(dispatchShortcut([off], e), false);
  assert.equal(off.calls, 0);
  assert.equal(e.prevented, false);
  assert.equal(dispatchShortcut([dynamic], key("r")), false);
  on = true;
  const r = key("r");
  assert.equal(dispatchShortcut([dynamic], r), true);
  assert.equal(dynamic.calls, 1);
  assert.equal(r.prevented, true);
});

test("a disabled binding lets a later binding for the same key handle it", () => {
  const first = reg({ key: "Enter", enabled: false });
  const second = reg({ key: "Enter" });
  assert.equal(findShortcut([first, second], key("Enter")), second);
});

test("a binding marked inInputs still fires while typing", () => {
  const input = { closest: (sel: string) => (sel.includes("input") ? {} : null) };
  const palette = { binding: { key: "k", meta: true, description: "Palette", inInputs: true }, handler: () => {} };
  const next = { binding: { key: "n", description: "Next" }, handler: () => {} };
  const event = (key: string, metaKey = false) => ({ key, metaKey, ctrlKey: false, altKey: false, shiftKey: false, target: input, preventDefault() {} });
  assert.equal(findShortcut([palette, next], event("k", true)), palette);
  assert.equal(findShortcut([palette, next], event("n")), undefined);
});
