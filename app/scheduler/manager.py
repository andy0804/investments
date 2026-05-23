"""
app/scheduler/manager.py

Schedule Manager — seed, CRUD, and toggle for APScheduler jobs.

All state lives in the `schedules` table. The running APScheduler
instance is passed in from main.py for pause/resume operations.
"""

import logging
from datetime import datetime, UTC

import aiosqlite
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.config import DB_PATH

logger = logging.getLogger(__name__)

ET_ZONE = "America/New_York"

# Canonical schedule definitions — seeded once into the DB
_SCHEDULE_SEED = [
    {
        "job_id":           "sotd",
        "name":             "Morning Stock Scan",
        "description":      "V2 SOTD pipeline — screens market, scores candidates, picks Stock of the Day (7:30 AM ET pre-market)",
        "schedule_type":    "cron",
        "cron_expression":  "30 7 * * 1-5",
        "interval_minutes": None,
        "delivery_channel": "both",
    },
    {
        "job_id":           "sotd_open",
        "name":             "SOTD Refresh — Open (9:45 AM)",
        "description":      "Re-runs SOTD pipeline 15 min after market open + sends Telegram with all 5 strategy picks",
        "schedule_type":    "cron",
        "cron_expression":  "45 9 * * 1-5",
        "interval_minutes": None,
        "delivery_channel": "both",
    },
    {
        "job_id":           "sotd_afternoon",
        "name":             "SOTD Refresh — Afternoon (1:30 PM)",
        "description":      "Mid-day SOTD refresh + Telegram with all 5 strategy picks and consensus signal",
        "schedule_type":    "cron",
        "cron_expression":  "30 13 * * 1-5",
        "interval_minutes": None,
        "delivery_channel": "both",
    },
    {
        "job_id":           "sotd_close",
        "name":             "SOTD Refresh — Close (3:45 PM)",
        "description":      "End-of-day SOTD refresh + final Telegram with all 5 strategy picks before market close",
        "schedule_type":    "cron",
        "cron_expression":  "45 15 * * 1-5",
        "interval_minutes": None,
        "delivery_channel": "both",
    },
    {
        "job_id":           "morning_brief",
        "name":             "Morning Portfolio Brief",
        "description":      "Portfolio overview + risk summary sent to Telegram at market open",
        "schedule_type":    "cron",
        "cron_expression":  "3 8 * * 1-5",
        "interval_minutes": None,
        "delivery_channel": "telegram",
    },
    {
        "job_id":           "risk_check",
        "name":             "Risk Check",
        "description":      "Checks stop-loss and target thresholds for all positions every 20 minutes",
        "schedule_type":    "interval",
        "cron_expression":  None,
        "interval_minutes": 20,
        "delivery_channel": "telegram",
    },
    {
        "job_id":           "ytd_coach",
        "name":             "Weekly Coaching Report",
        "description":      "YTD performance coaching every Sunday morning",
        "schedule_type":    "cron",
        "cron_expression":  "0 8 * * 0",
        "interval_minutes": None,
        "delivery_channel": "telegram",
    },
    {
        "job_id":           "outcome_computation",
        "name":             "Signal Outcome Tracker",
        "description":      "Computes 1d/3d/7d returns for past SOTD picks — nightly feedback loop",
        "schedule_type":    "cron",
        "cron_expression":  "30 21 * * *",
        "interval_minutes": None,
        "delivery_channel": "ui",
    },
    {
        "job_id":           "portfolio_csv",
        "name":             "Portfolio CSV Sync",
        "description":      "Reloads Fidelity CSV export into the database",
        "schedule_type":    "interval",
        "cron_expression":  None,
        "interval_minutes": 30,
        "delivery_channel": "ui",
    },
    {
        "job_id":           "market_data",
        "name":             "Market Data Refresh",
        "description":      "Refreshes live prices for all holdings during market hours",
        "schedule_type":    "interval",
        "cron_expression":  None,
        "interval_minutes": 15,
        "delivery_channel": "ui",
    },
    {
        "job_id":           "vix",
        "name":             "VIX Sync",
        "description":      "Fetches daily VIX value from FRED",
        "schedule_type":    "cron",
        "cron_expression":  "30 6 * * *",
        "interval_minutes": None,
        "delivery_channel": "ui",
    },
    {
        "job_id":           "gdelt",
        "name":             "Geopolitical Event Monitor",
        "description":      "Pulls GDELT geopolitical events every 3 hours",
        "schedule_type":    "interval",
        "cron_expression":  None,
        "interval_minutes": 180,
        "delivery_channel": "ui",
    },
    {
        "job_id":           "edgar",
        "name":             "SEC Filing Sync",
        "description":      "Syncs EDGAR filings for portfolio holdings daily",
        "schedule_type":    "cron",
        "cron_expression":  "0 7 * * *",
        "interval_minutes": None,
        "delivery_channel": "ui",
    },
    {
        "job_id":           "rss",
        "name":             "News Feed Sync",
        "description":      "Pulls RSS news feeds every 2 hours",
        "schedule_type":    "interval",
        "cron_expression":  None,
        "interval_minutes": 120,
        "delivery_channel": "ui",
    },
    {
        "job_id":           "signal_resolution",
        "name":             "Signal Resolution",
        "description":      "Marks old trading signals as resolved nightly",
        "schedule_type":    "cron",
        "cron_expression":  "0 21 * * *",
        "interval_minutes": None,
        "delivery_channel": "ui",
    },
    {
        "job_id":           "foresight",
        "name":             "Weekly Foresight Report",
        "description":      "Forward-looking macro and sector analysis every Monday",
        "schedule_type":    "cron",
        "cron_expression":  "35 7 * * 1",
        "interval_minutes": None,
        "delivery_channel": "ui",
    },
    {
        "job_id":           "health_monitor",
        "name":             "API Health Monitor",
        "description":      "Checks all external API connections every 6 hours",
        "schedule_type":    "interval",
        "cron_expression":  None,
        "interval_minutes": 360,
        "delivery_channel": "ui",
    },
    {
        "job_id":           "top_performers",
        "name":             "Top Performers of the Day",
        "description":      "Close recap: SOTD candidates, FinViz top gainers, morning pick vs SPY — sent at 4:05 PM ET",
        "schedule_type":    "cron",
        "cron_expression":  "5 16 * * 1-5",
        "interval_minutes": None,
        "delivery_channel": "both",
    },
]


def _human_readable(s: dict) -> str:
    """Convert cron/interval to human-readable string."""
    if s["schedule_type"] == "interval":
        mins = s.get("interval_minutes") or 0
        if mins >= 60:
            return f"Every {mins // 60}h" + (f" {mins % 60}m" if mins % 60 else "")
        return f"Every {mins}m"
    cron = s.get("cron_expression", "")
    _map = {
        "30 7 * * 1-5":  "Weekdays 7:30 AM ET",
        "3 8 * * 1-5":   "Weekdays 8:03 AM ET",
        "0 8 * * 0":     "Sunday 8:00 AM ET",
        "30 21 * * *":   "Daily 9:30 PM ET",
        "0 21 * * *":    "Daily 9:00 PM ET",
        "30 6 * * *":    "Daily 6:30 AM ET",
        "0 7 * * *":     "Daily 7:00 AM ET",
        "35 7 * * 1":    "Monday 7:35 AM ET",
        "5 16 * * 1-5":  "Weekdays 4:05 PM ET",
    }
    return _map.get(cron, cron)


async def seed_schedules() -> None:
    """Insert all known schedules into the DB (INSERT OR IGNORE)."""
    now = datetime.now(UTC).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        for s in _SCHEDULE_SEED:
            await db.execute(
                """INSERT OR IGNORE INTO schedules
                   (job_id, name, description, schedule_type, cron_expression,
                    interval_minutes, enabled, delivery_channel, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,1,?,?,?)""",
                (
                    s["job_id"], s["name"], s["description"],
                    s["schedule_type"], s["cron_expression"],
                    s["interval_minutes"], s["delivery_channel"],
                    now, now,
                ),
            )
        await db.commit()
    logger.info("schedules: seeded %d entries", len(_SCHEDULE_SEED))


async def list_schedules(scheduler: AsyncIOScheduler) -> list[dict]:
    """Return all schedules merged with live APScheduler state."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM schedules ORDER BY name") as cur:
            rows = [dict(r) for r in await cur.fetchall()]

    result = []
    for row in rows:
        job = scheduler.get_job(row["job_id"])
        next_run = None
        if job and job.next_run_time:
            next_run = job.next_run_time.isoformat()

        result.append({
            "id":               row["id"],
            "job_id":           row["job_id"],
            "name":             row["name"],
            "description":      row["description"],
            "schedule_type":    row["schedule_type"],
            "cron_expression":  row["cron_expression"],
            "interval_minutes": row["interval_minutes"],
            "human_schedule":   _human_readable(row),
            "enabled":          bool(row["enabled"]),
            "delivery_channel": row["delivery_channel"],
            "last_run":         row["last_run"],
            "next_run":         next_run,
        })
    return result


async def toggle_schedule(job_id: str, scheduler: AsyncIOScheduler) -> dict:
    """Flip enabled state and pause/resume the APScheduler job."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT enabled FROM schedules WHERE job_id = ?", (job_id,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return {"error": f"schedule '{job_id}' not found"}

        new_state = 0 if row[0] else 1
        await db.execute(
            "UPDATE schedules SET enabled = ?, updated_at = ? WHERE job_id = ?",
            (new_state, datetime.now(UTC).isoformat(), job_id),
        )
        await db.commit()

    job = scheduler.get_job(job_id)
    if job:
        if new_state:
            scheduler.resume_job(job_id)
            logger.info("schedule toggled ON: %s", job_id)
        else:
            scheduler.pause_job(job_id)
            logger.info("schedule toggled OFF: %s", job_id)

    return {"job_id": job_id, "enabled": bool(new_state)}


async def delete_schedule(job_id: str, scheduler: AsyncIOScheduler) -> dict:
    """Remove a schedule from both APScheduler and the DB."""
    job = scheduler.get_job(job_id)
    if job:
        scheduler.remove_job(job_id)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM schedules WHERE job_id = ?", (job_id,))
        await db.commit()

    logger.info("schedule deleted: %s", job_id)
    return {"job_id": job_id, "deleted": True}


async def update_schedule(job_id: str, data: dict, scheduler: AsyncIOScheduler) -> dict:
    """Update editable fields of an existing schedule (name, channel, telegram, cron/interval)."""
    now = datetime.now(UTC).isoformat()
    allowed = ["name", "description", "delivery_channel", "telegram_enabled",
               "cron_expression", "interval_minutes", "schedule_type"]
    fields, values = [], []
    for k in allowed:
        if k in data:
            fields.append(f"{k} = ?")
            values.append(data[k])
    if not fields:
        return {"error": "no valid fields provided"}
    fields.append("updated_at = ?")
    values.extend([now, job_id])

    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT job_id FROM schedules WHERE job_id = ?", (job_id,)) as cur:
            if not await cur.fetchone():
                return {"error": f"schedule '{job_id}' not found"}
        await db.execute(f"UPDATE schedules SET {', '.join(fields)} WHERE job_id = ?", values)
        await db.commit()

    # If schedule timing changed, reschedule the APScheduler job
    if "cron_expression" in data or "interval_minutes" in data:
        job = scheduler.get_job(job_id)
        if job:
            try:
                if data.get("schedule_type") == "interval" and data.get("interval_minutes"):
                    scheduler.reschedule_job(job_id, trigger=IntervalTrigger(minutes=int(data["interval_minutes"])))
                elif data.get("cron_expression"):
                    scheduler.reschedule_job(
                        job_id,
                        trigger=CronTrigger.from_crontab(data["cron_expression"], timezone=ET_ZONE),
                    )
            except Exception as e:
                logger.warning("update_schedule: reschedule failed for %s: %s", job_id, e)

    logger.info("schedule updated: %s fields=%s", job_id, list(data.keys()))
    return {"job_id": job_id, "updated": True}


async def get_schedule_telegram_enabled(job_id: str) -> bool:
    """Returns True if Telegram delivery is enabled for this job."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT telegram_enabled FROM schedules WHERE job_id = ?", (job_id,)
            ) as cur:
                row = await cur.fetchone()
        return bool(row[0]) if row else True
    except Exception:
        return True


async def update_last_run(job_id: str) -> None:
    """Called by job wrappers to record execution time."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "UPDATE schedules SET last_run = ? WHERE job_id = ?",
                (datetime.now(UTC).isoformat(), job_id),
            )
            await db.commit()
    except Exception as e:
        logger.warning("update_last_run failed for %s: %s", job_id, e)
