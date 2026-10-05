// Finds URLs and `path:line` references in a screen's text, and splits styled runs at their edges
// so each one can be drawn as a link without losing its colors.
import type { AnsiRun } from "./ansi.ts";

export interface ScreenLink {
  kind: "url" | "path";
  /** Offsets into the text, end exclusive. */
  start: number;
  end: number;
  /** The URL to open, or `path:line` to copy. */
  target: string;
}

// Characters a URL in terminal output doesn't contain; quotes and brackets usually wrap it.
const URL = /\bhttps?:\/\/[^\s<>"'`]+/g;
const URL_TRAILING = /[.,;:!?'"*_]+$/;

// Without a directory, only these extensions count, so `example.com:443` isn't a file.
const SOURCE_EXT = new Set(
  (
    "ts tsx mts cts js jsx mjs cjs json jsonl md mdx py pyi rb go rs java kt kts swift c h cc cpp hpp m mm cs php sh bash zsh fish " +
    "yml yaml toml ini cfg conf sql css scss sass less html htm vue svelte astro lua ex exs erl hs ml scala clj dart r jl nix zig " +
    "tf hcl proto graphql gql txt lock xml gradle env"
  ).split(" "),
);

// A path ending in a file name with an extension that starts with a letter, then `:line` and an
// optional `:col`. It starts the text, or follows whitespace or an opening bracket or quote.
const PATH_LINE = /(?<=^|[\s([{"'`])((?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.([A-Za-z][A-Za-z0-9]{0,9})):(\d{1,6})(?::\d{1,4})?(?![\w:/]|\.\w)/g;

/** Balanced parentheses stay with a URL; a closing one it didn't open, and trailing punctuation, don't. */
function trimUrl(url: string): string {
  let u = url.replace(URL_TRAILING, "");
  while (u.endsWith(")") && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1).replace(URL_TRAILING, "");
  return u;
}

/** URLs and file references in `text`, in order, without overlaps. */
export function findLinks(text: string): ScreenLink[] {
  const links: ScreenLink[] = [];
  for (const m of text.matchAll(URL)) {
    const target = trimUrl(m[0]);
    if (target.length > "https://".length) links.push({ kind: "url", start: m.index, end: m.index + target.length, target });
  }
  const inUrl = (i: number) => links.some((l) => l.kind === "url" && i >= l.start && i < l.end);
  const paths: ScreenLink[] = [];
  for (const m of text.matchAll(PATH_LINE)) {
    const [whole, path, ext, line] = m;
    if (inUrl(m.index)) continue;
    if (!path.includes("/") && !SOURCE_EXT.has(ext.toLowerCase())) continue;
    paths.push({ kind: "path", start: m.index, end: m.index + whole.length, target: `${path}:${line}` });
  }
  return [...links, ...paths].sort((a, b) => a.start - b.start);
}

/** A stretch of the screen: runs inside one link, or runs between links. */
export interface LinkedPiece {
  link?: ScreenLink;
  runs: AnsiRun[];
}

/** The runs split at each link's edges, grouped into link and plain pieces. Text and styles are unchanged. */
export function linkRuns(runs: AnsiRun[], links: ScreenLink[] = findLinks(runs.map((r) => r.text).join(""))): LinkedPiece[] {
  const pieces: LinkedPiece[] = [];
  const add = (link: ScreenLink | undefined, run: AnsiRun) => {
    const last = pieces.at(-1);
    if (last && last.link === link) last.runs.push(run);
    else pieces.push({ ...(link && { link }), runs: [run] });
  };
  let li = 0;
  let pos = 0;
  for (const run of runs) {
    const end = pos + run.text.length;
    let at = pos;
    while (at < end) {
      while (li < links.length && links[li].end <= at) li++;
      const link = links[li];
      const inside = !!link && link.start <= at;
      const stop = Math.min(end, inside ? link.end : (link?.start ?? end));
      const text = run.text.slice(at - pos, stop - pos);
      add(inside ? link : undefined, run.style ? { text, style: run.style } : { text });
      at = stop;
    }
    pos = end;
  }
  return pieces;
}
