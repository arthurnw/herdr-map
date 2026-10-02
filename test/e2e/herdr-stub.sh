#!/bin/sh
# Stand-in for the herdr CLI in end-to-end tests. It serves a fixture snapshot and
# screens, records every command that would change something, and refuses the rest,
# so a test can never reach a real herdr session.
#
# Reads from $HERDR_STUB_DIR: snapshot.json, screens/<pane id with : as _>.txt (or .ansi, for a
# read with --format ansi; the plain screen otherwise), process-info/<pane id with : as _>.json.
# Appends input commands (focus, prompt, keys, text, rename, plugin actions, plugin pane focus) to $HERDR_STUB_DIR/actions.log,
# and screen reads to $HERDR_STUB_DIR/reads.log.
set -eu
dir="${HERDR_STUB_DIR:?HERDR_STUB_DIR is not set}"

case "$1 ${2:-}" in
  "api snapshot")
    cat "$dir/snapshot.json"
    ;;
  "pane read")
    printf '%s\n' "$*" >>"$dir/reads.log"
    screen="$dir/screens/$(printf '%s' "$3" | tr ':' '_')"
    case " $* " in
      *" --format ansi "*) [ -f "$screen.ansi" ] && screen="$screen.ansi" || screen="$screen.txt" ;;
      *) screen="$screen.txt" ;;
    esac
    if [ -f "$screen" ]; then cat "$screen"; else printf 'screen of %s\n$ ' "$3"; fi
    ;;
  "pane process-info")
    # `herdr pane process-info --pane <id>`; a pane without a file isn't found, as herdr reports it.
    info="$dir/process-info/$(printf '%s' "${4:-}" | tr ':' '_').json"
    if [ -f "$info" ]; then cat "$info"; else printf '{"error":{"code":"pane_not_found","message":"pane not found"},"id":"cli:pane:process_info"}\n'; exit 1; fi
    ;;
  "agent rename")
    # A check can make herdr refuse a rename by writing the error to rename-error.
    if [ -f "$dir/rename-error" ]; then cat "$dir/rename-error" >&2; exit 1; fi
    printf '%s\n' "$*" >>"$dir/actions.log"
    printf '{"ok":true}\n'
    ;;
  "plugin list")
    # A check can install plugins by writing a `herdr plugin list --json` result to plugins.json.
    if [ -f "$dir/plugins.json" ]; then cat "$dir/plugins.json"; else printf '{"result":{"plugins":[],"type":"plugin_list"}}\n'; fi
    ;;
  "plugin pane")
    # Only focusing a plugin's pane; opening and closing them is refused.
    [ "${3:-}" = "focus" ] || { printf 'herdr-stub: refusing unexpected command: %s\n' "$*" >&2; exit 1; }
    printf '%s\n' "$*" >>"$dir/actions.log"
    printf '{"ok":true}\n'
    ;;
  "agent focus" | "tab focus" | "workspace focus" | "agent prompt" | "agent send-keys" | "pane send-text" | "plugin action")
    printf '%s\n' "$*" >>"$dir/actions.log"
    printf '{"ok":true}\n'
    ;;
  *)
    printf 'herdr-stub: refusing unexpected command: %s\n' "$*" >&2
    exit 1
    ;;
esac
