// Renaming an agent from the sidebar preview.
import { useState } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentNameError } from "../shared/names.ts";
import type { Located } from "./state.ts";
import { KIND_LABEL } from "./status.tsx";

/** Live agents' names by pane ID. */
export function agentNames(panes: Map<string, Located>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, l] of panes) if (l.pane.agent?.name) out.set(id, l.pane.agent.name);
  return out;
}

async function requestRename(pane: string, name: string) {
  const res = await fetch("/api/rename", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane, name }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
}

interface Props {
  located: Located;
  names: Map<string, string>;
}

/** The agent's name with a pencil button that turns it into an input. Enter saves, Esc cancels. */
export function AgentName({ located, names }: Props) {
  const { pane } = located;
  const agent = pane.agent!;
  const label = agent.name ?? KIND_LABEL[agent.kind] ?? agent.kind;
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);

  const taken = [...names].filter(([id]) => id !== pane.id).map(([, name]) => name);
  const error = draft !== undefined && draft !== agent.name ? agentNameError(draft, taken) : undefined;

  const save = async () => {
    if (draft === undefined || draft === agent.name) return setDraft(undefined);
    if (error) return;
    setSaving(true);
    try {
      await requestRename(pane.id, draft);
      setDraft(undefined);
    } catch (err) {
      toast.error("herdr couldn't rename the agent", { description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  if (draft === undefined) {
    return (
      <>
        <span className="font-medium">{label}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          aria-label="Rename agent"
          title="Rename agent"
          onClick={() => setDraft(agent.name ?? "")}
        >
          <Pencil className="size-3" />
        </Button>
      </>
    );
  }

  return (
    <span className="flex basis-full flex-col gap-1">
      <Input
        autoFocus
        aria-label="Agent name"
        aria-invalid={!!error}
        value={draft}
        placeholder="agent name"
        className="h-7 w-48 font-mono text-xs"
        onChange={(e) => setDraft(e.target.value.toLowerCase())}
        onBlur={() => !saving && setDraft(undefined)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setDraft(undefined);
        }}
      />
      <span className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
        {error ?? "Enter saves · Esc cancels"}
      </span>
    </span>
  );
}
