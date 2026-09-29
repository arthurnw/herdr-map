import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isSavedLayout, loadLayout, saveLayout } from "../server/layout-store.ts";

test("accepts only maps of finite positions", () => {
  assert.equal(isSavedLayout({ w1: { x: 1, y: 2 }, w2: { x: 0, y: 0, detached: true } }), true);
  assert.equal(isSavedLayout({}), true);
  assert.equal(isSavedLayout([]), false);
  assert.equal(isSavedLayout({ w1: { x: "1", y: 2 } }), false);
  assert.equal(isSavedLayout({ w1: null }), false);
});

test("round-trips a layout and treats a missing file as empty", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "herdr-map-")), "nested", "layout.json");
  assert.deepEqual(await loadLayout(path), {});
  await saveLayout(path, { w1: { x: 3, y: 4 } });
  assert.deepEqual(await loadLayout(path), { w1: { x: 3, y: 4 } });
});
