// Reads an agent's screen for signs that it stopped making progress.
import type { StuckReason } from "./model.ts";

/** Banners are looked for only near the bottom, where agents print their current state. */
export const BANNER_LINES = 15;

const BANNERS: [Exclude<StuckReason, "no-output">, RegExp[]][] = [
  [
    "rate-limit",
    [
      /\brate[ -]?limit(s)? (reached|exceeded|hit)\b/i,
      /\brate[ -]?limited\b/i,
      /\brate_limit_error\b/i,
      /\busage limit\b/i,
      /\blimit reached\b/i,
      /\btoo many requests\b/i,
      /\b(error|status|http)\W{0,3}429\b/i,
    ],
  ],
  ["error", [/\bapi error\b/i, /\bstream error\b/i, /\boverloaded_error\b/i, /\b(is|are|currently) overloaded\b/i]],
];

/** The last `BANNER_LINES` non-blank lines of a screen. */
function bottomLines(screen: string): string[] {
  return screen
    .split("\n")
    .filter((l) => l.trim())
    .slice(-BANNER_LINES);
}

/** A rate-limit or error banner near the bottom of the screen, if there is one. */
export function detectBanner(screen: string): "rate-limit" | "error" | undefined {
  const lines = bottomLines(screen);
  for (const [reason, patterns] of BANNERS) {
    if (lines.some((l) => patterns.some((p) => p.test(l)))) return reason;
  }
  return undefined;
}

// Claude Code and Codex redraw a spinner line with an elapsed-time counter while
// working, so it changes every second even when nothing else does.
const SPINNER_LINE = /\b(esc|ctrl\+c) to (interrupt|cancel)\b/i;

/** The screen with spinner lines dropped and numbers blanked, for telling real output from a ticking timer. */
export function screenFingerprint(screen: string): string {
  return screen
    .split("\n")
    .filter((l) => !SPINNER_LINE.test(l))
    .map((l) => l.replace(/\d+/g, "#").trimEnd())
    .join("\n")
    .trim();
}
