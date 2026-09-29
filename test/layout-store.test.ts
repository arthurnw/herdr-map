import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LayoutStore } from "../shared/layout-types.ts";
import {
  emptyStore,
  isLayoutName,
  isSavedLayout,
  loadStore,
  pushHistory,
  sameLayout,
  setCurrent,
  stepHistory,
  updateStore,
} from "../server/layout-store.ts";

async function tempPath() {
  return join(await mkdtemp(join(tmpdir(), "herdr-map-")), "nested", "layout.json");
}

async function fileWith(contents: unknown) {
  const path = join(await mkdtemp(join(tmpdir(), "herdr-map-")), "layout.json");
  await writeFile(path, JSON.stringify(contents));
  return path;
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
  assert.deepEqual(await loadStore(await tempPath()), emptyStore());
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
    ...emptyStore(),
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

test("migrates a flat v1 file to the current layout of a v2 store", async () => {
  const path = await fileWith({ w1: { x: 3, y: 4 } });
  assert.deepEqual(await loadStore(path), { ...emptyStore(), current: { w1: { x: 3, y: 4 } } });
});

test("migrates a v1 current-and-named file and writes it back as v2", async () => {
  const v1 = { current: { w1: { x: 1, y: 2, detached: true } }, named: { work: { savedAt: 7, layout: {} } } };
  const path = await fileWith(v1);
  assert.deepEqual(await loadStore(path), { ...emptyStore(), ...v1 });
  await updateStore(path, () => {});
  const written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(written.version, 2);
  assert.deepEqual(written.current, v1.current);
  assert.deepEqual(written.notes, []);
});

const note = { id: "n1", text: "check CI", x: 10, y: 20, w: 200, h: 120, color: "yellow", createdAt: 1, updatedAt: 2 };
const link = {
  id: "l1",
  from: { kind: "pane", id: "w1:p1" },
  to: { kind: "note", id: "n1" },
  kind: "handoff",
  createdAt: 3,
} as const;

test("keeps v2 notes, links, meta, and history across an update that only changes current", async () => {
  const v2: LayoutStore = {
    version: 2,
    current: { w1: { x: 1, y: 1 } },
    named: { work: { savedAt: 5, layout: { w1: { x: 9, y: 9 } } } },
    workspaces: { w1: { tags: ["infra", "urgent"], color: "#f97316", collapsed: true } },
    groups: { "github.com/acme/api": { color: "teal" } },
    notes: [note],
    links: [link],
    history: [{ w1: { x: 0, y: 0 } }],
  };
  const path = await fileWith(v2);
  await updateStore(path, (s) => {
    s.current = { w1: { x: 5, y: 6 } };
  });
  assert.deepEqual(await loadStore(path), { ...v2, current: { w1: { x: 5, y: 6 } } });
});

test("drops invalid entries without discarding the rest of the file", async () => {
  const path = await fileWith({
    version: 2,
    current: { w1: { x: 1, y: 2 }, w2: { x: "bad", y: 0 } },
    named: { ok: { savedAt: 1, layout: {} }, broken: { layout: {} } },
    workspaces: { w1: { tags: ["a", 3, "a", ""], color: 5, collapsed: "yes" }, w2: "nope" },
    groups: { g1: { color: "red" }, constructor: { color: "blue" } },
    notes: [note, { ...note, id: "n2", text: undefined }, { ...note, id: "n3", x: null }, { ...note, w: -1 }, "junk"],
    links: [
      link,
      { ...link, id: "l2", from: { kind: "tab", id: "t1" } },
      { ...link, id: "l3", to: { kind: "note" } },
      { ...link, id: "l4", kind: "blocks" },
    ],
    history: [{ w1: { x: 0, y: 0 } }, null, "junk"],
  });
  const store = await loadStore(path);
  assert.deepEqual(store.current, { w1: { x: 1, y: 2 } });
  assert.deepEqual(Object.keys(store.named), ["ok"]);
  assert.deepEqual(store.workspaces, { w1: { tags: ["a"] } });
  assert.deepEqual(store.groups, { g1: { color: "red" } });
  // The repeated n1 with a bad width is a duplicate id, so the first n1 wins.
  assert.deepEqual(store.notes, [note]);
  assert.deepEqual(store.links, [link]);
  assert.deepEqual(store.history, [{ w1: { x: 0, y: 0 } }]);
});

test("ignores reserved keys in records keyed by user input", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "herdr-map-")), "layout.json");
  const entry = '{"savedAt":1,"layout":{"__proto__":{"x":1,"y":1}}}';
  await writeFile(
    path,
    `{"version":2,"current":{"__proto__":{"x":1,"y":1}},"named":{"__proto__":${entry}},` +
      `"workspaces":{"__proto__":{"collapsed":true}},"groups":{"prototype":{"color":"red"}}}`,
  );
  const store = await loadStore(path);
  assert.deepEqual(store, emptyStore());
  for (const record of [store.current, store.named, store.workspaces, store.groups]) {
    assert.equal(Object.getPrototypeOf(record), Object.prototype);
  }
});

test("drops a bad optional note field but keeps the note", async () => {
  const path = await fileWith({ version: 2, current: {}, notes: [{ ...note, w: -1, color: 4 }] });
  const { w: _w, color: _color, ...rest } = note;
  assert.deepEqual((await loadStore(path)).notes, [rest]);
});

test("refuses to overwrite a file from a newer version but still reads it", async () => {
  const future = { version: 3, current: { w1: { x: 1, y: 2 } }, notes: [note], somethingNew: true };
  const path = await fileWith(future);
  assert.deepEqual((await loadStore(path)).current, future.current);
  await assert.rejects(
    updateStore(path, (s) => {
      s.current = {};
    }),
    /layout version 3/,
  );
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), future);
  // A refused update doesn't block later ones on other files.
  const other = await tempPath();
  await updateStore(other, (s) => {
    s.current = { w1: { x: 0, y: 0 } };
  });
  assert.deepEqual((await loadStore(other)).current, { w1: { x: 0, y: 0 } });
});

test("history keeps only the newest entries", () => {
  const store = emptyStore();
  for (let i = 0; i < 5; i++) pushHistory(store, { w1: { x: i, y: 0 } }, 3);
  assert.deepEqual(
    store.history.map((l) => l.w1.x),
    [2, 3, 4],
  );
  for (let i = 0; i < 60; i++) pushHistory(store, {});
  assert.equal(store.history.length, 50);
});

test("backs up an unreadable file before replacing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-map-"));
  const path = join(dir, "layout.json");
  await writeFile(path, '{"version": 2, "current": {');
  await updateStore(path, (s) => {
    s.current = { w1: { x: 1, y: 1 } };
  });
  const backups = (await readdir(dir)).filter((f) => f.startsWith("layout.json.corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(dir, backups[0]), "utf8"), '{"version": 2, "current": {');
  assert.deepEqual((await loadStore(path)).current, { w1: { x: 1, y: 1 } });
});

test("sameLayout ignores key order and treats a missing detached flag as false", () => {
  assert.ok(sameLayout({ a: { x: 1, y: 2 }, b: { x: 0, y: 0, detached: false } }, { b: { x: 0, y: 0 }, a: { x: 1, y: 2 } }));
  assert.ok(!sameLayout({ a: { x: 1, y: 2 } }, { a: { x: 1, y: 2, detached: true } }));
  assert.ok(!sameLayout({ a: { x: 1, y: 2 } }, { b: { x: 1, y: 2 } }));
  assert.ok(!sameLayout({}, { a: { x: 1, y: 2 } }));
});

test("setCurrent and stepHistory keep undo and redo lists", () => {
  const store = emptyStore();
  assert.equal(setCurrent(store, {}), false);
  assert.equal(setCurrent(store, { a: { x: 1, y: 1 } }), true);
  setCurrent(store, { a: { x: 2, y: 2 } });
  assert.deepEqual(stepHistory(store, "undo"), { a: { x: 1, y: 1 } });
  assert.deepEqual(store.future, [{ a: { x: 2, y: 2 } }]);
  assert.deepEqual(stepHistory(store, "redo"), { a: { x: 2, y: 2 } });
  assert.equal(store.future, undefined);
  assert.equal(stepHistory(store, "redo"), undefined);
  assert.deepEqual(store.current, { a: { x: 2, y: 2 } });
});

test("reads and keeps the redo list", async () => {
  const path = await fileWith({ version: 2, current: {}, history: [], future: [{ w1: { x: 1, y: 1 } }, "junk"] });
  assert.deepEqual((await loadStore(path)).future, [{ w1: { x: 1, y: 1 } }]);
});
