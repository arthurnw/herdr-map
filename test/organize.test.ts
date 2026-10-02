import assert from "node:assert/strict";
import { test } from "node:test";
import { applyWorkspacePatch, isColor, MAX_TAGS, normalizeTag, type MetaState } from "../shared/organize.ts";

test("normalizeTag cleans typed text or rejects it", () => {
  assert.equal(normalizeTag("  #Infra "), "infra");
  assert.equal(normalizeTag("needs review"), "needs-review");
  assert.equal(normalizeTag("v2.1_rc"), "v2.1_rc");
  assert.equal(normalizeTag(""), undefined);
  assert.equal(normalizeTag("-x"), undefined);
  assert.equal(normalizeTag("a/b"), undefined);
  assert.equal(normalizeTag("x".repeat(25)), undefined);
});

test("isColor allows only the palette", () => {
  assert.ok(isColor("teal"));
  assert.ok(!isColor("#00ffff"));
  assert.ok(!isColor(undefined));
});

test("applyWorkspacePatch merges fields and caps tags", () => {
  const meta: MetaState["workspaces"] = { w1: { color: "red", tags: ["a"] } };
  applyWorkspacePatch(meta, { ids: ["w1", "w2"], collapsed: true, addTags: ["b"] });
  assert.deepEqual(meta, { w1: { color: "red", tags: ["a", "b"], collapsed: true }, w2: { collapsed: true, tags: ["b"] } });
  applyWorkspacePatch(meta, { ids: ["w2"], collapsed: false, removeTags: ["b"] });
  assert.deepEqual(Object.keys(meta), ["w1"]);
  applyWorkspacePatch(meta, { ids: ["w1"], addTags: Array.from({ length: 20 }, (_, i) => `t${i}`) });
  assert.equal(meta.w1.tags!.length, MAX_TAGS);
});
