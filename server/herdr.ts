import { execFile } from "node:child_process";
import { errorMessage } from "../shared/errors.ts";
import type { Snapshot, SnapPane } from "../shared/model.ts";
import { AGENT_NAME } from "../shared/names.ts";

export interface HerdrOptions {
  /** SSH destination that runs the herdr server. Unset runs herdr locally. */
  ssh?: string;
  bin: string;
}

// Pane, tab, and workspace IDs look like `w3:p2W`. Anything else is rejected
// before it reaches a remote shell.
const ID = /^[A-Za-z0-9:_-]{1,64}$/;

export function assertId(id: string): string {
  if (!ID.test(id)) throw new Error(`invalid herdr id: ${id}`);
  return id;
}

export function commandFor(opts: HerdrOptions, args: string[]): [string, string[]] {
  if (!opts.ssh) return [opts.bin, args];
  // ssh joins arguments into one remote shell command, so quote each one.
  const quoted = [opts.bin, ...args].map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
  return ["ssh", ["-o", "BatchMode=yes", opts.ssh, quoted]];
}

/** Runs `opts.bin` with `args`, over SSH when `opts.ssh` is set. */
export function runCli(opts: HerdrOptions, args: string[], timeoutMs = 10_000): Promise<string> {
  const [cmd, argv] = commandFor(opts, args);
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")}: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

export async function snapshot(opts: HerdrOptions): Promise<Snapshot> {
  const out: { error?: { message: string }; result: { snapshot: Snapshot } } = JSON.parse(await runCli(opts, ["api", "snapshot"]));
  if (out.error) throw new Error(`herdr api snapshot: ${out.error.message}`);
  return out.result.snapshot;
}

export type FocusTarget = { kind: "agent" | "tab" | "workspace"; id: string };

export async function focus(opts: HerdrOptions, target: FocusTarget): Promise<void> {
  const id = assertId(target.id);
  if (target.kind === "agent") await runCli(opts, ["agent", "focus", id]);
  else if (target.kind === "tab") await runCli(opts, ["tab", "focus", id]);
  else await runCli(opts, ["workspace", "focus", id]);
}

export type ReadSource = "visible" | "recent";
/** `ansi` keeps the screen's colors and attributes as SGR escape sequences. */
export type ReadFormat = "text" | "ansi";

/**
 * The source for a repeated preview read. For an agent with no herdr scrollback (a fullscreen
 * TUI on the alternate screen), a `recent` read longer than the screen makes herdr scroll the
 * agent up through its history and back down, which the user sees in their terminal. Such panes
 * get `visible`, which herdr never scrolls.
 */
export function previewSource(pane: SnapPane | undefined, source: ReadSource): ReadSource {
  if (source !== "recent" || !pane?.agent) return source;
  return (pane.scroll?.max_offset_from_bottom ?? 0) > 0 ? "recent" : "visible";
}

/** Reads the visible screen, or `recent` scrollback for a scrollable preview. */
export function readPane(opts: HerdrOptions, paneId: string, source: ReadSource, lines: number, format: ReadFormat = "text"): Promise<string> {
  const n = Math.min(5000, Math.max(1, Math.floor(lines) || 60));
  const args = ["pane", "read", assertId(paneId), "--source", source, "--lines", String(n)];
  return runCli(opts, format === "ansi" ? [...args, "--format", "ansi"] : args);
}

const MAX_TEXT = 20_000;

// Request values are checked here, right before they reach herdr's command line.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */
export function assertText(text: unknown): string {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT) {
    throw new Error(`text must be 1-${MAX_TEXT} characters`);
  }
  return text;
}

// herdr key-combo names this UI sends: single printable characters, named keys,
// and a few chords. herdr validates keys too; this keeps shell metacharacters out.
const KEY = /^([a-z0-9]|enter|esc|escape|tab|backspace|space|up|down|left|right|shift\+tab|ctrl\+[a-z])$/i;

export function assertKeys(keys: unknown): string[] {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 16 || !keys.every((k) => typeof k === "string" && KEY.test(k))) {
    throw new Error("keys must be 1-16 herdr key names");
  }
  return keys;
}

/** Submits a prompt with Enter. herdr refuses this for a blocked agent; send keys instead. */
export async function promptAgent(opts: HerdrOptions, paneId: string, text: unknown): Promise<void> {
  await runCli(opts, ["agent", "prompt", assertId(paneId), assertText(text)]);
}

/** Sends key presses, for answering an agent's approval or question dialog. */
export async function sendKeys(opts: HerdrOptions, paneId: string, keys: unknown): Promise<void> {
  await runCli(opts, ["agent", "send-keys", assertId(paneId), ...assertKeys(keys)]);
}

/** Types text into a pane without pressing Enter, for free-text answers inside a dialog. */
export async function sendText(opts: HerdrOptions, paneId: string, text: unknown): Promise<void> {
  await runCli(opts, ["pane", "send-text", assertId(paneId), assertText(text)]);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/** herdr's own message from a failed command. herdr reports errors as JSON on stderr. */
export function herdrMessage(cause: unknown): string {
  const message = errorMessage(cause);
  const i = message.indexOf("{");
  if (i < 0) return message;
  try {
    return JSON.parse(message.slice(i)).error?.message ?? message;
  } catch {
    return message;
  }
}

/** Renames an agent. herdr checks the name too and refuses one another agent has. */
export async function renameAgent(opts: HerdrOptions, paneId: string, name: string): Promise<void> {
  if (!AGENT_NAME.test(name)) throw new Error(`invalid agent name: ${name}`);
  try {
    await runCli(opts, ["agent", "rename", assertId(paneId), name]);
  } catch (err) {
    throw new Error(herdrMessage(err));
  }
}

// Plugin and action IDs look like `furkankly.zoetrope` and `open-tab`.
const PLUGIN_NAME = /^[A-Za-z0-9._-]{1,64}$/;

function assertPluginName(name: string): string {
  if (!PLUGIN_NAME.test(name)) throw new Error(`invalid plugin or action id: ${name}`);
  return name;
}

/** Whether a herdr plugin is installed and enabled. */
export async function pluginEnabled(opts: HerdrOptions, pluginId: string): Promise<boolean> {
  const out = JSON.parse(await runCli(opts, ["plugin", "list", "--json", "--plugin", assertPluginName(pluginId)]));
  const plugins: { plugin_id?: string; enabled?: boolean }[] = out.result?.plugins ?? [];
  return plugins.some((p) => p.plugin_id === pluginId && p.enabled);
}

/** Runs a plugin action. Actions act on the pane herdr has focused. */
export async function invokePluginAction(opts: HerdrOptions, pluginId: string, actionId: string): Promise<void> {
  await runCli(opts, ["plugin", "action", "invoke", assertPluginName(actionId), "--plugin", assertPluginName(pluginId)]);
}

const APP_NAME = /^[\w .-]{1,64}$/;

/** Brings the terminal app that shows herdr to the front (macOS only). */
export function activateApp(app: string): Promise<void> {
  if (process.platform !== "darwin" || !APP_NAME.test(app)) return Promise.resolve();
  return new Promise((resolve) => {
    execFile("osascript", ["-e", `tell application "${app}" to activate`], () => resolve());
  });
}
