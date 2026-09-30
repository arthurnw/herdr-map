#!/bin/sh
# Stand-in for gh in end-to-end tests. `gh pr view` answers for the branch checked out in the
# current directory from $GH_STUB_DIR/prs/<branch>.json, or reports no PR. Anything else is refused.
set -eu
dir="${GH_STUB_DIR:?GH_STUB_DIR is not set}"
if [ "${1:-} ${2:-}" != "pr view" ]; then
  printf 'gh-stub: refusing unexpected command: %s\n' "$*" >&2
  exit 1
fi
branch=$(git branch --show-current)
printf '%s\n' "$branch" >>"$dir/calls.log"
if [ -f "$dir/prs/$branch.json" ]; then
  cat "$dir/prs/$branch.json"
else
  printf 'no pull requests found for branch "%s"\n' "$branch" >&2
  exit 1
fi
