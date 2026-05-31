#!/bin/bash
# Investment Agent — start.sh
# Handles first-time setup and day-to-day restarts cleanly.
# Usage: ./start.sh

set -euo pipefail
PROJ="$(cd "$(dirname "$0")" && pwd)"
BACKEND_PORT=8000
FRONTEND_PORT=5173
LOGS="$PROJ/logs"
PLIST_LABEL="com.investmentagent"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

# ── Colours ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'
BLU='\033[0;34m'; DIM='\033[2m'; NC='\033[0m'
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
warn() { echo -e "  ${YLW}!${NC} $*"; }
err()  { echo -e "  ${RED}✗${NC} $*"; }
hdr()  { echo -e "\n${BLU}▶${NC} $*"; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║        Investment Agent  — start.sh      ║"
echo "╚══════════════════════════════════════════╝"

mkdir -p "$LOGS"

# ── Helper: kill every process bound to a TCP port ────────────────────────────
kill_port() {
  local port=$1
  local pids
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    warn "Killing existing processes on port $port (PIDs: $pids)"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
}

# ── 1. Python ──────────────────────────────────────────────────────────────────
hdr "Checking Python..."

if ! command -v python3 &>/dev/null; then
  err "Python 3 not found. Install Python 3.11+ from https://python.org and re-run."
  exit 1
fi

PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)

if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 11 ]; }; then
  err "Python $PY_VER found but 3.11+ is required. Upgrade Python and re-run."
  exit 1
fi

ok "Python $PY_VER"

# ── 2. Virtual environment ─────────────────────────────────────────────────────
hdr "Checking Python virtual environment..."

if [ ! -d "$PROJ/venv" ]; then
  warn "No venv found — creating one..."
  python3 -m venv "$PROJ/venv"
  ok "venv created"
else
  ok "venv exists"
fi

source "$PROJ/venv/bin/activate"

# ── 3. Python dependencies ─────────────────────────────────────────────────────
hdr "Checking Python dependencies..."

SENTINEL="$PROJ/venv/.deps_installed"
REQ="$PROJ/requirements.txt"

if [ ! -f "$SENTINEL" ] || [ "$REQ" -nt "$SENTINEL" ]; then
  warn "Installing/updating Python packages (this may take a minute)..."
  pip install --quiet --upgrade pip
  pip install --quiet -r "$REQ"
  touch "$SENTINEL"
  ok "Python packages installed"
else
  ok "Python packages up to date"
fi

# ── 4. .env file ───────────────────────────────────────────────────────────────
hdr "Checking environment variables..."

if [ ! -f "$PROJ/.env" ]; then
  warn ".env not found — copying from .env.example"
  cp "$PROJ/.env.example" "$PROJ/.env"
  echo ""
  echo -e "  ${YLW}ACTION REQUIRED:${NC}"
  echo "  Open .env and fill in your API keys before the agent can run."
  echo ""
  read -rp "  Press Enter once you've added your keys, or Ctrl+C to exit: "
fi

if grep -q "your_anthropic_api_key_here" "$PROJ/.env" 2>/dev/null; then
  err "ANTHROPIC_API_KEY is still a placeholder in .env."
  err "Open .env and add your real Anthropic API key, then re-run."
  exit 1
fi

ok ".env present"

# ── 5. Node.js ─────────────────────────────────────────────────────────────────
hdr "Checking Node.js..."

if ! command -v node &>/dev/null; then
  err "Node.js not found. Install it from https://nodejs.org (LTS recommended) and re-run."
  exit 1
fi

ok "Node.js $(node --version)"

# ── 6. npm dependencies ────────────────────────────────────────────────────────
hdr "Checking frontend dependencies..."

if [ ! -d "$PROJ/dashboard/node_modules" ]; then
  warn "node_modules not found — running npm install (this may take a minute)..."
  cd "$PROJ/dashboard" && npm install --silent && cd "$PROJ"
  ok "npm packages installed"
else
  ok "node_modules present"
fi

# ── 7. Database init ───────────────────────────────────────────────────────────
hdr "Checking database..."

cd "$PROJ"
python3 - <<'PYEOF'
import asyncio, sys, os
sys.path.insert(0, os.getcwd())
from app.db.schema import init_db
asyncio.run(init_db())
print("  \033[0;32m✓\033[0m Database ready")
PYEOF

# ── 8. Stop any launchd daemon (prevents port conflicts) ──────────────────────
hdr "Clearing previous processes..."

# Unload launchd plist if it is loaded — prevents it from fighting with our process.
# We always manage the process directly; launchd auto-restart causes duplicate binds.
if launchctl list "$PLIST_LABEL" &>/dev/null 2>&1; then
  warn "Disabling launchd daemon ($PLIST_LABEL) to prevent port conflicts..."
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null \
    || launchctl unload "$PLIST_PATH" 2>/dev/null \
    || true
  sleep 1
  ok "launchd daemon unloaded"
fi

# Kill everything on both ports — launchd or manual leftovers
kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"

# Remove stale PID files
rm -f "$LOGS/backend.pid" "$LOGS/frontend.pid"

# Rotate backend log if it's over 10 MB
if [ -f "$LOGS/backend.log" ] && [ "$(wc -c < "$LOGS/backend.log")" -gt 10485760 ]; then
  mv "$LOGS/backend.log" "$LOGS/backend.log.old"
  warn "Rotated oversized backend.log to backend.log.old"
fi

# ── 9. Start backend ───────────────────────────────────────────────────────────
hdr "Starting backend (FastAPI)..."

cd "$PROJ"
nohup "$PROJ/venv/bin/uvicorn" app.main:app \
  --host 127.0.0.1 \
  --port "$BACKEND_PORT" \
  --log-level warning \
  >> "$LOGS/backend.log" 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$LOGS/backend.pid"

# Wait for backend health check
echo -n "  Waiting for backend"
for i in {1..25}; do
  if curl -sf "http://127.0.0.1:$BACKEND_PORT/health" &>/dev/null; then
    echo ""
    ok "Backend is up  (PID $BACKEND_PID)"
    break
  fi
  echo -n "."
  sleep 1
done

if ! curl -sf "http://127.0.0.1:$BACKEND_PORT/health" &>/dev/null; then
  echo ""
  err "Backend failed to start. Check $LOGS/backend.log"
  tail -20 "$LOGS/backend.log" 2>/dev/null || true
  exit 1
fi

# ── 10. Start frontend ─────────────────────────────────────────────────────────
hdr "Starting frontend (Vite)..."

cd "$PROJ/dashboard"
nohup npm run dev -- --host 127.0.0.1 \
  >> "$LOGS/frontend.log" 2>&1 &
FRONTEND_PID=$!
echo "$FRONTEND_PID" > "$LOGS/frontend.pid"

# Wait for Vite
echo -n "  Waiting for frontend"
for i in {1..20}; do
  if curl -sf "http://127.0.0.1:$FRONTEND_PORT" &>/dev/null; then
    echo ""
    ok "Frontend is up  (PID $FRONTEND_PID)"
    break
  fi
  echo -n "."
  sleep 1
done

if ! curl -sf "http://127.0.0.1:$FRONTEND_PORT" &>/dev/null; then
  echo ""
  warn "Frontend may still be starting — check $LOGS/frontend.log if it doesn't open."
fi

cd "$PROJ"

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${GRN}Dashboard${NC}  →  http://localhost:$FRONTEND_PORT"
echo -e "  ${GRN}Backend${NC}    →  http://localhost:$BACKEND_PORT"
echo -e "  ${DIM}Backend log${NC}  →  logs/backend.log"
echo -e "  ${DIM}Frontend log${NC} →  logs/frontend.log"
echo -e "  ${DIM}Stop both${NC}    →  ./stop.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
