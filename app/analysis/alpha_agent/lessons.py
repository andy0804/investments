"""
Lessons memory — stores, retrieves, and injects approved lessons into agent prompts.
"""

import aiosqlite
import logging
from datetime import datetime, UTC
from app.config import DB_PATH

log = logging.getLogger(__name__)


async def get_active_lessons() -> list[dict]:
    """Return all ACTIVE lessons to inject into agent prompts."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """SELECT id, lesson_text, category, applied_count
                   FROM alpha_agent_lessons WHERE status = 'ACTIVE'
                   ORDER BY applied_count DESC, approved_at DESC"""
            ) as cur:
                return [dict(r) for r in await cur.fetchall()]
    except Exception as e:
        log.warning("lessons.get_active: %s", e)
        return []


async def format_for_prompt(lessons: list[dict]) -> str:
    """Format lessons as a prompt block."""
    if not lessons:
        return ""
    lines = ["LESSONS FROM PAST TRADES (apply these):"]
    for l in lessons:
        lines.append(f"- [{l['category'].upper()}] {l['lesson_text']}")
    return "\n".join(lines)


async def create_lesson(
    lesson_text: str,
    evidence: str = "",
    category: str = "general",
    source_position_id: int | None = None,
) -> int:
    """Create a new lesson in PENDING state (requires user approval)."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """INSERT INTO alpha_agent_lessons
               (lesson_text, evidence, category, source_position_id, status, created_at)
               VALUES (?, ?, ?, ?, 'PENDING', ?)""",
            (lesson_text, evidence, category, source_position_id,
             datetime.now(UTC).isoformat()),
        ) as cur:
            lesson_id = cur.lastrowid
        await db.commit()
    return lesson_id


async def approve_lesson(lesson_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE alpha_agent_lessons SET status='ACTIVE', approved_at=? WHERE id=?",
            (datetime.now(UTC).isoformat(), lesson_id),
        )
        await db.commit()


async def dismiss_lesson(lesson_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE alpha_agent_lessons SET status='DISMISSED', dismissed_at=? WHERE id=?",
            (datetime.now(UTC).isoformat(), lesson_id),
        )
        await db.commit()


async def increment_applied(lesson_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE alpha_agent_lessons SET applied_count = applied_count + 1 WHERE id=?",
            (lesson_id,),
        )
        await db.commit()


async def get_all_lessons() -> list[dict]:
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM alpha_agent_lessons ORDER BY created_at DESC"
            ) as cur:
                return [dict(r) for r in await cur.fetchall()]
    except Exception:
        return []
