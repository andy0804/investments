#!/bin/bash
# Investment Agent — start.sh
# Single command to set up and launch everything from a fresh clone.
# Usage:  ./start.sh
# Prereqs: Python 3.11+  ·  Node.js 18+  ·  .env file with your API keys

set -euo pipefail
PROJ="$(cd "$(dirname "$0")" && pwd)"
BACKEND_PORT=8000
FRONTEND_PORT=5173
LOGS="$PROJ/logs"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'
BLU='\033[0;34m'; CYN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
ok()   { echo -e "  ${GRN}✓${NC}  $*"; }
warn() { echo -e "  ${YLW}⚠${NC}  $*"; }
err()  { echo -e "  ${RED}✗${NC}  $*"; }
hdr()  { echo -e "\n${BLU}▶${NC}  $*"; }
die()  { err "$*"; exit 1; }

mkdir -p "$LOGS"

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYN}╔════════════════════════════════════════════╗${NC}"
echo -e "${CYN}║       Investment Agent  —  start.sh        ║${NC}"
echo -e "${CYN}╚════════════════════════════════════════════╝${NC}"
echo ""

# Detect first-time setup vs restart
FIRST_RUN=false
if [ ! -d "$PROJ/venv" ] || [ ! -d "$PROJ/dashboard/node_modules" ]; then
  FIRST_RUN=true
  echo -e "  ${YLW}First-time setup detected — this will take ~2 minutes.${NC}"
fi

# ── Helper: kill process on port ──────────────────────────────────────────────
kill_port() {
  local port=$1
  local pids
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    warn "Port $port in use — clearing (PIDs: $pids)"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — .env validation
# ─────────────────────────────────────────────────────────────────────────────
hdr "Checking .env file..."

if [ ! -f "$PROJ/.env" ]; then
  if [ -f "$PROJ/.env.example" ]; then
    cp "$PROJ/.env.example" "$PROJ/.env"
    echo ""
    echo -e "  ${YLW}┌─────────────────────────────────────────────────┐${NC}"
    echo -e "  ${YLW}│  ACTION REQUIRED: fill in your API keys in .env  │${NC}"
    echo -e "  ${YLW}└─────────────────────────────────────────────────┘${NC}"
    echo ""
    echo -e "  Open ${CYN}.env${NC} and set these required keys:"
    echo -e "    ${DIM}ANTHROPIC_API_KEY     — from console.anthropic.com${NC}"
    echo -e "    ${DIM}FINNHUB_API_KEY       — from finnhub.io (free)${NC}"
    echo -e "    ${DIM}TELEGRAM_BOT_TOKEN    — from @BotFather on Telegram${NC}"
    echo -e "    ${DIM}TELEGRAM_CHAT_ID      — your Telegram chat ID${NC}"
    echo ""
    read -rp "  Press Enter once .env is updated, or Ctrl+C to exit: "
  else
    die ".env not found and no .env.example to copy from. Create .env from scratch (see README)."
  fi
fi

# Validate required keys exist and are not placeholders
REQUIRED_KEYS=("ANTHROPIC_API_KEY" "FINNHUB_API_KEY" "TELEGRAM_BOT_TOKEN" "TELEGRAM_CHAT_ID")
MISSING_KEYS=()

for key in "${REQUIRED_KEYS[@]}"; do
  val=$(grep "^${key}=" "$PROJ/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
  if [ -z "$val" ] || [[ "$val" == *"your_"* ]] || [[ "$val" == *"_here"* ]]; then
    MISSING_KEYS+=("$key")
  fi
done

if [ ${#MISSING_KEYS[@]} -gt 0 ]; then
  echo ""
  err "The following keys in .env are missing or still have placeholder values:"
  for k in "${MISSING_KEYS[@]}"; do
    echo -e "    ${RED}→  $k${NC}"
  done
  echo ""
  echo -e "  Edit ${CYN}.env${NC} and re-run ${CYN}./start.sh${NC}"
  exit 1
fi

ok ".env validated (all required keys present)"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — Python
# ─────────────────────────────────────────────────────────────────────────────
hdr "Checking Python..."

if ! command -v python3 &>/dev/null; then
  die "Python 3 not found. Install Python 3.11+ from https://python.org and re-run."
fi

PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)

if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 11 ]; }; then
  die "Python $PY_VER found — 3.11+ required. Upgrade and re-run."
fi

ok "Python $PY_VER"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — Python virtual environment
# ─────────────────────────────────────────────────────────────────────────────
hdr "Setting up Python virtual environment..."

if [ ! -d "$PROJ/venv" ]; then
  warn "Creating virtual environment..."
  python3 -m venv "$PROJ/venv"
  ok "venv created"
else
  ok "venv exists"
fi

# Always activate
source "$PROJ/venv/bin/activate"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — Python dependencies  (uv if available, pip fallback)
# ─────────────────────────────────────────────────────────────────────────────
hdr "Installing Python dependencies..."

REQ="$PROJ/requirements.txt"
SENTINEL="$PROJ/venv/.deps_installed"

# Prefer uv (10-100× faster than pip). Install it if not present.
if ! command -v uv &>/dev/null; then
  warn "uv not found — installing uv for faster dependency management..."
  pip install --quiet uv
fi

if [ ! -f "$SENTINEL" ] || [ "$REQ" -nt "$SENTINEL" ]; then
  if command -v uv &>/dev/null; then
    warn "Installing packages via uv (first time ~15s)..."
    uv pip install --quiet -r "$REQ"
  else
    warn "Installing packages via pip (first time ~90s)..."
    pip install --quiet --upgrade pip
    pip install --quiet -r "$REQ"
  fi
  touch "$SENTINEL"
  ok "Python packages installed"
else
  ok "Python packages up to date"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — Node.js
# ─────────────────────────────────────────────────────────────────────────────
hdr "Checking Node.js..."

if ! command -v node &>/dev/null; then
  die "Node.js not found. Install from https://nodejs.org (LTS) and re-run."
fi

NODE_VER=$(node --version | tr -d 'v' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  die "Node.js $(node --version) found — v18+ required. Upgrade and re-run."
fi

ok "Node.js $(node --version)"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6 — Frontend dependencies
# ─────────────────────────────────────────────────────────────────────────────
hdr "Installing frontend dependencies..."

PKG="$PROJ/dashboard/package.json"
NMODS="$PROJ/dashboard/node_modules"
NM_SENTINEL="$PROJ/dashboard/node_modules/.install_sentinel"

if [ ! -d "$NMODS" ] || [ "$PKG" -nt "$NM_SENTINEL" ]; then
  warn "Running npm install (first time ~60s)..."
  cd "$PROJ/dashboard"
  npm install --silent
  touch "$NM_SENTINEL"
  cd "$PROJ"
  ok "npm packages installed"
else
  ok "npm packages up to date"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 7 — Database initialisation
# ─────────────────────────────────────────────────────────────────────────────
hdr "Initialising database..."

cd "$PROJ"
# Pass PROJ explicitly so the inline script can find .env regardless of
# working directory or call-stack frame (avoids find_dotenv() AssertionError)
PROJ_PATH="$PROJ" python3 - <<'PYEOF'
import asyncio, sys, os

proj = os.environ["PROJ_PATH"]
sys.path.insert(0, proj)

# Explicit path avoids find_dotenv() frame-inspection bug in inline scripts
from dotenv import load_dotenv
load_dotenv(dotenv_path=os.path.join(proj, ".env"))

from app.db.schema import init_db
asyncio.run(init_db())
print("  \033[0;32m✓\033[0m  Database ready (investment_agent.db)")
PYEOF

# ─────────────────────────────────────────────────────────────────────────────
# STEP 8 — Clear port conflicts
# ─────────────────────────────────────────────────────────────────────────────
hdr "Clearing previous processes..."

# Unload any launchd daemon that might hold the ports
PLIST_LABEL="com.investmentagent"
if launchctl list "$PLIST_LABEL" &>/dev/null 2>&1; then
  warn "Unloading launchd daemon to prevent port conflicts..."
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null \
    || launchctl unload "$HOME/Library/LaunchAgents/$PLIST_LABEL.plist" 2>/dev/null \
    || true
  sleep 1
  ok "launchd daemon unloaded"
fi

kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"

rm -f "$LOGS/backend.pid" "$LOGS/frontend.pid"

# Rotate oversized logs
for log in backend frontend; do
  logfile="$LOGS/$log.log"
  if [ -f "$logfile" ] && [ "$(wc -c < "$logfile")" -gt 10485760 ]; then
    mv "$logfile" "$logfile.old"
    warn "Rotated $log.log (>10MB)"
  fi
done

ok "Ports $BACKEND_PORT and $FRONTEND_PORT clear"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 9 — Start backend
# ─────────────────────────────────────────────────────────────────────────────
hdr "Starting backend (FastAPI on :$BACKEND_PORT)..."

cd "$PROJ"
nohup "$PROJ/venv/bin/uvicorn" app.main:app \
  --host 127.0.0.1 \
  --port "$BACKEND_PORT" \
  --log-level warning \
  >> "$LOGS/backend.log" 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$LOGS/backend.pid"

echo -n "  Waiting"
for i in {1..30}; do
  if curl -sf "http://127.0.0.1:$BACKEND_PORT/health" &>/dev/null; then
    echo -e " ${GRN}ready${NC}"
    ok "Backend up  (PID $BACKEND_PID)"
    break
  fi
  echo -n "."
  sleep 1
done

if ! curl -sf "http://127.0.0.1:$BACKEND_PORT/health" &>/dev/null; then
  echo ""
  err "Backend failed to start. Last 20 lines of log:"
  tail -20 "$LOGS/backend.log" 2>/dev/null || true
  die "Fix the error above and re-run."
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 10 — Start frontend
# ─────────────────────────────────────────────────────────────────────────────
hdr "Starting frontend (Vite on :$FRONTEND_PORT)..."

cd "$PROJ/dashboard"
nohup npm run dev -- --host 127.0.0.1 \
  >> "$LOGS/frontend.log" 2>&1 &
FRONTEND_PID=$!
echo "$FRONTEND_PID" > "$LOGS/frontend.pid"

echo -n "  Waiting"
for i in {1..25}; do
  if curl -sf "http://127.0.0.1:$FRONTEND_PORT" &>/dev/null; then
    echo -e " ${GRN}ready${NC}"
    ok "Frontend up  (PID $FRONTEND_PID)"
    break
  fi
  echo -n "."
  sleep 1
done

if ! curl -sf "http://127.0.0.1:$FRONTEND_PORT" &>/dev/null; then
  echo ""
  warn "Frontend is still starting — it may take a few more seconds."
fi

cd "$PROJ"

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e ""
echo -e "  ${GRN}Dashboard  →${NC}  http://localhost:$FRONTEND_PORT"
echo -e "  ${GRN}Backend    →${NC}  http://localhost:$BACKEND_PORT"
echo ""
echo -e "  ${DIM}Logs       →  logs/backend.log  ·  logs/frontend.log${NC}"
echo -e "  ${DIM}Stop       →  ./stop.sh${NC}"
echo ""
if [ "$FIRST_RUN" = true ]; then
  echo -e "  ${YLW}First-run tip:${NC} Open the dashboard, click${NC} ⓘ${NC} on any page"
  echo -e "  to understand what each section does."
  echo ""
fi
echo -e "${CYN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Auto-open browser on macOS
if command -v open &>/dev/null; then
  open "http://localhost:$FRONTEND_PORT" 2>/dev/null || true
fi
