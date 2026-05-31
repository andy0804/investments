#!/bin/bash
# Investment Agent — stop.sh
# Cleanly kills backend + frontend and unloads any launchd daemon.
# Usage: ./stop.sh

PROJ="$(cd "$(dirname "$0")" && pwd)"
BACKEND_PORT=8000
FRONTEND_PORT=5173
LOGS="$PROJ/logs"
PLIST_LABEL="com.investmentagent"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
warn() { echo -e "  ${YLW}!${NC} $*"; }

echo ""
echo "  Stopping Investment Agent..."
echo ""

# 1. Unload launchd if it's managing the backend
if launchctl list "$PLIST_LABEL" &>/dev/null 2>&1; then
  warn "Unloading launchd daemon ($PLIST_LABEL)..."
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null \
    || launchctl unload "$PLIST_PATH" 2>/dev/null \
    || true
  ok "launchd daemon unloaded"
fi

# 2. Kill everything on both ports (catches all processes, not just PID file)
for port in $BACKEND_PORT $FRONTEND_PORT; do
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null || true
    ok "Killed processes on port $port"
  else
    echo -e "  (nothing on port $port)"
  fi
done

# 3. Remove PID files
rm -f "$LOGS/backend.pid" "$LOGS/frontend.pid"

echo ""
echo -e "  ${GRN}All stopped.${NC}  Run ./start.sh to restart."
echo ""
