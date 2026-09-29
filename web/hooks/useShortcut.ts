import { useEffect, useRef } from "react";
import { dispatchShortcut, type Registration, type Shortcut } from "../shortcuts.ts";

// Every mounted binding, in registration order. One document listener serves them all
// and is attached while at least one binding is mounted.
const registrations = new Set<Registration>();

function onKeyDown(e: KeyboardEvent) {
  dispatchShortcut(registrations, e);
}

/** The bindings mounted right now, for listing them (e.g. in a help panel). */
export function activeShortcuts(): Shortcut[] {
  return [...registrations].map((r) => r.binding);
}

/** The mounted bindings with their handlers, for running a shortcut from a list. */
export function activeRegistrations(): Registration[] {
  return [...registrations];
}

/**
 * Registers a keyboard shortcut while the calling component is mounted. The binding and
 * handler are read at key time, so they can close over current state without re-registering.
 */
export function useShortcut(binding: Shortcut, handler: () => void) {
  const reg = useRef<Registration>({ binding, handler });

  useEffect(() => {
    reg.current.binding = binding;
    reg.current.handler = handler;
  });

  useEffect(() => {
    const r = reg.current;
    registrations.add(r);
    if (registrations.size === 1) document.addEventListener("keydown", onKeyDown);
    return () => {
      registrations.delete(r);
      if (registrations.size === 0) document.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
