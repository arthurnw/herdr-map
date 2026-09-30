import { useRef } from "react";
import { useTheme } from "next-themes";
import { Bell, BellOff, Monitor, Moon, Network, Search, SlidersHorizontal, Sun } from "lucide-react";
import { toast } from "sonner";
import { STATUSES, type AgentStatus, type Fleet } from "../shared/model.ts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { notificationPermission, playChime, type AlertSettings } from "./alerts.ts";
import { PaletteButton } from "./CommandPalette.tsx";
import { useShortcut } from "./hooks/useShortcut.ts";
import { LayoutMenu, type LayoutMenuProps } from "./LayoutMenu.tsx";
import { AutomationControls } from "./queue.tsx";
import { StatusDot } from "./status.tsx";

interface ToolbarProps {
  fleet?: Fleet;
  connected: boolean;
  error?: string;
  hiddenStatuses: AgentStatus[];
  onToggleStatus: (status: AgentStatus, solo: boolean) => void;
  query: string;
  onQuery: (q: string) => void;
  onSearchEnter: () => void;
  agentsOnly: boolean;
  onAgentsOnly: (v: boolean) => void;
  agentPanesOnly: boolean;
  onAgentPanesOnly: (v: boolean) => void;
  /** Collapses every workspace on the map to its header, or expands them all. */
  onCollapseAll?: (collapsed: boolean) => void;
  layoutMenu: LayoutMenuProps;
  alerts: AlertSettings;
  onAlerts: (patch: Partial<AlertSettings>) => void;
  now: number;
}

export function Toolbar(props: ToolbarProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Network className="size-4 text-muted-foreground" />
        herdr-map
      </div>
      <Separator orientation="vertical" className="h-5!" />
      <StatusFilter fleet={props.fleet} hidden={props.hiddenStatuses} onToggle={props.onToggleStatus} />
      <SearchBox query={props.query} onQuery={props.onQuery} onEnter={props.onSearchEnter} />
      <div className="ml-auto flex items-center gap-1.5">
        <AutomationControls now={props.now} />
        <PaletteButton />
        <ViewMenu {...props} />
        <LayoutMenu {...props.layoutMenu} />
        <AlertsMenu settings={props.alerts} onChange={props.onAlerts} />
        <ThemeMenu />
        <Connection fleet={props.fleet} connected={props.connected} error={props.error} />
      </div>
    </header>
  );
}

function StatusFilter({
  fleet,
  hidden,
  onToggle,
}: {
  fleet?: Fleet;
  hidden: AgentStatus[];
  onToggle: (s: AgentStatus, solo: boolean) => void;
}) {
  // Every status gets a chip, even at zero, so a filter can be set before agents reach it.
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Filter agents by status">
      {STATUSES.map((s) => {
        const off = hidden.includes(s);
        const count = fleet?.counts[s] ?? 0;
        return (
          <Tooltip key={s}>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                aria-pressed={!off}
                onClick={(e) => onToggle(s, e.altKey)}
                className={cn(
                  "h-7 gap-1.5 rounded-full px-2.5 text-xs",
                  count === 0 && !off && "text-muted-foreground",
                  off && "text-muted-foreground opacity-60",
                )}
              >
                <StatusDot status={s} className={cn((off || count === 0) && "opacity-40")} />
                <span className="tabular-nums font-semibold">{count}</span>
                <span className={cn(off && "line-through")}>{s}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {off ? "Show" : "Hide"} {s} agents · <Kbd>⌥</Kbd> click to show only {s}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function SearchBox({ query, onQuery, onEnter }: { query: string; onQuery: (q: string) => void; onEnter: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  // "/" jumps to the filter box from anywhere except another text field.
  useShortcut({ key: "/", description: "Filter workspaces" }, () => input.current?.focus());
  return (
    <div className="relative w-full max-w-sm">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={input}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter();
          if (e.key === "Escape") {
            onQuery("");
            e.currentTarget.blur();
          }
        }}
        placeholder="Filter workspaces, agents, summaries, tags"
        className="h-8 pr-16 pl-8 text-sm"
      />
      <span className="pointer-events-none absolute top-1/2 right-2 flex -translate-y-1/2 gap-1">
        {query ? <Kbd>↵ focus</Kbd> : <Kbd>/</Kbd>}
      </span>
    </div>
  );
}

function ViewMenu({ agentsOnly, onAgentsOnly, agentPanesOnly, onAgentPanesOnly, onCollapseAll }: ToolbarProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5">
          <SlidersHorizontal className="size-3.5" />
          View
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Show</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked={agentPanesOnly} onCheckedChange={onAgentPanesOnly}>
          Only agent panes
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={agentsOnly} onCheckedChange={onAgentsOnly}>
          Only workspaces with agents
        </DropdownMenuCheckboxItem>
        {onCollapseAll && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onCollapseAll(true)}>Collapse all to their headers</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onCollapseAll(false)}>Expand all</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AlertsMenu({ settings, onChange }: { settings: AlertSettings; onChange: (p: Partial<AlertSettings>) => void }) {
  const on = settings.desktop || settings.sound;
  const permission = notificationPermission();

  const setDesktop = async (want: boolean) => {
    if (!want) return onChange({ desktop: false });
    if (permission === "unsupported") return toast.error("This browser doesn't support notifications");
    const result = permission === "default" ? await Notification.requestPermission() : permission;
    if (result === "granted") onChange({ desktop: true });
    else toast.error("Notifications are blocked", { description: "Allow them for this page in your browser's site settings." });
  };

  const test = () => {
    if (settings.sound) playChime("blocked");
    if (settings.desktop && notificationPermission() === "granted") {
      new Notification("herdr-map test", { body: "Notifications are working." });
    }
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Alerts">
              {on ? <Bell className="size-4" /> : <BellOff className="size-4 text-muted-foreground" />}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Alerts {on ? "on" : "off"}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Alert me</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked={settings.desktop} onCheckedChange={(v) => void setDesktop(v)} onSelect={(e) => e.preventDefault()}>
          With a desktop notification
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={settings.sound} onCheckedChange={(v) => onChange({ sound: v })} onSelect={(e) => e.preventDefault()}>
          With a sound
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>When an agent</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked={settings.onBlocked} onCheckedChange={(v) => onChange({ onBlocked: v })} onSelect={(e) => e.preventDefault()}>
          Is blocked on a question
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={settings.onDone} onCheckedChange={(v) => onChange({ onDone: v })} onSelect={(e) => e.preventDefault()}>
          Finishes its work
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={settings.onStuck} onCheckedChange={(v) => onChange({ onStuck: v })} onSelect={(e) => e.preventDefault()}>
          Looks stuck
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!on} onSelect={test}>
          Send a test alert
        </DropdownMenuItem>
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Alerts only fire while this page is in the background.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeMenu() {
  const { theme = "system", setTheme, resolvedTheme } = useTheme();
  const Icon = resolvedTheme === "dark" ? Moon : Sun;
  const options = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Theme">
          <Icon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          {options.map(({ value, label, icon: ItemIcon }) => (
            <DropdownMenuRadioItem key={value} value={value} className="gap-2">
              <ItemIcon className="size-3.5" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Connection({ fleet, connected, error }: { fleet?: Fleet; connected: boolean; error?: string }) {
  const ok = connected && !error;
  const label = !connected ? "Disconnected" : error ? "herdr error" : `herdr ${fleet?.version ?? ""}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", ok ? "bg-status-done" : "bg-destructive")} />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{ok ? "Live updates from herdr" : (error ?? "Reconnecting to herdr-map")}</TooltipContent>
    </Tooltip>
  );
}

