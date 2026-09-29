#!/bin/sh
# Stand-in for the herdr CLI in end-to-end tests. It serves a fixture snapshot and
# screens, records every command that would change something, and refuses the rest,
# so a test can never reach a real herdr session.
#
# Reads from $HERDR_STUB_DIR: snapshot.json, screens/<pane id with : as _>.txt.
# Appends input commands to $HERDR_STUB_DIR/actions.log.
set -eu
dir="${HERDR_STUB_DIR:?HERDR_STUB_DIR is not set}"

case "$1 ${2:-}" in
  "api snapshot")
    cat "$dir/snapshot.json"
    ;;
  "pane read")
    screen="$dir/screens/$(printf '%s' "$3" | tr ':' '_').txt"
    if [ -f "$screen" ]; then cat "$screen"; else printf 'screen of %s\n$ ' "$3"; fi
    ;;
  "agent focus" | "tab focus" | "workspace focus" | "agent prompt" | "agent send-keys" | "pane send-text")
    printf '%s\n' "$*" >>"$dir/actions.log"
    printf '{"ok":true}\n'
    ;;
  *)
    printf 'herdr-stub: refusing unexpected command: %s\n' "$*" >&2
    exit 1
    ;;
esac
