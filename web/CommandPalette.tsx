import { useContext, useEffect, useMemo, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { useTheme } from "next-themes";
import { Check, Folder, SquareArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { STATUSES, type Fleet, type FleetWorkspace } from "../shared/model.ts";
import { activeRegistrations, useShortcut } from "./hooks/useShortcut.ts";
import { PREVIOUS, saveNamed, type LayoutMenuProps } from "./LayoutMenu.tsx";
import { agentAge, NowContext } from "./nodes.tsx";
import { agentMatches, commandMatches, parseQuery, shortcutLabel, workspaceItemMatches } from "./palette.ts";
import { isEnabled } from "./shortcuts.ts";
import { indexPanes, type FocusTarget, type Located } from "./state.ts";
import { KIND_LABEL, StatusDot } from "./status.tsx";

const OPEN_EVENT = "herdr-map:open-palette";
const PALETTE_SHORTCUT = "Open command palette";
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl ";

interface Props {
  fleet?: Fleet;
  /** Selects an agent on the map, as a Needs you row does. */
  onSelect: (paneId: string) => void;
  /** Opens an agent in the terminal. */
  onOpen: (l: Located) => void;
  onFocus: (target: FocusTarget) => void;
  agentsOnly: boolean;
  onAgentsOnly: (v: boolean) => void;
  agentPanesOnly: boolean;
  onAgentPanesOnly: (v: boolean) => void;
  layoutMenu: LayoutMenuProps;
}

interface Action {
  value: string;
  label: string;
  keys?: string[];
  checked?: boolean;
  disabled?: boolean;
  run: () => void;
}

/** The toolbar button that opens the palette. */
export function PaletteButton() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5"
          aria-label="Command palette"
          onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
        >
          <SquareArrowRight className="size-3.5" />
          Go to
          <Kbd>{MOD}K</Kbd>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Jump to an agent or run a command</TooltipContent>
    </Tooltip>
  );
}

/** Groups the mounted keyboard shortcuts by description, so `o` and Enter share a row. */
function shortcutActions(): Action[] {
  const byDescription = new Map<string, Action & { enabled: boolean }>();
  for (const r of activeRegistrations()) {
    const { description } = r.binding;
    if (description === PALETTE_SHORTCUT) continue;
    const enabled = isEnabled(r.binding);
    const entry = byDescription.get(description);
    if (!entry) {
      byDescription.set(description, {
        value: `key:${description}`,
        label: description,
        keys: [shortcutLabel(r.binding)],
        enabled,
        run: () => r.handler(),
      });
    } else {
      entry.keys!.push(shortcutLabel(r.binding));
      if (enabled && !entry.enabled) Object.assign(entry, { enabled, run: () => r.handler() });
    }
  }
  return [...byDescription.values()].map(({ enabled, ...a }) => ({ ...a, disabled: !enabled }));
}

export function CommandPalette(props: Props) {
  const { fleet, onSelect, onOpen, onFocus, layoutMenu } = props;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [value, setValue] = useState("");
  const now = useContext(NowContext);
  const { theme = "system", setTheme } = useTheme();
  const { fitView, getInternalNode } = useReactFlow();

  useShortcut({ key: "k", meta: true, description: PALETTE_SHORTCUT }, () => setOpen((o) => !o));
  useShortcut({ key: "k", ctrl: true, description: PALETTE_SHORTCUT }, () => setOpen((o) => !o));

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const query = useMemo(() => parseQuery(search), [search]);
  const panes = useMemo(() => indexPanes(fleet), [fleet]);

  // Blocked agents first, then finished ones, then the rest; the longest-waiting first within each.
  const agents = useMemo(
    () =>
      [...panes.values()]
        .filter((l) => agentMatches(l, query))
        .sort(
          (a, b) =>
            STATUSES.indexOf(a.pane.agent!.status) - STATUSES.indexOf(b.pane.agent!.status) ||
            a.pane.agent!.since - b.pane.agent!.since,
        ),
    [panes, query],
  );

  const workspaces = useMemo(
    () =>
      (fleet?.groups ?? []).flatMap((g) =>
        g.workspaces.filter((ws) => workspaceItemMatches(ws, g.label, query)).map((ws) => ({ ws, groupLabel: g.label })),
      ),
    [fleet, query],
  );

  const resetLayout = async () => {
    try {
      if (layoutMenu.isCustom) await saveNamed(PREVIOUS, layoutMenu.currentPositions());
      layoutMenu.onApply({});
      toast.success("Reset to the automatic layout");
    } catch (err) {
      toast.error("Layout change failed", { description: (err as Error).message });
    }
  };

  // Read on every render while open, because the mounted shortcuts and their enabled
  // state live outside React.
  const commands: Action[] = open
    ? [
        ...shortcutActions(),
        {
          value: "view:agent-panes",
          label: "Show only agent panes",
          checked: props.agentPanesOnly,
          run: () => props.onAgentPanesOnly(!props.agentPanesOnly),
        },
        {
          value: "view:agents-only",
          label: "Show only workspaces with agents",
          checked: props.agentsOnly,
          run: () => props.onAgentsOnly(!props.agentsOnly),
        },
        { value: "view:fit", label: "Fit everything on screen", run: () => void fitView({ padding: 0.05, duration: 300 }) },
        {
          value: "layout:reset",
          label: "Reset to automatic layout",
          disabled: !layoutMenu.isCustom,
          run: () => void resetLayout(),
        },
        ...(["light", "dark", "system"] as const).map((t) => ({
          value: `theme:${t}`,
          label: `${t[0].toUpperCase()}${t.slice(1)} theme`,
          checked: theme === t,
          run: () => setTheme(t),
        })),
      ].filter((a) => commandMatches(a.label, query))
    : [];

  // Close first so the dialog releases focus before the action moves it.
  const choose = (action: () => void) => {
    setOpen(false);
    setTimeout(action, 0);
  };

  const showWorkspace = (ws: FleetWorkspace) => {
    const nodeId = `ws:${ws.id}`;
    // A workspace the View options hide can still be opened in the terminal.
    if (!getInternalNode(nodeId)) return onFocus({ kind: "workspace", id: ws.id });
    void fitView({ nodes: [{ id: nodeId }], padding: 0.2, maxZoom: 1.2, duration: 350 });
  };

  const openInTerminal = (v: string) => {
    if (v.startsWith("agent:")) {
      const l = panes.get(v.slice("agent:".length));
      if (l) choose(() => onOpen(l));
    } else if (v.startsWith("ws:")) {
      choose(() => onFocus({ kind: "workspace", id: v.slice("ws:".length) }));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !value.startsWith("cmd:")) {
      e.preventDefault();
      openInTerminal(value);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="top-[20%] translate-y-0 overflow-hidden p-0 sm:max-w-2xl"
        showCloseButton={false}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Jump to an agent or workspace, or run a command.</DialogDescription>
        <Command
          shouldFilter={false}
          value={value}
          onValueChange={setValue}
          onKeyDown={onKeyDown}
          className="**:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0"
        >
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder="Agents, workspaces, commands · s:blocked a:codex w:api"
          />
          <CommandList className="max-h-[min(60vh,480px)]">
            <CommandEmpty>No matches.</CommandEmpty>
            {agents.length > 0 && (
              <CommandGroup heading="Agents">
                {agents.map((l) => {
                  const agent = l.pane.agent!;
                  const kind = KIND_LABEL[agent.kind] ?? agent.kind;
                  return (
                    <CommandItem key={l.pane.id} value={`agent:${l.pane.id}`} onSelect={() => choose(() => onSelect(l.pane.id))}>
                      <StatusDot status={agent.status} />
                      <span className="shrink-0 font-medium">{agent.name ?? kind}</span>
                      {agent.name && <span className="shrink-0 text-xs text-muted-foreground">{kind}</span>}
                      <span className="shrink-0 text-muted-foreground">{l.workspace.label}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{agent.summary}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {agent.status} · {agentAge(agent, now)}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {workspaces.length > 0 && (
              <CommandGroup heading="Workspaces">
                {workspaces.map(({ ws, groupLabel }) => (
                  <CommandItem key={ws.id} value={`ws:${ws.id}`} onSelect={() => choose(() => showWorkspace(ws))}>
                    <Folder />
                    <span className="text-xs tabular-nums text-muted-foreground">{ws.number}</span>
                    <span className="font-medium">{ws.label}</span>
                    {groupLabel !== ws.label && <span className="text-muted-foreground">{groupLabel}</span>}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {ws.agentCount ? `${ws.agentCount} agent${ws.agentCount > 1 ? "s" : ""}` : ""}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {commands.length > 0 && (
              <CommandGroup heading="Commands">
                {commands.map((a) => (
                  <CommandItem
                    key={a.value}
                    value={`cmd:${a.value}`}
                    disabled={a.disabled}
                    onSelect={() => choose(a.run)}
                  >
                    <Check className={a.checked ? "" : "invisible"} />
                    <span>{a.label}</span>
                    {a.keys && (
                      <span className="ml-auto flex gap-1">
                        {a.keys.map((k) => (
                          <Kbd key={k}>{k}</Kbd>
                        ))}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
            <span>
              <Kbd>↵</Kbd> select
            </span>
            <span>
              <Kbd>{MOD}↵</Kbd> open in terminal
            </span>
            <span className="ml-auto">
              <Kbd>s:</Kbd> status · <Kbd>a:</Kbd> agent kind · <Kbd>w:</Kbd> workspace
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
