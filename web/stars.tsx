// Starred agents, remembered per browser by pane ID.
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useShortcut } from "./hooks/useShortcut.ts";
import { safeStorage, type Located } from "./state.ts";

const KEY = "herdr-map.stars";

export interface Stars {
  /** Starred pane IDs in the order they were starred. May include panes that have closed. */
  ids: string[];
  isStarred: (paneId: string) => boolean;
  toggle: (paneId: string) => void;
}

function load(): string[] {
  try {
    const saved = JSON.parse(safeStorage.getItem(KEY) ?? "[]");
    if (Array.isArray(saved)) return saved.filter((id): id is string => typeof id === "string");
  } catch {}
  return [];
}

export function useStars(): Stars {
  const [ids, setIds] = useState(load);
  const toggle = useCallback((paneId: string) => {
    setIds((prev) => {
      const next = prev.includes(paneId) ? prev.filter((id) => id !== paneId) : [...prev, paneId];
      safeStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return useMemo(() => {
    const set = new Set(ids);
    return { ids, isStarred: (id: string) => set.has(id), toggle };
  }, [ids, toggle]);
}

export const StarsContext = createContext<Stars>({ ids: [], isStarred: () => false, toggle: () => {} });

export function StarsProvider({ children }: { children: React.ReactNode }) {
  return <StarsContext.Provider value={useStars()}>{children}</StarsContext.Provider>;
}

export function useStarsContext() {
  return useContext(StarsContext);
}

/** Starred agents that still exist, in the order they were starred. */
export function starredAgents(panes: Map<string, Located>, ids: string[]): Located[] {
  return ids.flatMap((id) => {
    const l = panes.get(id);
    return l?.pane.agent ? [l] : [];
  });
}

/** `s` stars or unstars the selected agent, and `g` moves to the next starred agent. */
export function useStarShortcuts(
  stars: Stars,
  starred: Located[],
  selected: Located | undefined,
  select: (paneId: string) => void,
) {
  useShortcut({ key: "s", description: "Star or unstar selected agent", enabled: !!selected?.pane.agent }, () =>
    stars.toggle(selected!.pane.id),
  );
  useShortcut({ key: "g", description: "Next starred agent", enabled: starred.length > 0 }, () => {
    const i = starred.findIndex((l) => l.pane.id === selected?.pane.id);
    select(starred[(i + 1) % starred.length].pane.id);
  });
}

export function StarButton({ paneId }: { paneId: string }) {
  const { isStarred, toggle } = useStarsContext();
  const on = isStarred(paneId);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={on ? "Unstar" : "Star"}
      aria-pressed={on}
      title={on ? "Unstar (s)" : "Star (s)"}
      onClick={() => toggle(paneId)}
    >
      <Star className={cn("size-3.5", on && "fill-current text-(--star)")} />
    </Button>
  );
}
