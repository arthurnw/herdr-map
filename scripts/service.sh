#!/bin/sh
# Runs herdr-map as a macOS launchd user agent that starts at login and restarts if it exits.
#
#   scripts/service.sh install [server flags...]   e.g. scripts/service.sh install --ssh mini
#   scripts/service.sh restart | status | uninstall
set -eu

LABEL=io.github.arthurnw.herdr-map
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/herdr-map.log"
DOMAIN="gui/$(id -u)"
REPO=$(cd "$(dirname "$0")/.." && pwd)

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

install() {
  node=$(command -v node) || { echo "node not found in PATH" >&2; exit 1; }
  args=""
  for a in "$@"; do args="$args    <string>$(xml_escape "$a")</string>
"; done
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$node")</string>
    <string>$(xml_escape "$REPO/server/index.ts")</string>
$args  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$REPO")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$(dirname "$node")"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG")</string>
</dict>
</plist>
EOF
  if loaded; then launchctl bootout "$DOMAIN/$LABEL"; fi
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "installed $LABEL; logs in $LOG"
}

case "${1:-}" in
  install)
    shift
    install "$@"
    ;;
  restart)
    if loaded; then
      launchctl kickstart -k "$DOMAIN/$LABEL"
      echo "restarted $LABEL"
    else
      echo "$LABEL is not installed; restart the server yourself" >&2
    fi
    ;;
  status)
    if loaded; then launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid|last exit code) ='; else echo "not installed"; fi
    ;;
  uninstall)
    if loaded; then launchctl bootout "$DOMAIN/$LABEL"; fi
    rm -f "$PLIST"
    echo "uninstalled $LABEL"
    ;;
  *)
    echo "usage: $0 install [server flags...] | restart | status | uninstall" >&2
    exit 2
    ;;
esac
