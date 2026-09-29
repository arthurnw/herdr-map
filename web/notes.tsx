// Sticky notes: free text on the canvas, saved in the layout file. Notes are top-level
// nodes outside every repo box; their moves and resizes never touch workspace positions.
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { NodeResizer, useReactFlow, type Node, type NodeChange, type NodeProps, type OnNodeDrag } from "@xyflow/react";
import { Palette, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Note } from "../shared/layout-types.ts";
import { isColor, NOTE_DEFAULT, NOTE_MAX, NOTE_MIN, NOTE_TEXT_MAX, type NotePatch } from "../shared/organize.ts";
import { ColorItems, stop, tintClass } from "./organize.tsx";

export type NoteData = { note: Note; autoFocus: boolean };

interface NoteActionsValue {
  /** Changes a note on screen and saves it, after `delay` ms of quiet when set. */
  edit(id: string, patch: NotePatch, delay?: number): void;
  /** Sends a delayed save now. */
  flush(id: string): void;
  remove(id: string): void;
}

const NoteActions = createContext<NoteActionsValue | undefined>(undefined);
export const NoteActionsProvider = NoteActions.Provider;

const NODE_PREFIX = "note:";
const isNoteChange = (c: NodeChange) => "id" in c && c.id.startsWith(NODE_PREFIX);

function applyLocal(note: Note, patch: NotePatch): Note {
  const { color, ...rest } = patch;
  const next: Note = { ...note, ...rest };
  if (color) next.color = color;
  if (color === null) delete next.color;
  return next;
}

async function send(path: string, method: string, body?: unknown, keepalive = false) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

const notePath = (id: string) => `/api/notes/${encodeURIComponent(id)}`;

interface LayoutHandlers {
  onNodesChange: (changes: NodeChange[]) => void;
  onNodeDragStart: OnNodeDrag;
  onNodeDragStop: OnNodeDrag;
}

/** The notes as canvas nodes, the actions their components call, and ways to add one. */
export function useNotes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [created, setCreated] = useState<string>();
  const { screenToFlowPosition } = useReactFlow();
  const latest = useRef(notes);
  latest.current = notes;
  const pending = useRef(new Map<string, { patch: NotePatch; timer?: ReturnType<typeof setTimeout> }>());

  useEffect(() => {
    fetch("/api/notes")
      .then((res) => (res.ok ? res.json() : []))
      .then((list: Note[]) => setNotes(list))
      .catch(() => {});
  }, []);

  const flush = useCallback((id: string, keepalive = false) => {
    const entry = pending.current.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.current.delete(id);
    send(notePath(id), "PATCH", entry.patch, keepalive).catch((err: Error) =>
      toast.error("Couldn't save the note", { description: err.message }),
    );
  }, []);

  const edit = useCallback(
    (id: string, patch: NotePatch, delay = 0) => {
      setNotes((prev) => prev.map((n) => (n.id === id ? applyLocal(n, patch) : n)));
      const entry = pending.current.get(id) ?? { patch: {} };
      entry.patch = { ...entry.patch, ...patch };
      clearTimeout(entry.timer);
      pending.current.set(id, entry);
      if (delay > 0) entry.timer = setTimeout(() => flush(id), delay);
      else flush(id);
    },
    [flush],
  );

  // Text typed just before the page closes would otherwise wait on a timer that never fires.
  useEffect(() => {
    const onHide = () => {
      for (const id of [...pending.current.keys()]) flush(id, true);
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [flush]);

  const create = useCallback(async (fields: NotePatch & { x: number; y: number }) => {
    try {
      const note: Note = await send("/api/notes", "POST", {
        w: NOTE_DEFAULT.w,
        h: NOTE_DEFAULT.h,
        color: "yellow",
        ...fields,
        x: Math.round(fields.x),
        y: Math.round(fields.y),
      });
      setNotes((prev) => [...prev, note]);
      setCreated(note.id);
    } catch (err) {
      toast.error("Couldn't add a note", { description: (err as Error).message });
    }
  }, []);

  const remove = useCallback(
    (id: string) => {
      const note = latest.current.find((n) => n.id === id);
      clearTimeout(pending.current.get(id)?.timer);
      pending.current.delete(id);
      setNotes((prev) => prev.filter((n) => n.id !== id));
      send(notePath(id), "DELETE").catch((err: Error) => toast.error("Couldn't delete the note", { description: err.message }));
      if (note?.text.trim()) {
        const { x, y, w, h, text, color } = note;
        toast("Note deleted", { action: { label: "Undo", onClick: () => void create({ x, y, w, h, text, color: isColor(color) ? color : null }) } });
      }
    },
    [create],
  );

  const actions = useMemo(() => ({ edit, flush, remove }), [edit, flush, remove]);

  const nodes = useMemo(
    () =>
      notes.map((n): Node => {
        const w = n.w ?? NOTE_DEFAULT.w;
        const h = n.h ?? NOTE_DEFAULT.h;
        return {
          id: NODE_PREFIX + n.id,
          type: "note",
          position: { x: n.x, y: n.y },
          width: w,
          height: h,
          style: { width: w, height: h },
          // Above workspaces, their panes, and the zoomed-out labels.
          zIndex: 2000,
          dragHandle: ".note-bar",
          selectable: false,
          data: { note: n, autoFocus: n.id === created } satisfies NoteData,
        };
      }),
    [notes, created],
  );

  /** Adds a note centered on the visible canvas. */
  const createInView = useCallback(() => {
    const r = document.querySelector(".canvas .react-flow")?.getBoundingClientRect();
    const c = r ? screenToFlowPosition({ x: r.x + r.width / 2, y: r.y + r.height / 2 }) : { x: 0, y: 0 };
    void create({ x: c.x - NOTE_DEFAULT.w / 2, y: c.y - NOTE_DEFAULT.h / 2 });
  }, [create, screenToFlowPosition]);

  /** Double-clicking empty canvas adds a note there. */
  const onCanvasDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest(".react-flow__pane") || target.closest(".react-flow__node")) return;
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      void create({ x: p.x - 24, y: p.y - 14 });
    },
    [create, screenToFlowPosition],
  );

  /** Wraps the workspace drag handlers so note moves and resizes go to the notes instead. */
  const withNotes = (layout: LayoutHandlers): LayoutHandlers => ({
    onNodesChange: (changes) => {
      const mine = changes.filter(isNoteChange);
      if (mine.length > 0) {
        setNotes((prev) =>
          prev.map((n) => {
            let next = n;
            for (const c of mine) {
              if (c.type === "position" && c.id === NODE_PREFIX + n.id && c.position) {
                next = { ...next, x: c.position.x, y: c.position.y };
              }
              // Only resizer changes; React Flow's own measurements report the size we set.
              if (c.type === "dimensions" && c.id === NODE_PREFIX + n.id && c.dimensions && c.resizing !== undefined) {
                next = { ...next, w: c.dimensions.width, h: c.dimensions.height };
              }
            }
            return next;
          }),
        );
      }
      const rest = changes.filter((c) => !isNoteChange(c));
      if (rest.length > 0) layout.onNodesChange(rest);
    },
    onNodeDragStart: (event, node, dragged) => {
      if (node.type !== "note") layout.onNodeDragStart(event, node, dragged);
    },
    onNodeDragStop: (event, node, dragged) => {
      if (node.type !== "note") return layout.onNodeDragStop(event, node, dragged);
      const { note } = node.data as NoteData;
      edit(note.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) });
    },
  });

  return { nodes, actions, createInView, onCanvasDoubleClick, withNotes };
}

export const NoteNode = memo(({ data }: NodeProps) => {
  const { note, autoFocus } = data as NoteData;
  const actions = useContext(NoteActions);
  const text = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) text.current?.focus();
  }, [autoFocus]);

  if (!actions) return null;
  return (
    <div className={`note ${tintClass(note.color)}`}>
      <NodeResizer
        minWidth={NOTE_MIN.w}
        minHeight={NOTE_MIN.h}
        maxWidth={NOTE_MAX}
        maxHeight={NOTE_MAX}
        handleClassName="note-handle"
        lineClassName="note-line"
        onResizeEnd={(_, p) =>
          actions.edit(note.id, { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) })
        }
      />
      <div className="note-bar" title="Drag to move">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="note-button nodrag nopan" aria-label="Note color" onClick={stop} onPointerDown={stop}>
              <Palette aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onClick={stop} onPointerDown={stop}>
            <ColorItems value={note.color} onPick={(color) => actions.edit(note.id, { color })} />
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          className="note-button nodrag nopan"
          aria-label="Delete note"
          onClick={(e) => {
            stop(e);
            actions.remove(note.id);
          }}
        >
          <Trash2 aria-hidden />
        </button>
      </div>
      <textarea
        ref={text}
        className="note-text nodrag nopan nowheel"
        aria-label="Note text"
        placeholder="Write a note…"
        value={note.text}
        maxLength={NOTE_TEXT_MAX}
        onChange={(e) => actions.edit(note.id, { text: e.target.value }, 600)}
        onBlur={() => actions.flush(note.id)}
      />
    </div>
  );
});
