// Links the user draws between agent cards, and from notes to agents: handoffs, context
// links, and note links. They are stored in the layout file and drawn as their own edges,
// apart from the lineage edges in layout.ts.
import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  useInternalNode,
  type Connection,
  type Edge,
  type EdgeProps,
  type FinalConnectionState,
  type InternalNode,
  type IsValidConnection,
} from "@xyflow/react";
import { BookOpen, Forward, StickyNote, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { textHash } from "../shared/automation.ts";
import type { Endpoint, Link, LinkKind } from "../shared/layout-types.ts";
import { agentLabel, useAutomation, type AutomationActions, type AutomationValue } from "./automation.tsx";
import { attachEdge, type Side } from "./edge-geometry.ts";
import { formatAge } from "./format.ts";
import type { Rect } from "./layout.ts";
import { stop } from "./organize.tsx";
import type { Located } from "./state.ts";

const NOTE_PREFIX = "note:";
export const LINK_IN = "link-in";
export const LINK_OUT = "link-out";

/** Connection handles for an agent card: the whole card takes a drop, and a dot on its right edge starts a link. */
export function LinkHandles() {
  return (
    <>
      <Handle type="target" id={LINK_IN} position={Position.Left} className="link-target" isConnectableStart={false} />
      <Handle
        type="source"
        id={LINK_OUT}
        position={Position.Right}
        className="link-source"
        isConnectableEnd={false}
        title="Drag to another agent to link them"
        onClick={stop}
      />
    </>
  );
}

/** The handle a note starts a link from. */
export function NoteLinkHandle() {
  return (
    <Handle
      type="source"
      id={LINK_OUT}
      position={Position.Right}
      className="link-source note-link-source"
      isConnectableEnd={false}
      title="Drag to an agent to send it this note"
      onClick={stop}
    />
  );
}

export type LinkEdgeData = { link: Link };

type Flavor = "handoff" | "context" | "note";
const flavorOf = (link: Link): Flavor => (link.from.kind === "note" ? "note" : link.kind);
const FLAVOR = {
  handoff: { icon: Forward, label: "handoff" },
  context: { icon: BookOpen, label: "context" },
  note: { icon: StickyNote, label: "note" },
};

const nodeId = (e: Endpoint) => (e.kind === "note" ? NOTE_PREFIX + e.id : e.id);

/** Edges for the stored links whose two ends are both on the map; the rest stay stored and unseen. */
export function linkEdges(links: Link[] | undefined, nodeIds: ReadonlySet<string>): Edge[] {
  return (links ?? [])
    .filter((l) => nodeIds.has(nodeId(l.from)) && nodeIds.has(nodeId(l.to)))
    .map((link) => ({
      id: `link:${link.id}`,
      type: "link",
      source: nodeId(link.from),
      target: nodeId(link.to),
      sourceHandle: LINK_OUT,
      targetHandle: LINK_IN,
      // Above the panes and zoomed-out labels, below notes.
      zIndex: 1500,
      className: `link-edge link-${flavorOf(link)}`,
      data: { link } satisfies LinkEdgeData,
    }));
}

/** What a link does, in a sentence. */
export function describeLink(link: Link, panes: Map<string, Located>): string {
  const to = agentLabel(panes, link.to.id);
  if (link.from.kind === "note") return `This note goes to ${to} when it's idle.`;
  const from = agentLabel(panes, link.from.id);
  return link.kind === "handoff"
    ? `When ${from} finishes a turn, its latest output goes to ${to}.`
    : `${to} was told once how to read ${from}.`;
}

const POSITION: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

// Pane cards are children of tab nodes, so their own positions are relative to the tab.
const nodeRect = (n: InternalNode): Rect => ({
  x: n.internals.positionAbsolute.x,
  y: n.internals.positionAbsolute.y,
  w: n.measured.width ?? n.width ?? 0,
  h: n.measured.height ?? n.height ?? 0,
});

/**
 * A link drawn between the sides of its two cards that face each other, rather than from
 * the handles, which sit on fixed sides.
 */
export const LinkEdge = memo((props: EdgeProps) => {
  const { id, source, target, data } = props;
  const auto = useAutomation();
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;
  const ends = attachEdge(nodeRect(sourceNode), nodeRect(targetNode));
  const [path, labelX, labelY] = getBezierPath({
    sourceX: ends.source.x,
    sourceY: ends.source.y,
    sourcePosition: POSITION[ends.source.side],
    targetX: ends.target.x,
    targetY: ends.target.y,
    targetPosition: POSITION[ends.target.side],
  });
  const { link } = data as LinkEdgeData;
  const flavor = flavorOf(link);
  const { icon: Icon, label } = FLAVOR[flavor];
  const markerId = `link-arrow-${link.id}`;
  // Stacked cards can be only a few pixels apart, so the chip goes beside a vertical edge
  // rather than on it, where it would cover both cards.
  const vertical = ends.source.side === "top" || ends.source.side === "bottom";
  const offset = vertical ? "translate(0.5em, -50%)" : "translate(-50%, -50%)";
  return (
    <>
      <defs>
        <marker
          id={markerId}
          className="link-arrowhead"
          markerWidth="16"
          markerHeight="16"
          viewBox="-10 -10 20 20"
          orient="auto-start-reverse"
          refX="0"
          refY="0"
        >
          <polyline points="-5,-4 0,0 -5,4 -5,-4" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>
      <BaseEdge id={id} path={path} markerEnd={`url('#${markerId}')`} className="link-path" />
      <EdgeLabelRenderer>
        <div className="link-label nodrag nopan" style={{ transform: `${offset} translate(${labelX}px, ${labelY}px)` }}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className={`link-chip link-chip-${flavor}`} aria-label={`${label} link`} onClick={stop} onPointerDown={stop}>
                <Icon aria-hidden />
                {label}
              </button>
            </DropdownMenuTrigger>
            {auto && <LinkMenu link={link} auto={auto} />}
          </DropdownMenu>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

function LinkMenu({ link, auto }: { link: Link; auto: AutomationValue }) {
  return (
    <DropdownMenuContent align="center" className="w-64" onClick={stop} onPointerDown={stop}>
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{describeLink(link, auto.panes)}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      {link.kind === "context" && (
        <DropdownMenuItem onSelect={() => void auto.actions.resendLink(link.id)}>
          <Undo2 aria-hidden />
          Send again
        </DropdownMenuItem>
      )}
      <DropdownMenuItem variant="destructive" onSelect={() => void auto.actions.deleteLink(link.id)}>
        <Trash2 aria-hidden />
        Remove link
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

export const linkEdgeTypes = { link: LinkEdge };

interface Choice {
  from: string;
  to: string;
  x: number;
  y: number;
}

/**
 * Drawing links: which drops are allowed, a kind chooser for agent-to-agent links, and
 * `linking` while a drag is in progress (it lets whole cards take the drop).
 */
export function useLinking(panes: Map<string, Located>, actions: AutomationActions | undefined) {
  const [linking, setLinking] = useState(false);
  const [choice, setChoice] = useState<Choice>();
  const dropped = useRef<Connection>(undefined);

  const isAgent = useCallback((id: string | null) => !!id && !!panes.get(id)?.pane.agent, [panes]);

  const isValidConnection: IsValidConnection = useCallback(
    (c) => c.source !== c.target && c.targetHandle === LINK_IN && isAgent(c.target) && (c.source.startsWith(NOTE_PREFIX) || isAgent(c.source)),
    [isAgent],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, _state: FinalConnectionState) => {
      setLinking(false);
      const c = dropped.current;
      dropped.current = undefined;
      if (!c || !actions) return;
      if (c.source.startsWith(NOTE_PREFIX)) {
        const to = agentLabel(panes, c.target);
        void actions
          .createLink({ kind: "note", id: c.source.slice(NOTE_PREFIX.length) }, { kind: "pane", id: c.target }, "context")
          .then((link) => link && toast(`Note queued for ${to}`, { description: "It's sent when the agent is idle." }));
        return;
      }
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      setChoice({ from: c.source, to: c.target, x: point.clientX, y: point.clientY });
    },
    [actions, panes],
  );

  const connectProps = {
    nodesConnectable: true,
    connectOnClick: false,
    isValidConnection,
    onConnectStart: () => setLinking(true),
    onConnect: (c: Connection) => (dropped.current = c),
    onConnectEnd,
  };

  const choose = (kind: LinkKind) => {
    if (!choice || !actions) return;
    setChoice(undefined);
    void actions.createLink({ kind: "pane", id: choice.from }, { kind: "pane", id: choice.to }, kind);
  };

  const chooser = (
    <Popover open={!!choice} onOpenChange={(open) => !open && setChoice(undefined)}>
      <PopoverAnchor asChild>
        <div className="pointer-events-none fixed size-px" style={{ left: choice?.x ?? 0, top: choice?.y ?? 0 }} />
      </PopoverAnchor>
      <PopoverContent className="w-80 p-2" aria-label="Choose a link">
        {choice && (
          <div className="space-y-1 text-sm">
            <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
              Link {agentLabel(panes, choice.from)} to {agentLabel(panes, choice.to)}
            </p>
            <LinkOption icon={Forward} title="Handoff" onClick={() => choose("handoff")}>
              When {agentLabel(panes, choice.from)} finishes a turn, send its latest output to {agentLabel(panes, choice.to)}.
            </LinkOption>
            <LinkOption icon={BookOpen} title="Context link" onClick={() => choose("context")}>
              Tell {agentLabel(panes, choice.to)} once how to read {agentLabel(panes, choice.from)} when it needs to.
            </LinkOption>
            <Button variant="ghost" size="sm" className="w-full" onClick={() => setChoice(undefined)}>
              Cancel
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );

  return { linking, connectProps, chooser };
}

function LinkOption({ icon: Icon, title, onClick, children }: { icon: typeof Forward; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className="flex w-full gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent" onClick={onClick}>
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span>
        <span className="font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{children}</span>
      </span>
    </button>
  );
}

/** Where a note went, shown at the bottom of the note, with Send again once it has been edited. */
export function NoteLinks({ noteId, text }: { noteId: string; text: string }) {
  const auto = useAutomation();
  const links = useMemo(
    () => (auto?.state?.links ?? []).filter((l) => l.from.kind === "note" && l.from.id === noteId),
    [auto?.state?.links, noteId],
  );
  if (!auto || links.length === 0) return null;
  const hash = textHash(text);
  return (
    <ul className="note-links nodrag nopan" aria-label="Sent to">
      {links.map((l) => {
        const edited = !!text.trim() && l.sent?.hash !== hash;
        return (
          <li key={l.id}>
            <span className="note-link-target">→ {agentLabel(auto.panes, l.to.id)}</span>
            <span className="note-link-status">{linkStatus(l, auto)}</span>
            {edited && (
              <button className="note-link-resend" onClick={() => void auto.actions.resendLink(l.id)}>
                Send again
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function linkStatus(link: Link, auto: AutomationValue): string {
  const item = auto.state?.items.find((i) => i.source.linkId === link.id);
  if (item) return item.state === "pending" ? "waiting" : item.state === "failed" ? "failed" : "agent gone";
  const sent = auto.state?.history.findLast((h) => h.source.linkId === link.id);
  if (sent) return `sent ${formatAge(Date.now() - sent.deliveredAt)} ago`;
  return link.sent ? "queued earlier" : "not sent";
}
