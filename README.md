# herdr-map

A zoomable canvas of every agent in a [herdr](https://herdr.dev) session. Click an agent to focus it in herdr and bring your terminal to the front.

herdr stays the host. herdr-map only reads `herdr api snapshot` and runs focus commands, so workspaces, tabs, panes, the `herdr` CLI, and the tools you open next to an agent (nvim, hunk, tuicr) work as before.

## What it shows

- **Repo groups** built from herdr's worktree metadata. Linked worktrees are tagged. Workspaces outside a repo go under "Other workspaces".
- **Workspaces and tabs.** By default only agent panes are drawn, one full-width row per agent, and tabs without agents are hidden. Turn off **Agent panes only** to see each tab's full split layout, including nvim, hunk, and shell panes. Both toolbar filters are remembered per browser.
- **Agent panes** colored by status (working, blocked, done, idle), with how long the agent has been in that status and the `summary` pane token when a plugin sets one. Other panes show their terminal title, such as `nvim AGENTS.md` or `hunk`.
- **Needs you**: blocked agents first, then finished ones, oldest first.
- **Preview sidebar**: hovering a pane shows its visible screen, cwd, and summary. Pin a pane (Option-click it, or press **Pin**) to keep its preview while you move around the map. A pinned preview loads the last 1,000 lines of scrollback and refreshes every 5 seconds; scrolling up pauses refreshes until you scroll back to the bottom. Drag the sidebar's left edge to resize it.
- **Adaptive zoom**: text grows as you zoom out so names and statuses stay readable, summaries and tab labels drop away, and panes fill with their status color.
- **Your own arrangement**: drag a workspace to move it, or drag a repo box to move all of its workspaces. Drop a workspace away from its repo to detach it; it then shows the repo name as a tag. Positions are saved to a file and survive reloads. From **Layouts**, you can save the arrangement under a name, restore a saved one, or reset to the automatic layout. Reset and Restore save the arrangement they replace as "Previous layout", so either can be undone.
- **Light, dark, or system theme**, picked from the toolbar.
- **Lineage edges** from a `parent` pane token, when present (see below).

Clicking an agent runs `herdr agent focus <pane>`. Clicking any other pane focuses its tab, and clicking a workspace focuses the workspace. On macOS the server then activates the terminal app (Ghostty by default). Typing in the filter box dims non-matching workspaces, and Enter focuses the first matching agent.

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
| `--port`, `--host` | `4747`, `127.0.0.1` | Listen address. The focus endpoint controls herdr, so keep it on loopback unless the network is trusted. |
| `--interval MS` | `1500` | Snapshot poll interval. |
| `--activate APP` | `Ghostty` | macOS app to bring forward after a focus. |
| `--no-activate` | off | Skip app activation. |
| `--layout FILE` | `~/.config/herdr-map/layout.json` | Where the current and named layouts are saved. |

Status ages start when herdr-map first sees a status. Ages that began before the server started are lower bounds and show a trailing `+`.

## Lineage

herdr does not record which pane created another. herdr-map draws an edge from pane A to pane B when B has a `parent=A` pane token. An agent that spawns a sibling can set it right after the split:

```sh
child=$(herdr pane split --current --direction right --no-focus | jq -r .result.pane.pane_id)
herdr pane report-metadata "$child" --source herdr-map --token parent="$HERDR_PANE_ID"
herdr agent start worker --kind claude --pane "$child"
```

herdr drops pane tokens when its server restarts.

## Development

```sh
npm run dev:server   # API on :4747 with --watch
npm run dev:web      # Vite on :5173, proxying /api
npm test
npm run typecheck
```

The server lives in `server/`, the snapshot-to-view-model conversion in `shared/model.ts`, and canvas layout and rendering in `web/`.
