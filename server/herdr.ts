import { execFile } from "node:child_process";
import type { Snapshot } from "../shared/model.ts";

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

function run(opts: HerdrOptions, args: string[], timeoutMs = 10_000): Promise<string> {
  const [cmd, argv] = commandFor(opts, args);
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")}: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

export async function snapshot(opts: HerdrOptions): Promise<Snapshot> {
  const out = JSON.parse(await run(opts, ["api", "snapshot"]));
  if (out.error) throw new Error(`herdr api snapshot: ${out.error.message}`);
  return out.result.snapshot as Snapshot;
}

export type FocusTarget = { kind: "agent" | "tab" | "workspace"; id: string };

export async function focus(opts: HerdrOptions, target: FocusTarget): Promise<void> {
  const id = assertId(target.id);
  if (target.kind === "agent") await run(opts, ["agent", "focus", id]);
  else if (target.kind === "tab") await run(opts, ["tab", "focus", id]);
  else await run(opts, ["workspace", "focus", id]);
}

export function readPane(opts: HerdrOptions, paneId: string, lines: number): Promise<string> {
  return run(opts, ["pane", "read", assertId(paneId), "--source", "visible", "--lines", String(lines)]);
}

const APP_NAME = /^[\w .-]{1,64}$/;

/** Brings the terminal app that shows herdr to the front (macOS only). */
export function activateApp(app: string): Promise<void> {
  if (process.platform !== "darwin" || !APP_NAME.test(app)) return Promise.resolve();
  return new Promise((resolve) => {
    execFile("osascript", ["-e", `tell application "${app}" to activate`], () => resolve());
  });
}
