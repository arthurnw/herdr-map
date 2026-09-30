// Handoff links the user draws between agent cards. They are stored in the layout file
// and drawn as their own edges, apart from the lineage edges in layout.ts.
import { memo, useCallback, useRef, useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  type Connection,
  type Edge,
  type EdgeProps,
  type FinalConnectionState,
  type IsValidConnection,
} from "@xyflow/react";
import { Forward, Trash2 } from "lucide-react";
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
import type { Endpoint, Link, LinkKind } from "../shared/layout-types.ts";
import { agentLabel, useAutomation, type AutomationActions, type AutomationValue } from "./automation.tsx";
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

export type LinkEdgeData = { link: Link };

type Flavor = LinkKind;
const flavorOf = (link: Link): Flavor => link.kind;
const FLAVOR = {
  handoff: { icon: Forward, label: "handoff" },
  context: { icon: Forward, label: "link" },
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
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      data: { link } satisfies LinkEdgeData,
    }));
}

/** What a link does, in a sentence. */
export function describeLink(link: Link, panes: Map<string, Located>): string {
  const to = agentLabel(panes, link.to.id);
  const from = agentLabel(panes, link.from.id);
  return `When ${from} finishes a turn, its latest output goes to ${to}.`;
}

export const LinkEdge = memo((props: EdgeProps) => {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data } = props;
  const auto = useAutomation();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const { link } = data as LinkEdgeData;
  const flavor = flavorOf(link);
  const { icon: Icon, label } = FLAVOR[flavor];
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className="link-path" />
      <EdgeLabelRenderer>
        <div
          className="link-label nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
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
    (c) => c.source !== c.target && c.targetHandle === LINK_IN && isAgent(c.target) && isAgent(c.source),
    [isAgent],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, _state: FinalConnectionState) => {
      setLinking(false);
      const c = dropped.current;
      dropped.current = undefined;
      if (!c || !actions) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      setChoice({ from: c.source, to: c.target, x: point.clientX, y: point.clientY });
    },
    [actions],
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

