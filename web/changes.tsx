// The preview's Changes tab: the workspace repo's changed files with inline diffs, and its PR.
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileDiff as FileDiffIcon, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseDiff, type ChangedFile, type ChangeScope, type ChangesSummary, type FileDiff } from "../shared/changes.ts";
import { errorMessage } from "../shared/errors.ts";
import { prChecks, prStatus, type PullRequest } from "../shared/git.ts";
import type { FleetWorkspace } from "../shared/model.ts";
import { CI_ICON, reviewText } from "./git.tsx";
import { HunkContext, runAction } from "./review.tsx";
import { safeStorage } from "./state.ts";
import "./changes.css";

export type PreviewTab = "screen" | "changes";
const TAB_KEY = "herdr-map.preview-tab";

/** The preview's tab, remembered per browser. */
export function usePreviewTab(): [PreviewTab, (tab: PreviewTab) => void] {
  const [tab, setTab] = useState<PreviewTab>(() => (safeStorage.getItem(TAB_KEY) === "changes" ? "changes" : "screen"));
  const set = useCallback((next: PreviewTab) => {
    setTab(next);
    safeStorage.setItem(TAB_KEY, next);
  }, []);
  return [tab, set];
}

const TABS: { id: PreviewTab; label: string }[] = [
  { id: "screen", label: "Screen" },
  { id: "changes", label: "Changes" },
];

export function PreviewTabs({ tab, onChange }: { tab: PreviewTab; onChange: (tab: PreviewTab) => void }) {
  return (
    <div className="preview-tabs" role="tablist" aria-label="Preview">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          className="preview-tab"
          title={`${t.label} (c)`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// Changes are re-read this often while the tab is shown.
const CHANGES_REFRESH_MS = 15_000;
// A hover preview waits this long, so sweeping the pointer across the map doesn't read every repo.
const HOVER_DELAY_MS = 250;

async function getJson(url: string) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

const changesUrl = (ws: string, scope: ChangeScope, path?: string) =>
  `/api/changes${path === undefined ? "" : "/diff"}?${new URLSearchParams({ ws, scope, ...(path !== undefined && { path }) })}`;

interface Loaded {
  scope: ChangeScope;
  summary?: ChangesSummary;
  error?: string;
}

/** Reads the changes now, on refresh, and every 15 seconds while the page is visible. */
function useChanges(ws: string, scope: ChangeScope, enabled: boolean, delayMs: number, nonce: number): Loaded | undefined {
  const [loaded, setLoaded] = useState<Loaded>();
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      if (!document.hidden) {
        try {
          const summary: ChangesSummary = await getJson(changesUrl(ws, scope));
          if (!stopped) setLoaded({ scope, summary });
        } catch (err) {
          if (!stopped) setLoaded({ scope, error: errorMessage(err) });
        }
      }
      if (!stopped) timer = setTimeout(tick, CHANGES_REFRESH_MS);
    };
    timer = setTimeout(tick, delayMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [ws, scope, enabled, delayMs, nonce]);
  return loaded?.scope === scope ? loaded : undefined;
}

const STATUS_TITLE: Record<ChangedFile["status"], string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  "?": "Untracked",
  U: "Unmerged",
};

function splitPath(path: string): [string, string] {
  const slash = path.lastIndexOf("/", path.length - 2);
  return slash < 0 ? ["", path] : [path.slice(0, slash + 1), path.slice(slash + 1)];
}

function DiffLines({ text }: { text: string }) {
  const rows = useMemo(() => parseDiff(text), [text]);
  if (rows.length === 0) return <p className="changes-note">No line changes.</p>;
  return (
    <div className="diff-scroll">
      <div className="diff">
      {rows.map((r, i) =>
        r.kind === "hunk" || r.kind === "note" ? (
          <div key={i} className={`diff-row diff-${r.kind}`}>
            <span className="diff-no" />
            <span className="diff-no" />
            <span className="diff-text">{r.text}</span>
          </div>
        ) : (
          <div key={i} className={`diff-row diff-${r.kind}`}>
            <span className="diff-no">{r.old}</span>
            <span className="diff-no">{r.new}</span>
            <span className="diff-text">
              <span className="diff-sign" aria-hidden>
                {r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}
              </span>
              {r.text}
            </span>
          </div>
        ),
      )}
      </div>
    </div>
  );
}

function FileDiffView({ ws, scope, file, version }: { ws: string; scope: ChangeScope; file: ChangedFile; version: string }) {
  const [diff, setDiff] = useState<FileDiff>();
  useEffect(() => {
    let live = true;
    getJson(changesUrl(ws, scope, file.path))
      .then((d: FileDiff) => live && setDiff(d))
      .catch((err) => live && setDiff({ path: file.path, text: "", error: errorMessage(err) }));
    return () => {
      live = false;
    };
  }, [ws, scope, file.path, version]);
  if (!diff) return <p className="changes-note">Loading diff…</p>;
  if (diff.error) return <p className="changes-note changes-error">{diff.error}</p>;
  if (diff.binary) return <p className="changes-note">Binary file</p>;
  return (
    <>
      {diff.text && <DiffLines text={diff.text} />}
      {diff.note && <p className="changes-note">{diff.note}</p>}
      {diff.truncated && <p className="changes-note">Diff truncated.</p>}
    </>
  );
}

function FileRow({ ws, scope, file, open, nonce, onToggle }: { ws: string; scope: ChangeScope; file: ChangedFile; open: boolean; nonce: number; onToggle: () => void }) {
  const [dir, name] = splitPath(file.path);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="changes-file" data-path={file.path}>
      <button
        type="button"
        className="changes-file-row"
        aria-expanded={open}
        title={`${STATUS_TITLE[file.status]}: ${file.from ? `${file.from} → ` : ""}${file.path}`}
        onClick={onToggle}
      >
        <Chevron className="changes-chevron" aria-hidden />
        <span className={`changes-status status-${file.status === "?" ? "untracked" : file.status}`} aria-label={STATUS_TITLE[file.status]}>
          {file.status}
        </span>
        <span className="changes-path">
          {dir && <span className="changes-dir">{dir}</span>}
          <span className="changes-name">{name}</span>
        </span>
        {file.binary ? (
          <span className="changes-counts changes-binary">binary</span>
        ) : (
          file.adds !== undefined && (
            <span className="changes-counts">
              <span className="changes-adds">+{file.adds}</span>
              <span className="changes-dels">−{file.dels ?? 0}</span>
            </span>
          )
        )}
      </button>
      {open && <FileDiffView ws={ws} scope={scope} file={file} version={`${file.status}:${file.adds}:${file.dels}:${nonce}`} />}
    </li>
  );
}

const PR_STATE: Record<ReturnType<typeof prStatus>, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };

function CheckNames({ names, state }: { names?: string[]; state: "fail" | "pending" }) {
  if (!names?.length) return null;
  const Icon = CI_ICON[state];
  return (
    <ul className="changes-checks" aria-label={state === "fail" ? "Failing checks" : "Pending checks"}>
      {names.map((n) => (
        <li key={n}>
          <Icon className={`git-ci git-ci-${state}`} aria-hidden />
          {n}
        </li>
      ))}
    </ul>
  );
}

function PrSection({ pr }: { pr: PullRequest }) {
  const status = prStatus(pr);
  const ci = prChecks(pr);
  const c = pr.checks;
  const counts = [c.passed && `${c.passed} passed`, c.failed && `${c.failed} failed`, c.pending && `${c.pending} pending`].filter(Boolean).join(", ");
  return (
    <section className="changes-pr" aria-label="Pull request">
      <div className="changes-pr-head">
        <a href={pr.url} target="_blank" rel="noreferrer" className="changes-pr-link">
          #{pr.number} <span className="changes-pr-title">{pr.title}</span>
        </a>
      </div>
      <div className="changes-pr-meta">
        <span className={`changes-pr-state pr-${status}`}>{PR_STATE[status]}</span>
        {pr.review && <span>{reviewText(pr.review)}</span>}
        <span>{ci === "none" && !counts ? "no checks" : `checks: ${counts}`}</span>
      </div>
      {pr.state === "open" && (
        <>
          <CheckNames names={c.failing} state="fail" />
          <CheckNames names={c.pendingNames} state="pending" />
        </>
      )}
    </section>
  );
}

function SummaryLine({ summary }: { summary: ChangesSummary }) {
  const n = summary.files.length + (summary.more ?? 0);
  return (
    <div className="changes-summary" aria-label="Changes summary">
      <span>
        {n} file{n === 1 ? "" : "s"}
      </span>
      {n > 0 && (
        <>
          <span className="changes-adds">+{summary.adds}</span>
          <span className="changes-dels">−{summary.dels}</span>
        </>
      )}
      <span className="changes-branch" title={summary.root}>
        {summary.branch ?? (summary.head ? `detached at ${summary.head}` : "no commits")}
      </span>
      {summary.upstream && (
        <span title={`${summary.ahead ?? 0} ahead, ${summary.behind ?? 0} behind ${summary.upstream}`}>
          ↑{summary.ahead ?? 0} ↓{summary.behind ?? 0}
        </span>
      )}
      {summary.base && (
        <span>
          {summary.commits ?? 0} commit{summary.commits === 1 ? "" : "s"} since {summary.base}
        </span>
      )}
    </div>
  );
}

const SCOPES: { id: ChangeScope; label: string; title: string }[] = [
  { id: "uncommitted", label: "Uncommitted", title: "The working tree and index against HEAD, with untracked files" },
  { id: "branch", label: "Branch", title: "Everything since the branch left the default branch, committed or not" },
];

interface Props {
  workspace: FleetWorkspace;
  /** The previewed pane's ID when it's an agent, for the hunk plugin's review action. */
  agentPane?: string;
  pinned: boolean;
}

/** Shown only while the Changes tab is open; mount it per workspace so the scope starts at its default. */
export function ChangesPanel({ workspace, agentPane, pinned }: Props) {
  const git = workspace.git;
  const [scope, setScope] = useState<ChangeScope>(() => (git && git.dirty > 0 ? "uncommitted" : "branch"));
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [nonce, setNonce] = useState(0);
  const { plugin } = useContext(HunkContext);
  const loaded = useChanges(workspace.id, scope, !!git, pinned || nonce > 0 ? 0 : HOVER_DELAY_MS, nonce);

  if (!git) return <p className="changes-empty">Not a git repository</p>;
  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const summary = loaded?.summary;
  return (
    <section className="changes" aria-label="Changes">
      <div className="changes-toolbar">
        <div className="changes-scopes" role="radiogroup" aria-label="Compare">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={scope === s.id}
              className="changes-scope"
              title={s.title}
              onClick={() => setScope(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-1">
          {plugin && agentPane && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              title="Open or refresh a hunk review of this agent's worktree, with the plugin's review action"
              onClick={() => void runAction(agentPane, "review", "open the review")}
            >
              <FileDiffIcon className="size-3" />
              Open in hunk
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-6" aria-label="Refresh changes" title="Refresh" onClick={() => setNonce((n) => n + 1)}>
            <RefreshCw className="size-3.5" />
          </Button>
        </span>
      </div>
      {git.pr && <PrSection pr={git.pr} />}
      {!loaded ? (
        <p className="changes-empty">Loading changes…</p>
      ) : loaded.error ? (
        <p className="changes-empty changes-error">{loaded.error}</p>
      ) : summary && summary.files.length === 0 ? (
        <>
          <SummaryLine summary={summary} />
          <p className="changes-empty">No changes</p>
        </>
      ) : (
        summary && (
          <>
            <SummaryLine summary={summary} />
            <ul className="changes-files" aria-label="Changed files">
              {summary.files.map((f) => (
                <FileRow key={f.path} ws={workspace.id} scope={scope} file={f} open={open.has(f.path)} nonce={nonce} onToggle={() => toggle(f.path)} />
              ))}
            </ul>
            {!!summary.more && <p className="changes-note">{summary.more} more files aren't listed.</p>}
          </>
        )
      )}
    </section>
  );
}
