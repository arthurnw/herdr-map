#!/bin/sh
# Pulls the latest herdr-map and does only the follow-up work the changes need:
# reinstall dependencies, rebuild the web app, and restart the launchd service.
set -eu
cd "$(dirname "$0")/.."

old=$(git rev-parse HEAD)
git pull --ff-only -q
new=$(git rev-parse HEAD)

if [ "$old" = "$new" ] && [ -f dist/index.html ]; then
  echo "already up to date at $(git log -1 --format='%h %s')"
  exit 0
fi

changed=$(git diff --name-only "$old" "$new")
touches() { printf '%s\n' "$changed" | grep -qE "$1"; }

if touches '^package(-lock)?\.json$' || [ ! -d node_modules ]; then
  echo "installing dependencies"
  npm install --silent
fi

# The server reads dist/ on each request, so a rebuild alone updates the page.
if touches '^(web/|shared/|package(-lock)?\.json$|vite\.config\.ts$)' || [ ! -f dist/index.html ]; then
  echo "building web app"
  npm run build --silent >/dev/null
fi

if touches '^(server/|shared/|package(-lock)?\.json$)'; then
  scripts/service.sh restart
fi

echo "updated to $(git log -1 --format='%h %s')"
