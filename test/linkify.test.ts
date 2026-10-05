import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnsi, runsText } from "../shared/ansi.ts";
import { findLinks, linkRuns } from "../shared/linkify.ts";

const targets = (text: string) => findLinks(text).map((l) => [l.kind, l.target, text.slice(l.start, l.end)]);

test("URLs are found without the punctuation and brackets around them", () => {
  assert.deepEqual(targets("see https://example.com/docs?q=1&x=2."), [["url", "https://example.com/docs?q=1&x=2", "https://example.com/docs?q=1&x=2"]]);
  assert.deepEqual(targets("(http://localhost:4747/api)"), [["url", "http://localhost:4747/api", "http://localhost:4747/api"]]);
  assert.deepEqual(targets("<https://en.wikipedia.org/wiki/Foo_(bar)>,"), [
    ["url", "https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)"],
  ]);
  assert.deepEqual(targets('"https://a.dev/x"'), [["url", "https://a.dev/x", "https://a.dev/x"]]);
  assert.deepEqual(targets("https:// and ftp://example.com"), []);
});

test("path:line and path:line:col references are found; the copy target drops the column", () => {
  assert.deepEqual(targets("error in file.ts:12"), [["path", "file.ts:12", "file.ts:12"]]);
  assert.deepEqual(targets("  at refresh (src/token-cache.ts:12:5)"), [["path", "src/token-cache.ts:12", "src/token-cache.ts:12:5"]]);
  assert.deepEqual(targets("/Users/me/repo/web/App.tsx:301, ./a/b.py:3 and ../c.rs:9."), [
    ["path", "/Users/me/repo/web/App.tsx:301", "/Users/me/repo/web/App.tsx:301"],
    ["path", "./a/b.py:3", "./a/b.py:3"],
    ["path", "../c.rs:9", "../c.rs:9"],
  ]);
  assert.deepEqual(targets("README.md:5"), [["path", "README.md:5", "README.md:5"]]);
});

test("times, ratios, versions, hosts, and ports aren't file references", () => {
  for (const text of [
    "at 12:30",
    "12:30:45",
    "ratio 1:2",
    "v1.2.3:4",
    "node 22.1.0:1",
    "example.com:443",
    "localhost:3000",
    "10.0.0.1:8080",
    "file.ts:12:30:45",
    "file.ts:12.5",
    "file.ts:",
    "key:value",
    "a.ts12",
  ]) {
    assert.deepEqual(targets(text), [], text);
  }
});

test("a path inside a URL is part of the URL, not a reference of its own", () => {
  assert.deepEqual(targets("https://github.com/o/r/blob/main/src/a.ts:12"), [
    ["url", "https://github.com/o/r/blob/main/src/a.ts:12", "https://github.com/o/r/blob/main/src/a.ts:12"],
  ]);
});

test("runs split at link edges keep their styles and text", () => {
  const ESC = "\x1b";
  const runs = parseAnsi(`${ESC}[36mdocs: https://example.com/${ESC}[1mtoken${ESC}[22m?v=2${ESC}[39m done src/a.ts:3`);
  const pieces = linkRuns(runs);
  assert.equal(pieces.flatMap((p) => p.runs).map((r) => r.text).join(""), runsText(runs), "no text is lost or added");
  const [before, url, between, path] = pieces;
  assert.equal(before.link, undefined);
  assert.deepEqual(before.runs, [{ text: "docs: ", style: { color: runs[0].style!.color } }]);
  assert.equal(url.link?.target, "https://example.com/token?v=2");
  assert.deepEqual(
    url.runs.map((r) => [r.text, r.style]),
    [
      ["https://example.com/", runs[0].style],
      ["token", runs[1].style],
      ["?v=2", runs[2].style],
    ],
  );
  assert.deepEqual(between, { runs: [{ text: " done " }] });
  assert.equal(path.link?.target, "src/a.ts:3");
  assert.deepEqual(path.runs, [{ text: "src/a.ts:3" }]);
  assert.equal(pieces.length, 4);
});

test("a screen without links is one plain piece with its runs", () => {
  const runs = parseAnsi("\x1b[31mred\x1b[0m plain");
  assert.deepEqual(linkRuns(runs), [{ runs }]);
  assert.deepEqual(linkRuns([]), []);
});
