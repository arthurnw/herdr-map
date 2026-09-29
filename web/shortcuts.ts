// Keyboard shortcut matching, kept free of React and DOM types so it runs under node:test.

export interface Shortcut {
  /** Compared with KeyboardEvent.key, so an uppercase letter means Shift+letter. */
  key: string;
  /** Cmd, Ctrl, and Alt must match exactly; a binding that leaves them out ignores events that hold them. */
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  /** Only checked when set, because the key value already reflects Shift for letters and symbols. */
  shift?: boolean;
  description: string;
  /** A disabled binding lets the event through untouched, without preventDefault. */
  enabled?: boolean | (() => boolean);
}

/** The parts of a KeyboardEvent the matcher reads. */
export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: unknown;
  preventDefault(): void;
}

export interface Registration {
  binding: Shortcut;
  handler: () => void;
}

// Typing in a field or moving through an open menu should never trigger a shortcut.
const IGNORED_TARGETS = "input, textarea, select, [contenteditable], [role=menu]";

export function isIgnoredTarget(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  return typeof el?.closest === "function" && !!el.closest(IGNORED_TARGETS);
}

export function isEnabled(binding: Shortcut): boolean {
  const { enabled = true } = binding;
  return typeof enabled === "function" ? enabled() : enabled;
}

export function matchesShortcut(binding: Shortcut, e: KeyEventLike): boolean {
  return (
    e.key === binding.key &&
    e.metaKey === !!binding.meta &&
    e.ctrlKey === !!binding.ctrl &&
    e.altKey === !!binding.alt &&
    (binding.shift === undefined || e.shiftKey === binding.shift)
  );
}

/** The first enabled registration that should handle this event, if any. */
export function findShortcut<R extends Registration>(registrations: Iterable<R>, e: KeyEventLike): R | undefined {
  if (isIgnoredTarget(e.target)) return undefined;
  for (const r of registrations) if (matchesShortcut(r.binding, e) && isEnabled(r.binding)) return r;
  return undefined;
}

/** Runs the matching handler and prevents the default action; returns whether one ran. */
export function dispatchShortcut(registrations: Iterable<Registration>, e: KeyEventLike): boolean {
  const hit = findShortcut(registrations, e);
  if (!hit) return false;
  hit.handler();
  e.preventDefault();
  return true;
}
