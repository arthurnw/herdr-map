// The deliver-when-idle queue, scheduled prompts, and what the UI reads about them.
// Shared by the server (which runs and persists them) and the web UI.
import type { Link } from "./layout-types.ts";

/** What put a prompt in the queue. */
export type QueueSourceKind = "handoff" | "context" | "note" | "schedule" | "manual";

export interface QueueSource {
  kind: QueueSourceKind;
  linkId?: string;
  scheduleId?: string;
  /** Shown in the queue, for example "Handoff from lead (api)". Kept so it reads the same after the link is gone. */
  label: string;
}

/** `gone`: the target pane no longer exists, so the item will never be sent. */
export type QueueItemState = "pending" | "failed" | "gone";

export interface QueueItem {
  id: string;
  /** herdr pane id of the agent to prompt. */
  target: string;
  /** The target's name and workspace when queued. */
  targetLabel: string;
  text: string;
  source: QueueSource;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Not sent before this time; set after a failed attempt. */
  notBefore?: number;
  attempts: number;
  lastError?: string;
  state: QueueItemState;
  /** Set by Send now: goes ahead of older items for its target and ignores the pause. */
  sendNow?: boolean;
  /** When the target was found missing. */
  goneAt?: number;
}

export interface DeliveredItem {
  id: string;
  target: string;
  targetLabel: string;
  text: string;
  source: QueueSource;
  createdAt: number;
  deliveredAt: number;
}

export type ScheduleTiming = { kind: "interval"; minutes: number } | { kind: "daily"; time: string };

export interface Schedule {
  id: string;
  target: string;
  targetLabel: string;
  text: string;
  timing: ScheduleTiming;
  /** Only armed schedules run. Any change to target, text, or timing disarms it. */
  armed: boolean;
  createdAt: number;
  updatedAt: number;
  /** Set while armed. */
  nextRunAt?: number;
  lastRunAt?: number;
  /** What the last due run did, for example "Queued" or "Skipped: paused". */
  lastResult?: string;
}

/** `GET /api/automation`. */
export interface AutomationState {
  paused: boolean;
  items: QueueItem[];
  /** Delivered items, newest last. */
  history: DeliveredItem[];
  schedules: Schedule[];
  links: Link[];
}

export const PROMPT_TEXT_MAX = 10_000;
export const MAX_QUEUE_ITEMS = 500;
export const MAX_SCHEDULES = 100;
export const MAX_LINKS = 500;
export const HISTORY_KEEP = 50;
export const INTERVAL_MIN_MINUTES = 1;
export const INTERVAL_MAX_MINUTES = 7 * 24 * 60;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isTiming(value: unknown): value is ScheduleTiming {
  if (value === null || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  if (t.kind === "interval") {
    return Number.isInteger(t.minutes) && (t.minutes as number) >= INTERVAL_MIN_MINUTES && (t.minutes as number) <= INTERVAL_MAX_MINUTES;
  }
  return t.kind === "daily" && typeof t.time === "string" && HHMM.test(t.time);
}

export function sameTiming(a: ScheduleTiming, b: ScheduleTiming): boolean {
  if (a.kind === "interval" && b.kind === "interval") return a.minutes === b.minutes;
  if (a.kind === "daily" && b.kind === "daily") return a.time === b.time;
  return false;
}

/** The first run strictly after `after`. Daily times are in the server's local time zone. */
export function nextRun(timing: ScheduleTiming, after: number): number {
  if (timing.kind === "interval") return after + timing.minutes * 60_000;
  const [h, m] = timing.time.split(":").map(Number);
  const d = new Date(after);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= after) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * Whether an armed schedule is due at `now`, and when it runs next. However many runs were
 * missed (the machine slept, or the service was down), at most one is due, and the next
 * run counts from `now`.
 */
export function scheduleStep(timing: ScheduleTiming, nextRunAt: number, now: number): { due: boolean; nextRunAt: number } {
  if (now < nextRunAt) return { due: false, nextRunAt };
  return { due: true, nextRunAt: nextRun(timing, now) };
}

export function describeTiming(timing: ScheduleTiming): string {
  if (timing.kind === "daily") return `Daily at ${timing.time}`;
  const { minutes } = timing;
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
}

/** A short fingerprint of a note's text, to tell whether it changed since it was sent. */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
