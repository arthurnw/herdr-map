// The text herdr-map sends to agents for handoffs, context links, and note links.
import { REPLY_CHARS } from "../probe/reply.ts";
import type { PaneInfo } from "./agents.ts";

/** Scrollback lines read from an agent that finished a turn when its transcript has no reply. */
export const HANDOFF_LINES = 120;
/** The most of that output a handoff passes on; the end of the output is kept. */
export const HANDOFF_CHARS = 6_000;

/** What a handoff passes on: the final reply from the transcript, the terminal's output, or why neither could be read. */
export type HandoffOutput = { reply: string; trimmed?: boolean } | { screen: string } | { error: string };

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

export function handoffPrompt(from: PaneInfo | undefined, fromId: string, output: HandoffOutput): string {
  const who = describe(from, fromId);
  let body: string;
  if ("reply" in output) {
    const note = output.trimmed ? ` (trimmed to its last ${REPLY_CHARS.toLocaleString("en-US")} characters)` : "";
    body = `Its final reply${note}:\n\n${output.reply}`;
  } else if ("screen" in output) {
    body = `Its latest output (from its terminal, no transcript found):\n\n${trimOutput(output.screen) || "(empty)"}`;
  } else {
    body = `herdr-map couldn't read its output (${output.error}). Read it with: herdr agent read ${fromId} --lines 200`;
  }
  return `Handoff from ${who}, which just finished a turn. ${body}`;
}

export function contextPrompt(from: PaneInfo | undefined, fromId: string): string {
  return (
    `For context, you can read the work of ${describe(from, fromId)} at any time. ` +
    `Run \`herdr agent read ${fromId} --lines 200\` when it would help. No need to reply to this message.`
  );
}

export function notePrompt(text: string): string {
  return `A note from the user:\n\n${text}`;
}
