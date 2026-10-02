import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_COLORS, DEFAULT_BG, DEFAULT_FG, parseAnsi, runsText, xterm256 } from "../shared/ansi.ts";

const ESC = "\x1b";
const sgr = (params: string) => `${ESC}[${params}m`;

test("plain text is one unstyled run", () => {
  assert.deepEqual(parseAnsi("hello\nworld"), [{ text: "hello\nworld" }]);
  assert.deepEqual(parseAnsi(""), []);
});

test("bold, dim, italic, and underline turn on and off", () => {
  assert.deepEqual(parseAnsi(`${sgr("1")}b${sgr("22")}${sgr("3")}i${sgr("23")}${sgr("4")}u${sgr("24")}.`), [
    { text: "b", style: { fontWeight: 700 } },
    { text: "i", style: { fontStyle: "italic" } },
    { text: "u", style: { textDecoration: "underline" } },
    { text: "." },
  ]);
  assert.deepEqual(parseAnsi(`${sgr("2")}d${sgr("22")}.`), [
    { text: "d", style: { color: `color-mix(in srgb, ${DEFAULT_FG} 60%, transparent)` } },
    { text: "." },
  ]);
  assert.deepEqual(parseAnsi(`${sgr("1;2")}x${sgr("22")}y`), [
    { text: "x", style: { color: `color-mix(in srgb, ${DEFAULT_FG} 60%, transparent)`, fontWeight: 700 } },
    { text: "y" },
  ], "22 ends both bold and dim");
});

test("base foreground and background colors, normal and bright", () => {
  assert.deepEqual(parseAnsi(`${sgr("31")}r${sgr("97")}w${sgr("39")}d`), [
    { text: "r", style: { color: BASE_COLORS[1] } },
    { text: "w", style: { color: BASE_COLORS[15] } },
    { text: "d" },
  ]);
  assert.deepEqual(parseAnsi(`${sgr("42")}g${sgr("104")}b${sgr("49")}d`), [
    { text: "g", style: { backgroundColor: BASE_COLORS[2] } },
    { text: "b", style: { backgroundColor: BASE_COLORS[12] } },
    { text: "d" },
  ]);
  assert.deepEqual(parseAnsi(`${sgr("37;40")}x`), [{ text: "x", style: { color: BASE_COLORS[7], backgroundColor: BASE_COLORS[0] } }]);
});

test("256-color foreground and background", () => {
  assert.equal(xterm256(9), BASE_COLORS[9]);
  assert.equal(xterm256(16), "rgb(0,0,0)");
  assert.equal(xterm256(208), "rgb(255,135,0)");
  assert.equal(xterm256(231), "rgb(255,255,255)");
  assert.equal(xterm256(232), "rgb(8,8,8)");
  assert.equal(xterm256(255), "rgb(238,238,238)");
  assert.deepEqual(parseAnsi(`${sgr("38;5;208;48;5;236")}x`), [{ text: "x", style: { color: "rgb(255,135,0)", backgroundColor: "rgb(48,48,48)" } }]);
  assert.deepEqual(parseAnsi(`${sgr("38;5;300")}x`), [{ text: "x" }], "an index past 255 is ignored");
});

test("truecolor foreground and background, with semicolons or colons", () => {
  assert.deepEqual(parseAnsi(`${sgr("38;2;86;95;137")}a${sgr("48;2;1;2;3")}b`), [
    { text: "a", style: { color: "rgb(86,95,137)" } },
    { text: "b", style: { color: "rgb(86,95,137)", backgroundColor: "rgb(1,2,3)" } },
  ]);
  assert.deepEqual(parseAnsi(`${sgr("38:2::10:20:30")}a${sgr("48:5:1")}b`), [
    { text: "a", style: { color: "rgb(10,20,30)" } },
    { text: "b", style: { color: "rgb(10,20,30)", backgroundColor: BASE_COLORS[1] } },
  ]);
  assert.deepEqual(parseAnsi(`${sgr("38;2;1;2;3;1")}x`), [{ text: "x", style: { color: "rgb(1,2,3)", fontWeight: 700 } }], "codes after a color still apply");
});

test("inverse swaps the colors, using the defaults where none is set", () => {
  assert.deepEqual(parseAnsi(`${sgr("7")}x`), [{ text: "x", style: { color: DEFAULT_BG, backgroundColor: DEFAULT_FG } }]);
  assert.deepEqual(parseAnsi(`${sgr("31;7")}x`), [{ text: "x", style: { color: DEFAULT_BG, backgroundColor: BASE_COLORS[1] } }]);
  assert.deepEqual(parseAnsi(`${sgr("7;44")}x${sgr("27")}y`), [
    { text: "x", style: { color: BASE_COLORS[4], backgroundColor: DEFAULT_FG } },
    { text: "y", style: { backgroundColor: BASE_COLORS[4] } },
  ]);
});

test("reset clears everything, written as 0 or with no parameters", () => {
  assert.deepEqual(parseAnsi(`${sgr("1;3;4;7;31;42")}x${sgr("0")}y${sgr("1")}z${ESC}[mw`), [
    { text: "x", style: { color: BASE_COLORS[2], backgroundColor: BASE_COLORS[1], fontWeight: 700, fontStyle: "italic", textDecoration: "underline" } },
    { text: "y" },
    { text: "z", style: { fontWeight: 700 } },
    { text: "w" },
  ]);
});

test("other escape sequences and control characters are dropped", () => {
  const input = [
    `${ESC}[?25l${ESC}[2J${ESC}[1;1H`, // cursor and erase CSI
    `${ESC}]0;title${"\x07"}`, // OSC ended by BEL
    `${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`, // OSC 8 ended by ST
    `${ESC}(B${ESC}=${ESC}7`, // charset and other two-byte escapes
    `${ESC}[>4;2mA`, // a private sequence that also ends in m
    "\r\b\x00B\tC\n",
    `${ESC}]unterminated\nD`,
    `${ESC}[5;8;9mE`, // SGR codes we don't draw
    `F${ESC}`,
  ].join("");
  const runs = parseAnsi(input);
  assert.deepEqual(runs, [{ text: "linkAB\tC\n\nDEF" }]);
  assert.ok(![...runsText(runs)].some((c) => c < " " && c !== "\n" && c !== "\t"), "only tab and newline controls are left");
});

test("neighbouring runs with the same style merge, across lines and redundant codes", () => {
  const runs = parseAnsi(`${sgr("0")}${sgr("31")}a${sgr("0")}${sgr("31")}b\r\n${sgr("31")}c${sgr("39")}${sgr("0")} d`);
  assert.deepEqual(runs, [{ text: "ab\nc", style: { color: BASE_COLORS[1] } }, { text: " d" }]);
  assert.deepEqual(parseAnsi(`${sgr("31")}${sgr("39")}x${sgr("4")}${sgr("24")}y`), [{ text: "xy" }]);
});

test("text is kept as is for React to escape, and runsText returns the plain screen", () => {
  const runs = parseAnsi(`${sgr("32")}<b>&amp;</b>${sgr("0")} a < b && c > d`);
  assert.deepEqual(runs, [{ text: "<b>&amp;</b>", style: { color: BASE_COLORS[2] } }, { text: " a < b && c > d" }]);
  assert.equal(runsText(runs), "<b>&amp;</b> a < b && c > d");
});
