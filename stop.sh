#!/bin/bash
# Investment Agent — stop.sh
# Stops both the backend and frontend started by start.sh

PROJ="$(cd "$(dirname "$0")" && pwd)"
LOGS="$PROJ/logs"

GRN='\033[0;32m'; YLW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
skip() { echo -e "  ${YLW}-${NC} $*"; }

echo ""
echo "▶ Stopping Investment Agent..."

stop_pid_file() {
  local name=$1
  local pidfile="$LOGS/$2.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      ok "$name stopped (PID $pid)"
    else
      skip "$name was not running"
    fi
    rm -f "$pidfile"
  else
    # Fallback: pkill by process pattern
    if pkill -f "$3" 2>/dev/null; then
      ok "$name stopped"
    else
      skip "$name was not running"
    fi
  fi
}

stop_pid_file "Backend"  "backend"  "uvicorn app.main:app"
stop_pid_file "Frontend" "frontend" "vite"

echo "  Done."
echo ""
