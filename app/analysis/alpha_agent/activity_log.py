"""
Activity log — lightweight append-only log of everything the Alpha Agent does.
Written to by scheduler jobs, event detector, engine, and committee.
Read by the SSE stream so the frontend can show a live feed.
"""

import json
import logging
from datetime import datetime, UTC

import aiosqlite

from app.config import DB_PATH

log = logging.getLogger(__name__)

# Event types surfaced to the frontend
LEVEL_COLORS = {
    "info":    "#64748b",
    "success": "#22c55e",
    "warning": "#f59e0b",
    "alert":   "#a78bfa",   # committee decision ready
    "danger":  "#ef4444",   # stop hit / drawdown
}


async def write(
    event_type: str,
    message: str,
    ticker: str | None = None,
    level: str = "info",
    metadata: dict | None = None,
) -> int:
    """Append one entry. Returns the new row id."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                """INSERT INTO alpha_agent_activity_log
                   (event_type, message, ticker, level, metadata_json, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    event_type,
                    message,
                    ticker,
                    level,
                    json.dumps(metadata) if metadata else None,
                    datetime.now(UTC).isoformat(),
                ),
            ) as cur:
                row_id = cur.lastrowid
            await db.commit()
        return row_id
    except Exception as e:
        log.warning("activity_log.write failed: %s", e)
        return 0


async def get_recent(limit: int = 100, since_id: int = 0) -> list[dict]:
    """Return recent log entries, optionally after a given id (for SSE polling)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT * FROM alpha_agent_activity_log
               WHERE id > ?
               ORDER BY id DESC LIMIT ?""",
            (since_id, limit),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in reversed(rows)]  # chronological order
