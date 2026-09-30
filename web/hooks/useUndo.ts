import { useCallback, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import type { SavedLayout } from "../layout.ts";
import { lastLayoutWriteAt, layoutWritten } from "../state.ts";
import { useShortcut } from "./useShortcut.ts";

/**
 * ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y elsewhere) undo and redo layout changes:
 * moves, taking workspaces out of their box or back, resets, and restores. The server keeps
 * both lists, so they survive reloads and every open tab shares them; this applies the
 * layout it returns. Typing in a field keeps the field's own undo.
 */
export function useLayoutUndo(
  setSaved: Dispatch<SetStateAction<SavedLayout | undefined>>,
  /** Deleted notes this tab can bring back; ⌘Z restores one when it's newer than the last layout change. */
  notes?: { lastDeletedAt(): number | undefined; undoDelete(): boolean },
) {
  const step = useCallback(
    async (direction: "undo" | "redo") => {
      const deletedAt = notes?.lastDeletedAt();
      if (direction === "undo" && deletedAt !== undefined && deletedAt > lastLayoutWriteAt() && notes!.undoDelete()) {
        toast("Note restored");
        return;
      }
      try {
        await layoutWritten();
        const res = await fetch(`/api/layout/${direction}`, { method: "POST" });
        if (res.status === 409) {
          toast(direction === "undo" ? "Nothing to undo" : "Nothing to redo");
          return;
        }
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
        const { layout } = (await res.json()) as { layout: SavedLayout };
        setSaved(layout);
      } catch (err) {
        toast.error(`Couldn't ${direction}`, { description: (err as Error).message });
      }
    },
    [setSaved, notes],
  );

  const undo = () => void step("undo");
  const redo = () => void step("redo");
  const UNDO = "Undo layout change";
  const REDO = "Redo layout change";
  useShortcut({ key: "z", meta: true, shift: false, description: UNDO }, undo);
  useShortcut({ key: "z", ctrl: true, shift: false, description: UNDO }, undo);
  // Browsers report Shift+Z as "z" or "Z" depending on the platform and modifier.
  useShortcut({ key: "z", meta: true, shift: true, description: REDO }, redo);
  useShortcut({ key: "Z", meta: true, shift: true, description: REDO }, redo);
  useShortcut({ key: "z", ctrl: true, shift: true, description: REDO }, redo);
  useShortcut({ key: "Z", ctrl: true, shift: true, description: REDO }, redo);
  useShortcut({ key: "y", ctrl: true, description: REDO }, redo);
}
