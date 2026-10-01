// The board view: agents in one row of status columns, in place of the canvas.
import { useEffect, useRef } from "react";
import type { AgentStatus } from "../shared/model.ts";
import { Badge } from "@/components/ui/badge";
import type { BoardCard, BoardColumn, ColumnId } from "./board.ts";
import { GitBadge } from "./git.tsx";
import { AgentCardBody, agentCardClass, type AgentPane } from "./nodes.tsx";
import { StatusDot } from "./status.tsx";
import "./board.css";

const COLUMN_STATUS: Record<ColumnId, AgentStatus> = {
  needs: "blocked",
  working: "working",
  done: "done",
  idle: "idle",
  unknown: "unknown",
};

interface Props {
  columns: BoardColumn[];
  selectedId?: string;
  /** Pins the card's preview in the sidebar. */
  onSelect: (paneId: string) => void;
  /** Pins the card's preview, or unpins it when it's already pinned. */
  onTogglePin: (paneId: string) => void;
  /** Focuses the agent in herdr. */
  onOpen: (card: BoardCard) => void;
  onHover: (paneId: string) => void;
}

export function Board({ columns, selectedId, onSelect, onTogglePin, onOpen, onHover }: Props) {
  const root = useRef<HTMLDivElement>(null);

  // Brings the selection into view however it was made: a click, an arrow key, Needs you, or the palette.
  useEffect(() => {
    if (!selectedId) return;
    root.current
      ?.querySelector(`[data-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedId]);

  return (
    <div ref={root} className="board" aria-label="Board">
      {columns.map((col) => (
        <section key={col.id} className="board-column" data-column={col.id} aria-label={col.title}>
          <header className="board-column-header">
            <StatusDot status={COLUMN_STATUS[col.id]} />
            <h2>{col.title}</h2>
            <Badge variant="secondary" className="board-count tabular-nums">
              {col.cards.length}
            </Badge>
          </header>
          {col.cards.length === 0 ? (
            <p className="board-empty">No agents</p>
          ) : (
            <ul className="board-cards">
              {col.cards.map((card) => (
                <li key={card.pane.id}>
                  <Card
                    card={card}
                    selected={card.pane.id === selectedId}
                    onSelect={onSelect}
                    onTogglePin={onTogglePin}
                    onOpen={onOpen}
                    onHover={onHover}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function Card({ card, selected, onSelect, onTogglePin, onOpen, onHover }: { card: BoardCard; selected: boolean } & Omit<Props, "columns" | "selectedId">) {
  const pane = card.pane as AgentPane;
  const { workspace: ws, repo } = card;
  const location = (
    <div className="board-where">
      <span className="board-where-label">{repo === ws.label ? ws.label : `${repo} · ${ws.label}`}</span>
      <GitBadge git={ws.git} label={ws.label} worktree={ws.linkedWorktree} />
    </div>
  );
  return (
    <div
      className={`${agentCardClass(pane)} board-card${selected ? " selected" : ""}`}
      data-id={pane.id}
      onClick={(e) => (e.altKey ? onTogglePin(pane.id) : onSelect(pane.id))}
      onDoubleClick={() => onOpen(card)}
      onMouseEnter={() => onHover(pane.id)}
    >
      <AgentCardBody pane={pane} location={location} />
    </div>
  );
}
