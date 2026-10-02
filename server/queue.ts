// The deliver-when-idle queue: prompts wait here until their target agent is idle or
// done, then go out with `herdr agent prompt`, one at a time per target, oldest first.
// The queue, the global pause, and scheduled prompts are saved together in one file.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  HISTORY_KEEP,
  isTiming,
  MAX_QUEUE_ITEMS,
  PROMPT_TEXT_MAX,
  type DeliveredItem,
  type QueueItem,
  type QueueSource,
  type QueueSourceKind,
  type Schedule,
} from "../shared/automation.ts";
import { errorMessage } from "../shared/errors.ts";
import type { Fleet } from "../shared/model.ts";
import { isFiniteNumber, isNonEmptyString, isObject } from "../shared/parse.ts";
import { indexPanes, isFree } from "./agents.ts";
import { herdrMessage } from "./herdr.ts";

export interface QueueFile {
  version: 1;
  paused: boolean;
  items: QueueItem[];
  history: DeliveredItem[];
  schedules: Schedule[];
}

export function defaultQueuePath(layoutPath: string): string {
  return join(dirname(layoutPath), "queue.json");
}

export function emptyQueueFile(): QueueFile {
  return { version: 1, paused: false, items: [], history: [], schedules: [] };
}

/** Attempts before an item is marked failed, and the wait after each failed one. */
export const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [5_000, 20_000, 60_000];
/** Items whose target disappeared stay visible this long. */
export const GONE_KEEP_MS = 60 * 60_000;
/**
 * After a delivery, a target gets nothing more until this long has passed and a newer
 * snapshot has arrived, so a stale `idle` can't pull the next item in right behind it.
 */
export const COOLDOWN_MS = 5_000;
const MAX_TEXT = 20_000;

const SOURCE_KINDS = ["handoff", "context", "note", "schedule", "manual"] satisfies QueueSourceKind[];

// The parsers below read the queue file, which can hold anything.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */
function parseSource(v: unknown): QueueSource | undefined {
  if (!isObject(v) || typeof v.label !== "string") return undefined;
  const kind = SOURCE_KINDS.find((k) => k === v.kind);
  if (!kind) return undefined;
  const s: QueueSource = { kind, label: v.label };
  if (isNonEmptyString(v.linkId)) s.linkId = v.linkId;
  if (isNonEmptyString(v.scheduleId)) s.scheduleId = v.scheduleId;
  return s;
}

function parseItem(v: unknown): QueueItem | undefined {
  if (!isObject(v) || !isNonEmptyString(v.id) || !isNonEmptyString(v.target) || !isNonEmptyString(v.text) || !isFiniteNumber(v.createdAt)) return undefined;
  const source = parseSource(v.source);
  if (!source) return undefined;
  const state = v.state === "failed" || v.state === "gone" ? v.state : "pending";
  const item: QueueItem = {
    id: v.id,
    target: v.target,
    targetLabel: typeof v.targetLabel === "string" ? v.targetLabel : v.target,
    text: v.text,
    source,
    createdAt: v.createdAt,
    attempts: isFiniteNumber(v.attempts) ? v.attempts : 0,
    state,
  };
  if (isFiniteNumber(v.notBefore)) item.notBefore = v.notBefore;
  if (typeof v.lastError === "string") item.lastError = v.lastError;
  if (v.sendNow === true) item.sendNow = true;
  if (isFiniteNumber(v.goneAt)) item.goneAt = v.goneAt;
  return item;
}

function parseDelivered(v: unknown): DeliveredItem | undefined {
  if (!isObject(v) || !isNonEmptyString(v.id) || !isNonEmptyString(v.target) || typeof v.text !== "string") return undefined;
  const source = parseSource(v.source);
  if (!source || !isFiniteNumber(v.createdAt) || !isFiniteNumber(v.deliveredAt)) return undefined;
  const targetLabel = typeof v.targetLabel === "string" ? v.targetLabel : v.target;
  return { id: v.id, target: v.target, targetLabel, text: v.text, source, createdAt: v.createdAt, deliveredAt: v.deliveredAt };
}

function parseSchedule(v: unknown): Schedule | undefined {
  if (!isObject(v) || !isNonEmptyString(v.id) || !isNonEmptyString(v.target) || !isNonEmptyString(v.text) || !isTiming(v.timing)) return undefined;
  if (!isFiniteNumber(v.createdAt) || !isFiniteNumber(v.updatedAt)) return undefined;
  const s: Schedule = {
    id: v.id,
    target: v.target,
    targetLabel: typeof v.targetLabel === "string" ? v.targetLabel : v.target,
    text: v.text,
    timing: v.timing,
    armed: v.armed === true && isFiniteNumber(v.nextRunAt),
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
  if (s.armed && isFiniteNumber(v.nextRunAt)) s.nextRunAt = v.nextRunAt;
  if (isFiniteNumber(v.lastRunAt)) s.lastRunAt = v.lastRunAt;
  if (typeof v.lastResult === "string") s.lastResult = v.lastResult;
  return s;
}

function parseList<T extends { id: string }>(v: unknown, parse: (e: unknown) => T | undefined): T[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of v) {
    const item = parse(e);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/** Reads the queue file, keeping each valid entry. A missing or unreadable file starts empty. */
export async function loadQueueFile(path: string): Promise<QueueFile> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return emptyQueueFile();
  }
  if (!isObject(value)) return emptyQueueFile();
  return {
    version: 1,
    paused: value.paused === true,
    items: parseList(value.items, parseItem),
    history: parseList(value.history, parseDelivered).slice(-HISTORY_KEEP),
    schedules: parseList(value.schedules, parseSchedule),
  };
}

/** Returns a function that saves the given state; saves run one at a time, each through a temp file and rename. */
function createWriter(path: string) {
  let chain: Promise<unknown> = Promise.resolve();
  return (data: QueueFile): Promise<void> => {
    const run = chain.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
      await rename(tmp, path);
    });
    chain = run.catch((err) => console.error(`herdr-map: couldn't save ${path}: ${errorMessage(err)}`));
    return run;
  };
}

/** Prompt text typed by the user: not blank, and within the limit. */
export function isPromptText(text: unknown): text is string {
  return typeof text === "string" && text.trim().length > 0 && text.length <= PROMPT_TEXT_MAX;
}

export interface FleetView {
  fleet?: Fleet;
  error?: string;
  /** When `fleet` was read. */
  updatedAt?: number;
}

export interface QueueDeps {
  path: string;
  view(): FleetView;
  send(pane: string, text: string): Promise<void>;
  /** Called after each delivery, so the target's new status is polled soon. */
  onDelivered?(): void;
}

export interface EnqueueInput {
  target: string;
  targetLabel: string;
  text: string;
  source: QueueSource;
  /** Replace the text of a pending item from the same link and target instead of adding another. */
  coalesce?: boolean;
}

export type Queue = ReturnType<typeof createQueue>;

export async function openQueue(deps: QueueDeps): Promise<Queue> {
  return createQueue(deps, await loadQueueFile(deps.path));
}

/** The item that goes next for one target: Send now first, then the oldest. */
function head(items: QueueItem[]): QueueItem {
  return items.reduce((a, b) => (!!b.sendNow !== !!a.sendNow ? (b.sendNow ? b : a) : b.createdAt < a.createdAt ? b : a));
}

export function createQueue(deps: QueueDeps, data: QueueFile) {
  const write = createWriter(deps.path);
  const lastSent = new Map<string, number>();
  let ticking = false;

  const save = () => write(data);

  function enqueue(input: EnqueueInput, now = Date.now()): QueueItem | string {
    const text = input.text;
    if (text.length === 0 || text.length > MAX_TEXT) return `text must be 1-${MAX_TEXT} characters`;
    if (input.coalesce && input.source.linkId) {
      const same = data.items.find(
        (i) => i.state === "pending" && i.target === input.target && i.source.linkId === input.source.linkId,
      );
      if (same) {
        same.text = text;
        void save();
        return same;
      }
    }
    if (data.items.length >= MAX_QUEUE_ITEMS) return `the queue holds at most ${MAX_QUEUE_ITEMS} items`;
    const item: QueueItem = {
      id: randomUUID(),
      target: input.target,
      targetLabel: input.targetLabel,
      text,
      source: input.source,
      createdAt: now,
      attempts: 0,
      state: "pending",
    };
    data.items.push(item);
    void save();
    return item;
  }

  const find = (id: string) => data.items.find((i) => i.id === id);

  /** Removes items matching `pred`; returns how many. */
  function cancelWhere(pred: (i: QueueItem) => boolean): number {
    const before = data.items.length;
    data.items = data.items.filter((i) => !pred(i));
    const removed = before - data.items.length;
    if (removed > 0) void save();
    return removed;
  }

  /** Puts an item ahead of the others for its target, clears any wait, and lets it through the pause. */
  function sendNow(id: string): QueueItem | undefined {
    const item = find(id);
    if (!item || item.state === "gone") return undefined;
    item.sendNow = true;
    item.state = "pending";
    delete item.notBefore;
    if (item.attempts >= MAX_ATTEMPTS) item.attempts = 0;
    void save();
    return item;
  }

  function retry(id: string): QueueItem | undefined {
    const item = find(id);
    if (!item || item.state === "gone") return undefined;
    item.state = "pending";
    item.attempts = 0;
    delete item.notBefore;
    delete item.lastError;
    void save();
    return item;
  }

  function setPaused(paused: boolean) {
    data.paused = paused;
    void save();
  }

  function prune(now: number): boolean {
    const before = data.items.length;
    data.items = data.items.filter((i) => i.state !== "gone" || now - (i.goneAt ?? now) < GONE_KEEP_MS);
    return data.items.length < before;
  }

  async function deliver(item: QueueItem, now: number): Promise<void> {
    try {
      await deps.send(item.target, item.text);
    } catch (err) {
      item.attempts++;
      item.lastError = herdrMessage(err);
      if (item.attempts >= MAX_ATTEMPTS) {
        item.state = "failed";
        delete item.notBefore;
        delete item.sendNow;
      } else {
        item.notBefore = now + BACKOFF_MS[Math.min(item.attempts, BACKOFF_MS.length) - 1];
      }
      return;
    }
    lastSent.set(item.target, now);
    data.items = data.items.filter((i) => i.id !== item.id);
    const { id, target, targetLabel, text, source, createdAt } = item;
    data.history.push({ id, target, targetLabel, text, source, createdAt, deliveredAt: now });
    if (data.history.length > HISTORY_KEEP) data.history.splice(0, data.history.length - HISTORY_KEEP);
    deps.onDelivered?.();
  }

  /** Marks items whose target is gone and sends at most one item per free target. */
  async function tick(now = Date.now()): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      let changed = prune(now);
      const view = deps.view();
      // Without a current snapshot, statuses and missing panes can't be trusted.
      if (!view.fleet || view.error) {
        if (changed) await save();
        return;
      }
      const panes = indexPanes(view.fleet);
      const byTarget = new Map<string, QueueItem[]>();
      for (const item of data.items) {
        if (item.state !== "pending") continue;
        if (!panes.has(item.target)) {
          item.state = "gone";
          item.goneAt = now;
          changed = true;
          continue;
        }
        byTarget.set(item.target, [...(byTarget.get(item.target) ?? []), item]);
      }
      for (const [target, items] of byTarget) {
        const next = head(items);
        if (data.paused && !next.sendNow) continue;
        if (next.notBefore !== undefined && next.notBefore > now) continue;
        if (!isFree(panes.get(target)?.status)) continue;
        const last = lastSent.get(target);
        if (last !== undefined && (now - last < COOLDOWN_MS || (view.updatedAt ?? 0) <= last)) continue;
        await deliver(next, now);
        changed = true;
      }
      if (changed) await save();
    } finally {
      ticking = false;
    }
  }

  return { data, save, enqueue, cancelWhere, cancel: (id: string) => cancelWhere((i) => i.id === id) > 0, sendNow, retry, setPaused, tick };
}
