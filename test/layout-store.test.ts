import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isLayoutName, isSavedLayout, loadStore, updateStore } from "../server/layout-store.ts";

async function tempPath() {
  return join(await mkdtemp(join(tmpdir(), "herdr-map-")), "nested", "layout.json");
}

test("accepts only maps of finite positions", () => {
  assert.equal(isSavedLayout({ w1: { x: 1, y: 2 }, w2: { x: 0, y: 0, detached: true } }), true);
  assert.equal(isSavedLayout({}), true);
  assert.equal(isSavedLayout([]), false);
  assert.equal(isSavedLayout({ w1: { x: "1", y: 2 } }), false);
  assert.equal(isSavedLayout({ w1: null }), false);
});

test("validates layout names", () => {
  assert.equal(isLayoutName("focus mode"), true);
  assert.equal(isLayoutName(""), false);
  assert.equal(isLayoutName(" padded"), false);
  assert.equal(isLayoutName("__proto__"), false);
  assert.equal(isLayoutName("x".repeat(65)), false);
});

test("a missing file loads as an empty store", async () => {
  assert.deepEqual(await loadStore(await tempPath()), { current: {}, named: {} });
});

test("saves current and named layouts independently", async () => {
  const path = await tempPath();
  await updateStore(path, (s) => {
    s.current = { w1: { x: 1, y: 2 } };
  });
  await updateStore(path, (s) => {
    s.named.work = { savedAt: 5, layout: { w1: { x: 9, y: 9 } } };
  });
  await updateStore(path, (s) => {
    s.current = {};
  });
  assert.deepEqual(await loadStore(path), {
    current: {},
    named: { work: { savedAt: 5, layout: { w1: { x: 9, y: 9 } } } },
  });
});

test("concurrent updates don't overwrite each other", async () => {
  const path = await tempPath();
  await Promise.all(
    ["a", "b", "c"].map((name) =>
      updateStore(path, (s) => {
        s.named[name] = { savedAt: 1, layout: {} };
      }),
    ),
  );
  assert.deepEqual(Object.keys((await loadStore(path)).named).sort(), ["a", "b", "c"]);
});

test("reads a file from before named layouts as the current layout", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "herdr-map-")), "layout.json");
  await writeFile(path, JSON.stringify({ w1: { x: 3, y: 4 } }));
  assert.deepEqual(await loadStore(path), { current: { w1: { x: 3, y: 4 } }, named: {} });
});
