import { useCallback, useEffect, useState } from "react";
import { LayoutDashboard, RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { emptyLayout, type SavedLayout } from "./layout.ts";
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

export interface LayoutMenuProps {
  /** Positions of every visible workspace as currently drawn, and the saved card positions. */
  currentPositions: () => SavedLayout;
  isCustom: boolean;
  onApply: (layout: SavedLayout) => void;
}

export function LayoutMenu({ currentPositions, isCustom, onApply }: LayoutMenuProps) {
  const [open, setOpen] = useState(false);
  const [named, setNamed] = useState<Record<string, NamedLayout>>({});
  const [name, setName] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/layouts");
      if (!res.ok) throw new Error("the server doesn't support saved layouts yet; restart it");
      setNamed(await res.json());
    } catch (err) {
      toast.error("Couldn't load layouts", { description: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const run = async (fn: () => Promise<void>, success?: string) => {
    try {
      await fn();
      await refresh();
      if (success) toast.success(success);
    } catch (err) {
      toast.error("Layout change failed", { description: (err as Error).message });
    }
  };

  // Replacing the arrangement first stashes the current one as the previous layout.
  const replaceWith = (layout: SavedLayout, success: string) =>
    run(async () => {
      if (isCustom) await saveNamed(PREVIOUS, currentPositions());
      onApply(layout);
    }, success);

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void run(async () => {
      await saveNamed(trimmed, currentPositions());
      setName("");
    }, `Saved “${trimmed}”`);
  };

  const remove = (n: string) =>
    run(async () => {
      await fetch(url(n), { method: "DELETE" });
    });

  const entries = Object.entries(named).sort(([a], [b]) =>
    // The previous layout stays on top; the rest sort by name.
    a === PREVIOUS ? -1 : b === PREVIOUS ? 1 : a.localeCompare(b),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5">
          <LayoutDashboard className="size-3.5" />
          Layouts
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="p-3">
          <div className="mb-2 text-sm font-medium">Save current arrangement</div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <Input
              placeholder="Layout name"
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              className="h-8"
              autoFocus
            />
            <Button type="submit" size="sm" className="h-8 gap-1.5" disabled={!name.trim()}>
              <Save className="size-3.5" />
              Save
            </Button>
          </form>
        </div>
        <Separator />
        <div className="max-h-64 overflow-y-auto p-1.5">
          {entries.length === 0 ? (
            <p className="px-2 py-3 text-center text-sm text-muted-foreground">No saved layouts yet.</p>
          ) : (
            entries.map(([n, entry]) => (
              <div key={n} className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm" title={n}>
                    {n}
                  </div>
                  <div className="text-xs text-muted-foreground">{formatAge(Date.now() - entry.savedAt)} ago</div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7"
                  onClick={() => void replaceWith(entry.layout, `Restored “${n}”`)}
                >
                  Restore
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete ${n}`}
                  onClick={() => void remove(n)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))
          )}
        </div>
        <Separator />
        <div className="p-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5"
            disabled={!isCustom}
            onClick={() => void replaceWith(emptyLayout(), "Reset to the automatic layout")}
          >
            <RotateCcw className="size-3.5" />
            Reset to automatic layout
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            Reset and Restore save the arrangement they replace as “{PREVIOUS}”.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
