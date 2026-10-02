import { useContext } from "react";
import { Bot, CircleCheck, MousePointerClick, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { StuckBadge } from "./attention.tsx";
import { agentAge } from "./format.ts";
import { PaneDetail } from "./PaneDetail.tsx";
import type { Located } from "./state.ts";
import { kindLabel, StatusDot } from "./status.tsx";
import { SubagentDetail } from "./SubagentDetail.tsx";
import { SubagentViewContext } from "./subagents.tsx";
import { HunkContext } from "./review.tsx";

interface Props {
  attention: Located[];
  starred: Located[];
  agentNames: Map<string, string>;
  detail?: Located;
  pinned: boolean;
  selectedId?: string;
  now: number;
  onFocus: (l: Located) => void;
  onHover: (paneId: string) => void;
  onSelect: (paneId: string) => void;
  onPin: (paneId: string | undefined) => void;
  /** On the board, a click pins a card's preview instead of opening it. */
  board?: boolean;
}

export function Sidebar({ attention, starred, agentNames, detail, pinned, selectedId, now, onFocus, onHover, onSelect, onPin, board }: Props) {
  const rowActions = { onFocus, onHover, onSelect };
  const subagent = useContext(SubagentViewContext);
  const openSubagent = pinned && detail && subagent?.selected?.pane === detail.pane.id ? subagent.selected.id : undefined;
  return (
    <aside className="flex h-full min-h-0 flex-col bg-background">
      {starred.length > 0 && (
        <>
          <section className="max-h-[30%] shrink-0 overflow-y-auto p-4" aria-label="Starred">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-semibold">Starred</h2>
              <Badge variant="secondary">{starred.length}</Badge>
              <span className="ml-auto text-xs text-muted-foreground">
                <Kbd>g</Kbd> next · <Kbd>s</Kbd> star
              </span>
            </div>
            <ul className="-mx-2 space-y-0.5">
              {starred.map((l) => (
                <AgentRow key={l.pane.id} located={l} selected={selectedId === l.pane.id} now={now} {...rowActions} />
              ))}
            </ul>
          </section>
          <Separator />
        </>
      )}
      <section className="max-h-[40%] shrink-0 overflow-y-auto p-4">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold">Needs you</h2>
          {attention.length > 0 && <Badge variant="secondary">{attention.length}</Badge>}
        </div>
        {attention.length > 0 && (
          <p className="mb-2 text-xs text-muted-foreground">
            <Kbd>n</Kbd> next · <Kbd>o</Kbd> open in terminal · <Kbd>r</Kbd> reply · <Kbd>esc</Kbd> clear
          </p>
        )}
        {attention.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleCheck className="size-4" />
            No blocked, stuck, or finished agents, or unread review notes.
          </p>
        ) : (
          <ul className="-mx-2 space-y-0.5">
            {attention.map((l) => (
              <AgentRow key={l.pane.id} located={l} selected={selectedId === l.pane.id} now={now} {...rowActions} />
            ))}
          </ul>
        )}
      </section>
      <Separator />
      {detail && openSubagent ? (
        <SubagentDetail key={openSubagent} located={detail} id={openSubagent} now={now} onBack={() => subagent?.close()} />
      ) : detail ? (
        <PaneDetail
          located={detail}
          agentNames={agentNames}
          pinned={pinned}
          now={now}
          onOpen={() => onFocus(detail)}
          onTogglePin={() => onPin(pinned ? undefined : detail.pane.id)}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <MousePointerClick className="size-5" />
          <p>Hover a pane to preview its screen.</p>
          {board ? (
            <p className="text-xs">
              Click to pin it here. Double-click or press <Kbd>o</Kbd> to open it in your terminal.
            </p>
          ) : (
            <p className="text-xs">
              Click to open it in your terminal. <Kbd>⌥</Kbd> click to pin it here.
            </p>
          )}
        </div>
      )}
    </aside>
  );
}

interface RowProps {
  located: Located;
  selected: boolean;
  now: number;
  onFocus: (l: Located) => void;
  onHover: (paneId: string) => void;
  onSelect: (paneId: string) => void;
}

function AgentRow({ located: l, selected, now, onFocus, onHover, onSelect }: RowProps) {
  const agent = l.pane.agent!;
  const unread = useContext(HunkContext).unread(l.pane.id).length;
  return (
    <li className={cn("group flex items-center rounded-md hover:bg-accent", selected && "bg-accent")}>
      <button
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
        onMouseEnter={() => onHover(l.pane.id)}
        onClick={() => onSelect(l.pane.id)}
      >
        <StatusDot status={agent.status} />
        <span className="min-w-0 flex-1 truncate">{agent.name ?? l.workspace.label}</span>
        {agent.stuck && <StuckBadge stuck={agent.stuck} now={now} />}
        {unread > 0 && (
          <Badge variant="outline" className="gap-1 text-(--hunk-agent)" title={`${unread} unread hunk review note${unread === 1 ? "" : "s"}`}>
            <Bot className="size-3" aria-hidden />
            {unread} note{unread === 1 ? "" : "s"}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">{kindLabel(agent.kind)}</span>
        <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{agentAge(agent, now)}</span>
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="mr-1 size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label="Open in terminal"
        title="Open in terminal"
        onClick={() => onFocus(l)}
      >
        <SquareTerminal className="size-3.5" />
      </Button>
    </li>
  );
}
