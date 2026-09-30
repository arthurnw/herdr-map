#!/bin/sh
# Stand-in for hunk in end-to-end tests, passed as --hunk. `session list --json` prints
# $HERDR_STUB_DIR/hunk-sessions.json (no sessions when it's missing). Navigating and adding a
# reply are appended to $HERDR_STUB_DIR/actions.log with a `hunk` prefix. Anything else is refused.
set -eu
dir="${HERDR_STUB_DIR:?HERDR_STUB_DIR is not set}"
case "$1 ${2:-} ${3:-}" in
  "session list --json")
    if [ -f "$dir/hunk-sessions.json" ]; then cat "$dir/hunk-sessions.json"; else printf '{"sessions":[]}\n'; fi
    ;;
  "session navigate "*)
    printf 'hunk %s\n' "$*" >>"$dir/actions.log"
    printf '{"result":{}}\n'
    ;;
  "session comment add")
    printf 'hunk %s\n' "$*" >>"$dir/actions.log"
    printf '{"result":{"commentId":"mcp:e2e-reply"}}\n'
    ;;
  *)
    printf 'hunk-stub: refusing unexpected command: %s\n' "$*" >&2
    exit 1
    ;;
esac
