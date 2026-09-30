// The text herdr-map sends to agents for handoffs.
import type { PaneInfo } from "./agents.ts";

/** Scrollback lines read from an agent that finished a turn. */
export const HANDOFF_LINES = 120;
/** The most of that output a handoff passes on; the end of the output is kept. */
export const HANDOFF_CHARS = 6_000;

function describe(info: PaneInfo | undefined, paneId: string): string {
  if (!info) return `the agent in pane ${paneId}`;
  const kind = info.kind ?? "agent";
  const name = info.name ? `"${info.name}" (${kind})` : kind;
  return `${name} in workspace "${info.workspace}", pane ${paneId}`;
}

/** Drops trailing blank lines and keeps the last `HANDOFF_CHARS` characters, cut at a line start. */
export function trimOutput(output: string): string {
  const text = output.replace(/\s+$/, "");
  if (text.length <= HANDOFF_CHARS) return text;
  const tail = text.slice(-HANDOFF_CHARS);
  const nl = tail.indexOf("\n");
  return nl >= 0 ? tail.slice(nl + 1) : tail;
}

export function handoffPrompt(from: PaneInfo | undefined, fromId: string, output: string | { error: string }): string {
  const who = describe(from, fromId);
  const body =
    typeof output === "string"
      ? `Its latest output:\n\n${trimOutput(output) || "(empty)"}`
      : `herdr-map couldn't read its output (${output.error}). Read it with: herdr agent read ${fromId} --lines 200`;
  return `Handoff from ${who}, which just finished a turn. ${body}`;
}
