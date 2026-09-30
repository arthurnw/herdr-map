// The automation block in an agent's preview: its links, and a way to queue a prompt for
// when it's idle.
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ListPlus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PROMPT_TEXT_MAX } from "../shared/automation.ts";
import { agentLabel, useAutomation } from "./automation.tsx";
import { describeLink } from "./links.tsx";
import type { Located } from "./state.ts";

export function AgentAutomation({ located }: { located: Located }) {
  const auto = useAutomation();
  const paneId = located.pane.id;
  const [open, setOpen] = useState(false);
  const [queueing, setQueueing] = useState(false);

  useEffect(() => setQueueing(false), [paneId]);

  const links = useMemo(
    () => (auto?.state?.links ?? []).filter((l) => (l.from.kind === "pane" && l.from.id === paneId) || l.to.id === paneId),
    [auto?.state?.links, paneId],
  );
  const waiting = (auto?.state?.items ?? []).filter((i) => i.target === paneId).length;
  if (!auto?.state) return null;

  const summary = [
    links.length && `${links.length} link${links.length > 1 ? "s" : ""}`,
    waiting && `${waiting} queued`,
  ].filter(Boolean);

  return (
    <div className="rounded-lg border text-sm" data-testid="agent-automation">
      <button className="flex w-full items-center gap-1.5 px-3 py-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className="font-medium">Automation</span>
        <span className="truncate text-xs text-muted-foreground">{summary.length ? summary.join(" · ") : "Links and queued prompts"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t px-3 py-2">
          {links.length > 0 && (
            <ul className="space-y-1" aria-label="Links">
              {links.map((l) => (
                <li key={l.id} className="flex items-start gap-2 text-xs">
                  <Badge variant="outline" className="font-normal">
                    {l.from.kind === "note" ? "note" : l.kind}
                  </Badge>
                  <span className="min-w-0 flex-1">{describeLink(l, auto.panes)}</span>
                  <Button variant="ghost" size="icon-xs" aria-label="Remove link" onClick={() => void auto.actions.deleteLink(l.id)}>
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {queueing ? (
            <QueueForm
              label={agentLabel(auto.panes, paneId)}
              onCancel={() => setQueueing(false)}
              onQueue={async (text) => {
                if (await auto.actions.enqueue(paneId, text)) setQueueing(false);
              }}
            />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <Button variant="outline" size="xs" onClick={() => setQueueing(true)}>
                <ListPlus />
                Send when idle
              </Button>
            </div>
          )}
          {links.length === 0 && (
            <p className="text-xs text-muted-foreground">Drag from the dot on an agent's card, or a note's, to another agent to link them.</p>
          )}
        </div>
      )}
    </div>
  );
}

function QueueForm({ label, onCancel, onQueue }: { label: string; onCancel: () => void; onQueue: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="space-y-2"
      aria-label="Send when idle"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onQueue(text);
      }}
    >
      <Textarea
        autoFocus
        value={text}
        maxLength={PROMPT_TEXT_MAX}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Prompt for ${label}`}
        aria-label="Prompt to queue"
        className="min-h-16 text-xs"
      />
      <p className="text-xs text-muted-foreground">Sent once the agent is idle or done.</p>
      <div className="flex gap-1.5">
        <Button type="submit" size="xs" disabled={!text.trim()}>
          Queue
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
