"""Options Scanner API router."""
import asyncio
import logging
from datetime import date

import aiosqlite
from fastapi import APIRouter, BackgroundTasks, HTTPException

from app.config import DB_PATH
from app.analysis.options_scanner import run_options_scan

router = APIRouter(prefix="/options-scanner", tags=["options-scanner"])
log = logging.getLogger(__name__)

_scan_running = False


@router.get("/setups")
async def get_setups(force: bool = False):
    """Return today's scanner setups (cached unless force=true)."""
    async with aiosqlite.connect(DB_PATH) as db:
        setups = await run_options_scan(db, force=force)
    return {"status": "ok", "setups": setups, "count": len(setups)}


@router.post("/run")
async def trigger_scan(background_tasks: BackgroundTasks):
    """Kick off a fresh scan in the background."""
    global _scan_running
    if _scan_running:
        return {"status": "already_running"}
    background_tasks.add_task(_run_scan_bg)
    return {"status": "started"}


async def _run_scan_bg():
    global _scan_running
    _scan_running = True
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            await run_options_scan(db, force=True)
    except Exception as e:
        log.error("options_scanner background run failed: %s", e)
    finally:
        _scan_running = False


@router.get("/status")
async def scan_status():
    today = date.today().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT COUNT(*), MAX(created_at) FROM options_scanner_cache WHERE scan_date = ?",
            (today,),
        ) as cur:
            count, last_run = await cur.fetchone()
    return {
        "scan_running": _scan_running,
        "today_count":  count or 0,
        "last_run":     last_run,
        "scan_date":    today,
    }
