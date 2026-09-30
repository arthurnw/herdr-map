// The deliver-when-idle queue and what the UI reads about it.
// Shared by the server (which runs and persists it) and the web UI.
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

/** `GET /api/automation`. */
export interface AutomationState {
  paused: boolean;
  items: QueueItem[];
  /** Delivered items, newest last. */
  history: DeliveredItem[];
  links: Link[];
}

export const PROMPT_TEXT_MAX = 10_000;
export const MAX_QUEUE_ITEMS = 500;
export const MAX_LINKS = 500;
export const HISTORY_KEEP = 50;

