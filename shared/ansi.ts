// Turns herdr's `--format ansi` screen into styled text runs. Only SGR (colors and text
// attributes) is applied; every other escape sequence and control character is dropped.

/** Inline CSS for one run, in React's style-object property names. */
export interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: number;
  fontStyle?: "italic";
  textDecoration?: "underline";
}

export interface AnsiRun {
  text: string;
  /** Unset for text in the terminal's default colors and attributes. */
  style?: AnsiStyle;
}

// The terminal surface defines these, so inverse video can swap in the default colors.
export const DEFAULT_FG = "var(--term-fg)";
export const DEFAULT_BG = "var(--term-bg)";

/** The 16 base colors, as a dark terminal theme draws them. */
export const BASE_COLORS = [
  "#3f3f46", "#f87171", "#4ade80", "#facc15", "#60a5fa", "#c084fc", "#22d3ee", "#d4d4d8",
  "#71717a", "#fca5a5", "#86efac", "#fde047", "#93c5fd", "#d8b4fe", "#67e8f9", "#fafafa",
];

const CUBE = [0, 95, 135, 175, 215, 255];

/** A color from the xterm 256-color palette: 16 base colors, a 6×6×6 cube, and 24 grays. */
export function xterm256(n: number): string {
  if (n < 16) return BASE_COLORS[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  return `rgb(${CUBE[Math.floor(i / 36)]},${CUBE[Math.floor(i / 6) % 6]},${CUBE[i % 6]})`;
}

interface Pen {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

const blankPen = (): Pen => ({ bold: false, dim: false, italic: false, underline: false, inverse: false });

function isByte(n: number) {
  return Number.isInteger(n) && n >= 0 && n <= 255;
}

/** An extended color from `5;n` or `2;r;g;b` (the parameters after 38 or 48). */
function extendedColor(args: number[]): string | undefined {
  if (args[0] === 5) return isByte(args[1]) ? xterm256(args[1]) : undefined;
  if (args[0] === 2) {
    const rgb = args.slice(1, 4);
    return rgb.length === 3 && rgb.every(isByte) ? `rgb(${rgb.join(",")})` : undefined;
  }
  return undefined;
}

/** Applies one SGR sequence's parameters, such as `1;38;5;208`, to the pen. */
function applySgr(pen: Pen, params: string) {
  const fields = params.split(";");
  for (let i = 0; i < fields.length; i++) {
    // Colon subparameters (`38:2::r:g:b`, `4:3`) keep a whole color in one field.
    if (fields[i].includes(":")) {
      const sub = fields[i].split(":").map(Number);
      if (sub[0] === 4) pen.underline = sub[1] !== 0;
      if (sub[0] !== 38 && sub[0] !== 48) continue;
      // The colon form of truecolor may carry a color-space ID before r, g, b.
      const args = sub[1] === 2 ? [2, ...sub.slice(-3)] : sub.slice(1);
      const color = extendedColor(args);
      if (sub[0] === 38 && color) pen.fg = color;
      if (sub[0] === 48 && color) pen.bg = color;
      continue;
    }
    const code = Number(fields[i] || 0);
    if (code === 0) Object.assign(pen, blankPen(), { fg: undefined, bg: undefined });
    else if (code === 1) pen.bold = true;
    else if (code === 2) pen.dim = true;
    else if (code === 3) pen.italic = true;
    else if (code === 4) pen.underline = true;
    else if (code === 7) pen.inverse = true;
    else if (code === 22) pen.bold = pen.dim = false;
    else if (code === 23) pen.italic = false;
    else if (code === 24) pen.underline = false;
    else if (code === 27) pen.inverse = false;
    else if (code >= 30 && code <= 37) pen.fg = BASE_COLORS[code - 30];
    else if (code >= 90 && code <= 97) pen.fg = BASE_COLORS[code - 82];
    else if (code >= 40 && code <= 47) pen.bg = BASE_COLORS[code - 40];
    else if (code >= 100 && code <= 107) pen.bg = BASE_COLORS[code - 92];
    else if (code === 39) pen.fg = undefined;
    else if (code === 49) pen.bg = undefined;
    else if (code === 38 || code === 48) {
      const mode = Number(fields[i + 1]);
      const take = mode === 5 ? 2 : mode === 2 ? 4 : 0;
      const color = extendedColor(fields.slice(i + 1, i + 1 + take).map(Number));
      if (code === 38 && color) pen.fg = color;
      if (code === 48 && color) pen.bg = color;
      i += take;
    }
  }
}

function styleOf(pen: Pen): AnsiStyle | undefined {
  let fg = pen.fg;
  let bg = pen.bg;
  if (pen.inverse) {
    fg = pen.bg ?? DEFAULT_BG;
    bg = pen.fg ?? DEFAULT_FG;
  }
  // Dim fades only the text, not the background behind it.
  if (pen.dim) fg = `color-mix(in srgb, ${fg ?? DEFAULT_FG} 60%, transparent)`;
  const style: AnsiStyle = {};
  if (fg) style.color = fg;
  if (bg) style.backgroundColor = bg;
  if (pen.bold) style.fontWeight = 700;
  if (pen.italic) style.fontStyle = "italic";
  if (pen.underline) style.textDecoration = "underline";
  return Object.keys(style).length ? style : undefined;
}

const styleKey = (style: AnsiStyle | undefined) => (style ? JSON.stringify(style) : "");

const ESC = 0x1b;
const BEL = 0x07;

interface Escape {
  /** Index just past the sequence. */
  end: number;
  /** The parameters of an SGR sequence (`ESC [ … m`). */
  sgr?: string;
}

/** Finds the end of the escape sequence that starts at `start`. */
function readEscape(input: string, start: number): Escape {
  const kind = input[start + 1];
  if (kind === "[") {
    let i = start + 2;
    while (i < input.length && input.charCodeAt(i) >= 0x30 && input.charCodeAt(i) <= 0x3f) i++;
    const params = input.slice(start + 2, i);
    const paramsEnd = i;
    while (i < input.length && input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x2f) i++;
    const final = input.charCodeAt(i);
    if (!(final >= 0x40 && final <= 0x7e)) return { end: i };
    // Private sequences such as `ESC [ > 4 ; 2 m` end in `m` too but aren't SGR.
    const isSgr = input[i] === "m" && paramsEnd === i && /^[0-9;:]*$/.test(params);
    return isSgr ? { end: i + 1, sgr: params } : { end: i + 1 };
  }
  if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
    // A string sequence (OSC, DCS, …) ends at BEL or ST. A missing terminator ends it at
    // the line's end, so one broken sequence can't hide the rest of the screen.
    let i = start + 2;
    while (i < input.length) {
      const c = input.charCodeAt(i);
      if (c === BEL) return { end: i + 1 };
      if (c === ESC && input[i + 1] === "\\") return { end: i + 2 };
      if (c === 0x0a) return { end: i };
      i++;
    }
    return { end: i };
  }
  // Any other escape: intermediate bytes, then one final byte.
  let i = start + 1;
  while (i < input.length && input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x2f) i++;
  const final = input.charCodeAt(i);
  return { end: final >= 0x30 && final <= 0x7e ? i + 1 : i };
}

/** Printable text, tab, and newline. Other C0 and C1 controls (including CR) are dropped. */
function isText(c: number) {
  return c === 0x09 || c === 0x0a || (c >= 0x20 && c < 0x7f) || c > 0x9f;
}

/** Splits ANSI text into runs of one style each; neighbouring runs always differ in style. */
export function parseAnsi(input: string): AnsiRun[] {
  const runs: AnsiRun[] = [];
  const pen = blankPen();
  let style: AnsiStyle | undefined;
  let key = "";
  let lastKey = "";
  const emit = (text: string) => {
    if (!text) return;
    const last = runs.at(-1);
    if (last && lastKey === key) last.text += text;
    else runs.push(style ? { text, style } : { text });
    lastKey = key;
  };
  let start = 0;
  let i = 0;
  while (i < input.length) {
    const c = input.charCodeAt(i);
    if (isText(c)) {
      i++;
      continue;
    }
    emit(input.slice(start, i));
    if (c === ESC) {
      const seq = readEscape(input, i);
      if (seq.sgr !== undefined) {
        applySgr(pen, seq.sgr);
        style = styleOf(pen);
        key = styleKey(style);
      }
      i = seq.end;
    } else {
      i++;
    }
    start = i;
  }
  emit(input.slice(start));
  return runs;
}

/** The runs' text without styles, as a plain-text read would return it. */
export function runsText(runs: AnsiRun[]): string {
  return runs.map((r) => r.text).join("");
}
