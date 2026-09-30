#!/bin/sh
# Stand-in for `ps` in end-to-end tests, named by HERDR_MAP_PS: prints the canned process
# table the memory probe measures, $HERDR_STUB_DIR/ps.txt (from PS_OUTPUT in fixture.mjs).
set -eu
[ "$*" = "-A -o pid=,ppid=,rss=,comm=" ] || { printf 'ps-stub: unexpected arguments: %s\n' "$*" >&2; exit 1; }
cat "${HERDR_STUB_DIR:?HERDR_STUB_DIR is not set}/ps.txt"
