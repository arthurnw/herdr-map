# herdr-map

A zoomable canvas of every agent in a [herdr](https://herdr.dev) session. Click an agent to focus it in herdr and bring your terminal to the front.

herdr stays the host. herdr-map reads `herdr api snapshot` and uses herdr's own commands to focus, prompt, answer, and rename agents and to run plugin actions, so workspaces, tabs, panes, the `herdr` CLI, and the tools you open next to an agent (nvim, hunk, tuicr) work as before.

## What it shows

- **Repo groups** built from herdr's worktree metadata. Linked worktrees are tagged. Workspaces outside a repo go under "Other workspaces".
- **Workspaces and tabs.** By default only agent panes are drawn, one full-width row per agent, and tabs without agents are hidden. Turn off **View → Only agent panes** to see each tab's full split layout, including nvim, hunk, and shell panes. **View → Only workspaces with agents** hides the rest. Both are remembered per browser.
- **Agent panes** colored by status (working, blocked, done, idle). herdr drops `done` to `idle` within seconds once its server counts a finish as seen, so herdr-map keeps an agent `done` from the end of its turn (2.5 s of idle after working) until you focus that pane, in herdr or from herdr-map, as herdr-radar does. Each pane shows how long the agent has been in that status and the `summary` pane token when a plugin sets one. Other panes show their terminal title, such as `nvim AGENTS.md` or `hunk`.
- **Status filter**: click a status chip in the toolbar (for example, `24 idle`) to hide or show agents with that status. Option-click a chip to show only that status, and Option-click it again to show everything. Filtered agents disappear in the agent-panes-only view and fade in the full layout. The **Needs you** list ignores the filter, so blocked agents are never hidden there.
- **Finish markers**: a workspace with finished agents shows a green count on its header, and finished panes are outlined on the minimap, until you focus them.
- **Stuck agents**: every 10 polls (15 s by default) the server reads the screen of each working agent. An agent whose screen hasn't changed for `--stuck-minutes` (spinner lines and ticking timers don't count as changes) shows "stuck 7m" on its card, and one with a rate-limit, usage-limit, or API error message near the bottom of its screen shows "rate limited" or "API error" right away.
- **Context and cost**: agent cards show how full each agent's context window is, as "61% ctx" and a thin bar along the bottom edge that turns amber at 80%. The preview shows the tokens, the window, the model, and cost where the agent records it (Pi does; Claude Code and Codex don't), with a total for the workspace. The numbers come from the agents' own transcripts; see [Context and cost](#context-and-cost).
- **Subagents**: an agent running subagents (Claude Code's Agent tool, Pi with `@tintinweb/pi-subagents`, or Codex's spawned threads) gets a count on its card and a small card per subagent to its right: type or role, task, status (running, done, failed, or stopped where the agent records it), how long it ran, tokens of its latest turn, tool calls, and cost where recorded. Nested subagents (Pi and Codex) are indented under the one that started them. A packed map has no room beside a card, so subagent cards sit under other agents' cards until you select their agent (Option-click it, or select it from Needs you or the palette), which brings them forward. Click a card to read that subagent's transcript in the sidebar: its messages and one line per tool call, newest at the bottom, refreshed while it runs; **Back** returns to the agent's preview. Cards aren't saved in the layout. A running subagent keeps its card; a finished one stays for 3 minutes, or up to 30 while its agent is still working, blocked, or done and not yet looked at. Codex's automatic approval reviews ("guardian" subagents) aren't given cards; a shield on the agent card shows while one runs. See [Subagents and tasks](#subagents-and-tasks).
- **Task progress**: an agent that keeps a todo list (Claude Code's TodoWrite or task tools, Codex's `update_plan`) gets a ring and "3/7" on its card while tasks are left or its turn is on screen, and the preview names the task in progress.
- **Needs you**: blocked agents first, then stuck ones, then finished ones, oldest first. Clicking a row selects that agent: the map pans to it and its preview stays in the sidebar. The terminal button on the row opens it in your terminal instead.
- **Starred agents**: press `s` or the star button in the preview to star the selected agent. Starred agents get a star on their card and are listed under **Starred** at the top of the sidebar whatever their status; `g` moves to the next one. Stars are remembered per browser.
- **Rename agents**: the pencil next to an agent's name in the preview opens an input. Enter renames it with `herdr agent rename`, and Esc cancels. Names follow herdr's rules (up to 32 lowercase letters, digits, `-`, or `_`, starting with a letter, and not used by another agent).
- **Session graph**: when [zoetrope](https://github.com/furkankly/zoetrope)'s herdr plugin is installed and enabled, the preview of a Claude Code or Codex agent whose session herdr knows has a **Session graph** button. It focuses the agent and runs the plugin's `open` action, which draws the session as a live flow graph over the agent's pane (press `q` there to close it). herdr-map checks for the plugin once per page load.
- **Reply from the map**: the preview has a reply box. For an idle or finished agent it sends a prompt (`herdr agent prompt`). For a blocked agent, the dialog's numbered choices appear as buttons that press the matching key (the server re-reads the dialog first and refuses the key if that choice is gone), arrow, Enter, and Esc buttons drive the dialog by hand, and typed text goes into the dialog followed by Enter.
- **Alerts**: the bell menu turns on desktop notifications and a sound for agents that become blocked, finish, or look stuck. They fire only while the page is in the background, and clicking a notification selects that agent. The tab title shows how many agents need you.
- **Command palette**: press `⌘K` (or `Ctrl+K`), or click **Go to** in the toolbar, to search every agent and workspace. Narrow the list with `s:` for status (`s:blocked`), `a:` for agent kind (`a:codex`), `w:` for workspace (`w:auth`), and `t:` for workspace tag (`t:infra`), and add words to match names, workspace labels, tags, and summaries. Enter selects an agent as a Needs you row does, or shows a workspace on the map; `⌘Enter` opens it in the terminal. The **Commands** group lists the keyboard shortcuts and view, theme, and layout toggles, and runs them.
- **Keyboard**: `⌘K` opens the command palette, the arrow keys move the selection to the nearest agent card in that direction (the first press picks the card nearest the middle of the view), `n` / `Shift+n` step through Needs you, `g` steps through starred agents, `s` stars or unstars the selection, `o` or Enter opens the selection in the terminal, `r` jumps to the reply box, `Esc` clears the selection (and the box selection), `/` focuses the filter box, and `⌘Z` / `⇧⌘Z` (`Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y` elsewhere) undo and redo layout changes.
- **Preview sidebar**: hovering a pane shows its visible screen, cwd, and summary. Pin a pane (Option-click it, or press **Pin**) to keep its preview while you move around the map. A pinned preview loads the last 1,000 lines of scrollback and refreshes every 5 seconds; scrolling up pauses refreshes until you scroll back to the bottom. Drag the handle between the map and the sidebar to resize it.
- **Adaptive zoom**: text grows as you zoom out so names and statuses stay readable, summaries and tab labels drop away, and panes fill with their status color.
- **Your own arrangement**: drag a workspace to move it, or drag a repo box to move all of its workspaces. To take a workspace out of its repo box, drag it clear of the box (while you drag, the box stays around the others and a hint says whether the drop takes it out or puts it back), or use **Take out of the … box** in the ⋯ menu on its header. A workspace outside its box still shows its repo, as a tag on the header and before its name when zoomed out; **Put back in the … box** in the same menu returns it. To move several workspaces at once, Shift+drag on empty canvas or on a repo box to draw a selection box; the workspaces it touches get a dashed outline, and dragging any of them moves them all. While workspaces are selected, a bar at the top of the map collapses or expands them, adds a tag to all of them, and takes them out of their repo boxes or puts them back (workspaces taken out together keep their arrangement, and each box keeps at least one workspace). `Esc`, the bar's × button, or a click on empty canvas clears the selection. Positions are saved to a file and survive reloads. From **Layouts**, you can save the arrangement under a name, restore a saved one, or reset to the automatic layout. Reset and Restore save the arrangement they replace as "Previous layout", so either can be undone.
- **Undo and redo**: `⌘Z` undoes the last layout change (a move, taking a workspace out of its box or putting it back, a reset, or a restore) and `⇧⌘Z` redoes it; on other systems use `Ctrl+Z` and `Ctrl+Shift+Z` or `Ctrl+Y`. The server keeps the last 50 steps in the layout file, so they survive reloads and are shared by every open tab. A new change after an undo drops the steps left to redo. Collapsing, colors, tags, and notes aren't undo steps, and in a text field the keys undo typing as usual.
- **Collapse a workspace**: **Collapse to header** (or **View → Collapse all to their headers** / **Expand all**, also in the ⌘K palette) in a workspace's ⋯ menu shrinks it to its header row, which keeps a dot and count for each agent status, and its repo box shrinks with it. Clicking the header still focuses the workspace; **Expand** in the same menu brings its tabs back. Collapsed workspaces are saved in the layout file.
- **Colors**: hover a repo box's name and click the palette button to tint the box with one of eight colors, or pick **No color**. A workspace's ⋯ menu has the same choice under **Color**, which tints its border and header. Colors are saved in the layout file and work in light and dark themes.
- **Tags**: **Add tag…** in a workspace's ⋯ menu opens a small input on its header; Enter adds the tag and Esc cancels. Tags are short lowercase words (letters, digits, `.`, `_`, `-`, up to 24 characters; spaces become `-`) and show as chips on the header. The same menu removes them. The filter box and the command palette match tags, and `t:` in the palette narrows to workspaces with a tag that starts with the value.
- **Sticky notes**: double-click empty canvas, click the note button under the zoom buttons, or run **New note** from the command palette to add a note. Type in it directly (plain text), drag its top bar to move it, drag a corner or edge to resize it, and use the buttons on the bar to pick a color or delete it (a toast offers Undo for a note with text). Notes sit above the map, outside every repo box, and are saved in the layout file. Double-clicking the canvas no longer zooms; use the zoom buttons or the scroll wheel.
- **Agents working together**: drag from the dot on an agent's card to another agent to add a **handoff** (when the first agent finishes a turn, its latest output goes to the second) or a **context link** (the second agent is told once how to read the first). Drag from a note's dot to an agent to send it the note. **Scheduled prompts** send a fixed prompt every N minutes or hours, or daily at a set time, once armed. Everything goes through a queue that waits until the agent is idle, and **Automation on** in the toolbar pauses all of it. See [Automation](#automation).
- **Light, dark, or system theme**, picked from the toolbar.
- **Lineage edges** from a `parent` pane token, when present (see below).

Clicking an agent runs `herdr agent focus <pane>`. Clicking any other pane focuses its tab, and clicking a workspace focuses the workspace. On macOS the server then activates the terminal app (Ghostty by default). Typing in the filter box (press `/` to jump to it) dims workspaces whose names, tags, tabs, and agents don't match, and Enter focuses the first matching agent.

## Requirements

- Node.js 23.6 or newer. The server runs TypeScript directly and has no runtime dependencies.
- herdr 0.9 or newer on the machine that runs the herdr server.
- For remote use, non-interactive SSH to that machine. SSH connection reuse (`ControlMaster auto`) keeps each poll around 0.2 s.

## Run

```sh
npm install
npm run build

# herdr server on this machine
npm start

# herdr server on another machine; run this where your terminal app runs
npm start -- --ssh mini
```

Open http://127.0.0.1:4747.

### Install as an app

herdr-map is a Progressive Web App, so it can run in its own window with its own Dock icon. With the page open:
- **Chrome or Edge:** click the install icon at the right of the address bar, or open the ⋮ menu and choose **Cast, save, and share → Install page as app**.
- **Safari:** choose **File → Add to Dock**.

The app window keeps all the keyboard shortcuts, and desktop notifications come from it. An installed app is tied to the exact address it was installed from, so `127.0.0.1:4747` and `localhost:4747` are separate apps with separate saved settings.

### Run as a background service (macOS)

`scripts/service.sh` installs herdr-map as a launchd user agent that starts at login and restarts if it exits. Server flags pass through:

```sh
scripts/service.sh install --ssh mini
scripts/service.sh status      # or: restart, uninstall
```

Logs go to `~/Library/Logs/herdr-map.log`. The first click that brings your terminal forward may trigger a macOS prompt to let `node` control that app.

`scripts/update.sh` pulls the latest version and does only what the changes need: `npm install` when dependencies changed, a rebuild when the web app changed, and a service restart when the server changed.

| Flag | Default | Meaning |
|---|---|---|
| `--ssh HOST` | unset | Run `herdr` on `HOST` over SSH. |
| `--herdr BIN` | `herdr` | herdr executable, local or on the SSH host. |
| `--port`, `--host` | `4747`, `127.0.0.1` | Listen address. The API can focus panes and type into agents, so keep it on loopback unless the network is trusted. |
| `--interval MS` | `1500` | Snapshot poll interval. |
| `--stuck-minutes N` | `5` | Flag a working agent as stuck after its screen hasn't changed for this long. |
| `--activate APP` | `Ghostty` | macOS app to bring forward after a focus. |
| `--no-activate` | off | Skip app activation. |
| `--layout FILE` | `~/.config/herdr-map/layout.json` | Where the current and named layouts are saved. |
| `--queue FILE` | `queue.json` next to the layout file | Where the prompt queue, its recent deliveries, the pause, and scheduled prompts are saved. |
| `--probe-node BIN` | `node` on the SSH host; this server's Node locally | Node.js 23.6 or newer that runs the context and cost reader where the agents are. |
| `--no-probe` | off | Don't read agent transcripts; cards show no context, cost, subagents, or tasks. |

Status ages start when herdr-map first sees a status. Ages that began before the server started are lower bounds and show a trailing `+`.

## Automation

herdr-map sends nothing to an agent on its own. Every automatic prompt comes from a link you drew, a schedule you armed, or a prompt you queued, and it goes through the queue.

- **The queue** (toolbar **Queue**, with a count of waiting prompts) holds each prompt until its agent is idle or done, then sends it with `herdr agent prompt`. It never sends to a working or blocked agent, sends one prompt per agent at a time, oldest first, and waits at least 5 seconds and one fresh snapshot before that agent's next one. A failed send is retried after 5, 20, and 60 seconds, then marked failed with herdr's error; **Retry** starts over. **Send now** moves a prompt to the front for its agent and lets it through the pause, but still waits for the agent to be idle. A prompt whose pane is gone stays listed as "Agent gone" for an hour. The popover also lists schedules, links, and the last 50 prompts sent, with time and target. **Send when idle**, under **Automation** in an agent's preview, queues a prompt by hand. The queue is saved to `--queue` and survives restarts.
- **Pause**: **Automation on** in the toolbar (or **Pause automation** in the ⌘K palette) turns into an amber **Automation paused**. While paused, nothing leaves the queue except by **Send now**, handoffs still queue their prompts to send after you resume, and scheduled runs that come due are skipped. The pause is saved.
- **Handoff**: drag from the dot on the right edge of an agent's card (it appears on hover) onto another agent's card, and choose **Handoff**. When the first agent finishes a turn (working or blocked, then done, or idle for 2.5 seconds), herdr-map reads its last 120 lines of scrollback (`herdr pane read --source recent`), keeps the last 6,000 characters, and queues them for the second agent with a line naming the first agent, its workspace, and its pane. Each turn hands off once, and a handoff still waiting is replaced by the newer one rather than added. An agent that was already idle when the server started has no turn to hand off. A handoff that would close a loop (A to B while handoffs already lead from B back to A) is refused.
- **Context link**: the same drag, choosing **Context link**. The second agent is sent, once, how to read the first on demand: `herdr agent read <pane> --lines 200`, with the first agent's name and workspace. **Send again** in the link's menu repeats it.
- **Note link**: drag from the dot on a note to an agent. The note's text is queued once, prefaced as a note from you. The bottom of the note lists the agents it went to and whether the prompt is waiting or sent, and offers **Send again** once the text has changed since it was sent. An empty note can't be linked.
- **Scheduled prompts**: in an agent's preview, open **Automation** and choose **Schedule a prompt** (or run **Schedule a prompt for the selected agent** from the palette). Pick every N minutes, every N hours, or daily at HH:MM (the server's time zone). A new schedule does nothing until you **Arm** it, and changing its target, text, or timing disarms it again. A due run only queues the prompt, so it waits until the agent is idle. Runs missed while the machine slept or the service was off are not made up: at most one run is due when it wakes, and the next counts from then. A run is skipped while the previous one is still waiting. The preview shows the next run and what the last one did.
- **Links on the map** are drawn apart from lineage edges: a blue arrow for a handoff, a dashed line for a context link, and a dotted one from a note. The chip on each opens a menu to remove it; the agent's preview and the Queue popover list and remove them too. Removing a link cancels what it had queued. A link whose agent or note is gone isn't drawn but stays saved until you remove it. Links are saved in the layout file.

## Lineage

herdr does not record which pane created another. herdr-map draws an edge from pane A to pane B when B has a `parent=A` pane token. An agent that spawns a sibling can set it right after the split:

```sh
child=$(herdr pane split --current --direction right --no-focus | jq -r .result.pane.pane_id)
herdr pane report-metadata "$child" --source herdr-map --token parent="$HERDR_PANE_ID"
herdr agent start worker --kind claude --pane "$child"
```

herdr drops pane tokens when its server restarts.

## Context and cost

Every 5 seconds the server runs a small reader (`probe/usage.ts`, with `probe/subagents.ts` joined to it) where the agents run: over the same SSH connection as herdr with `--ssh`, locally otherwise. The script is sent on stdin to `node --input-type=module-typescript -` each time, so nothing is installed or kept in sync on the remote.

- **Finding transcripts.** Claude Code: `~/.claude/projects/<cwd>/<session id>.jsonl`. herdr's session ID can be stale, for example after a conversation moves to a background job, so the probe asks herdr (the `--herdr` executable, read-only `pane process-info`) for the pane's Claude Code process and reads its session from `~/.claude/sessions/<pid>.json`, following `parkedJobId` to the background job's entry. It does this when it first sees a pane, then once a minute, or every 30 s while the transcript isn't growing and the agent is working or blocked, and uses herdr's ID when that fails. If neither has a transcript (a conversation moved to the background can leave nothing on disk that links the pane to it), the probe reads the pane's visible screen (read-only `pane read`), picks up to four long lines that aren't prompts, spinners, rules, or footers, and looks for them in the last 512 KB of up to eight candidates: background jobs' sessions and sessions from the pane's git repository modified in the last three days, minus those other panes are on. It takes a transcript only when exactly one candidate has two or more of the lines, or only one has any. The match is kept while the screen stays the same or the transcript grows, and checked again every three minutes otherwise; a failed match is also retried every three minutes, and at most one screen is read per run. It can miss a pane that shows only short lines, tables, or text older than the transcript's last 512 KB, or whose conversation is also in a forked or resumed copy. Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread id>.jsonl`, dated from the thread ID. Pi: the session path herdr reports. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `PI_CODING_AGENT_DIR` on that machine are respected.
- **Context** is the input side of the latest turn, including cache reads and writes. Codex records the model's window, and Pi's comes from Pi's model registry. Claude Code doesn't record one, so herdr-map uses a built-in table: 1M tokens for current Claude models and 200K for Haiku and older ones. Unknown models show tokens without a percentage.
- **Cost** is shown only when the agent records it. Pi records a cost per message; herdr-map adds them up.
- **Cost of reading.** The server keeps each transcript's read offset and sends it back with the next run, so the remote keeps no state and only new bytes are read. Claude Code and Codex transcripts are read from their last 1 MB, and Pi's once in full, since cost is a sum. Transcripts are read while their agent is working and for a minute after its status changes, plus once per agent at startup, and a run reads at most 16 MB. Idle Claude Code agents are also sent once a minute so their session is re-checked; that reads nothing unless the transcript grew.
- **Errors**, such as a missing transcript or a failed SSH connection, go to the server log and the `probeError` field of `/api/fleet`. They never affect the snapshot poll or show as a banner.

## Subagents and tasks

The same reader finds each agent's subagents and todo list in the transcripts it already follows.

- **Claude Code** keeps a subagent in `<session id>/subagents/` beside the session's transcript: `agent-<id>.meta.json` (type, description, and the parent's tool-use ID) and `agent-<id>.jsonl`, its own transcript. A subagent counts as finished when the parent transcript has its result: the Agent tool's result for one that ran in the foreground, or the task notification that names the same tool-use ID for one in the background (`completed`, `failed`, `killed`, or `stopped`, with its tokens, tool calls, and duration). A finished subagent whose transcript grows again was sent another message and counts as running. One that stopped writing before the part of the parent transcript that was read counts as done. Tasks come from the latest TodoWrite list, or from TaskCreate and TaskUpdate calls; a task created before that part shows as "Task N".
- **Pi** with `@tintinweb/pi-subagents`: the parent's session file has each Agent tool call and result (type, description, agent ID, and, for background ones, the `.output` transcript under `/tmp/pi-subagents-<uid>/`) and a `subagents:record` entry when a background subagent ends. Running numbers come from the `.output` file, and subagents it starts are shown nested. Pi has no todo tool of its own, so no task progress.
- **Codex** runs each subagent as a thread with its own rollout, whose first line names the parent thread. The reader checks rollouts changed in the last 30 minutes in today's and yesterday's folders, follows the ones in the agent's tree (children of children too), and skips the history a child copies from its parent. Status comes from the child's own task events. Guardian review threads are counted, not listed. Tasks come from `update_plan` calls.
- **What's read.** Subagent transcripts are followed from saved offsets, like the agents' own, with whatever is left of the 16 MB per run. An agent is read while one of its subagents runs, even when the agent itself is idle, since background subagents outlive their parent's turn. A subagent that never reports finishing is dropped after 30 minutes without writing, and a finished one 30 minutes after it ended.
- **Transcripts** for the sidebar come from `GET /api/subagent?pane=<pane>&id=<subagent>`, which asks the reader for the last 256 KB of a transcript it reported, as text. The browser never sees file paths, and other files can't be requested.

## Development

`npm run test:e2e` runs herdr-map against `test/e2e/herdr-stub.sh`, which serves a made-up snapshot from `test/e2e/fixture.mjs`, records every focus, prompt, key, rename, and plugin action it would have sent, and refuses anything else. It never reaches a real herdr session. The usage probe reads synthetic transcripts from `test/e2e/transcripts/` instead of your own.

The UI uses [shadcn/ui](https://ui.shadcn.com) components (in `web/components/ui`, added with `npx shadcn@latest add <name>`) on Tailwind CSS v4. Canvas node styles and the zoom-adaptive text rules live in `web/canvas.css`.


```sh
npm run dev:server   # API on :4747 with --watch
npm run dev:web      # Vite on :5173, proxying /api
npm test
npm run typecheck
npm run build && npm run test:e2e   # browser checks against a stand-in herdr (needs Google Chrome)
```

The server lives in `server/`, the snapshot-to-view-model conversion in `shared/model.ts`, and canvas layout and rendering in `web/`.
