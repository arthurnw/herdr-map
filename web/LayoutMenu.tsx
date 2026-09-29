import { useCallback, useEffect, useRef, useState } from "react";
import type { SavedLayout } from "./layout.ts";
import { formatAge } from "./nodes.tsx";

export interface NamedLayout {
  savedAt: number;
  layout: SavedLayout;
}

/** Holds the arrangement that a reset or restore replaced, so either can be undone. */
export const PREVIOUS = "Previous layout";

const url = (name: string) => `/api/layouts/${encodeURIComponent(name)}`;

export async function saveNamed(name: string, layout: SavedLayout) {
  const res = await fetch(url(name), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(layout),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
}

interface Props {
  /** Positions of every visible workspace as currently drawn. */
  currentPositions: () => SavedLayout;
  isCustom: boolean;
  onApply: (layout: SavedLayout) => void;
  onError: (message: string) => void;
}

export function LayoutMenu({ currentPositions, isCustom, onApply, onError }: Props) {
  const [open, setOpen] = useState(false);
  const [named, setNamed] = useState<Record<string, NamedLayout>>({});
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      setNamed(await (await fetch("/api/layouts")).json());
    } catch (err) {
      onError((err as Error).message);
    }
  }, [onError]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
      await refresh();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  // Replacing the arrangement first stashes the current one as the previous layout.
  const replaceWith = (layout: SavedLayout) =>
    run(async () => {
      if (isCustom) await saveNamed(PREVIOUS, currentPositions());
      onApply(layout);
    });

  const save = () =>
    run(async () => {
      const trimmed = name.trim();
      if (!trimmed) return;
      await saveNamed(trimmed, currentPositions());
      setName("");
    });

  const remove = (n: string) =>
    run(async () => {
      await fetch(url(n), { method: "DELETE" });
    });

  const entries = Object.entries(named).sort(([a], [b]) =>
    // The previous layout stays on top; the rest sort by name.
    a === PREVIOUS ? -1 : b === PREVIOUS ? 1 : a.localeCompare(b),
  );

  return (
    <div className="layout-menu" ref={ref}>
      <button className="plain" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Layouts ▾
      </button>
      {open && (
        <div className="layout-panel">
          <form
            className="layout-save"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input
              placeholder="Name this layout"
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <button className="plain" type="submit" disabled={!name.trim()}>
              Save
            </button>
          </form>
          {entries.length === 0 && <p className="muted">No saved layouts yet.</p>}
          <ul className="layout-list">
            {entries.map(([n, entry]) => (
              <li key={n}>
                <span className="layout-name" title={n}>
                  {n}
                </span>
                <span className="muted">{formatAge(Date.now() - entry.savedAt)} ago</span>
                <button className="plain" onClick={() => void replaceWith(entry.layout)}>
                  Restore
                </button>
                <button className="plain" onClick={() => void remove(n)} aria-label={`Delete ${n}`}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button className="plain reset" onClick={() => void replaceWith({})} disabled={!isCustom}>
            Reset to automatic layout
          </button>
          <p className="muted hint">Reset and Restore save the layout they replace as “{PREVIOUS}”.</p>
        </div>
      )}
    </div>
  );
}
