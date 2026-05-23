"""Filter preset CRUD — manages named universe filter configurations."""
import json
import logging
from datetime import datetime, UTC

import aiosqlite
from app.config import DB_PATH

logger = logging.getLogger(__name__)


async def list_presets() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM filter_presets ORDER BY name") as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_active_preset() -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM filter_presets WHERE is_active = 1 LIMIT 1") as cur:
            row = await cur.fetchone()
    return dict(row) if row else None


async def create_preset(data: dict) -> dict:
    now = datetime.now(UTC).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO filter_presets
               (name, description, is_active, min_price, min_avg_volume, market_cap,
                rsi_filter, performance_filter, conviction_threshold, limit_candidates,
                created_at, updated_at)
               VALUES (?,?,0,?,?,?,?,?,?,?,?,?)""",
            (
                data["name"], data.get("description", ""),
                float(data.get("min_price", 10.0)),
                int(data.get("min_avg_volume", 1_000_000)),
                data.get("market_cap", "mid"),
                data.get("rsi_filter", "Not Overbought (<60)"),
                data.get("performance_filter", "Week Up"),
                int(data.get("conviction_threshold", 65)),
                int(data.get("limit_candidates", 40)),
                now, now,
            ),
        )
        await db.commit()
        preset_id = cur.lastrowid
    return {"id": preset_id, **data, "is_active": False}


async def activate_preset(preset_id: int) -> dict:
    now = datetime.now(UTC).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE filter_presets SET is_active = 0, updated_at = ?", (now,))
        await db.execute(
            "UPDATE filter_presets SET is_active = 1, updated_at = ? WHERE id = ?",
            (now, preset_id),
        )
        await db.commit()
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM filter_presets WHERE id = ?", (preset_id,)) as cur:
            row = await cur.fetchone()
    if not row:
        return {"error": f"preset {preset_id} not found"}
    logger.info("filter_presets: activated '%s' (id=%d)", row["name"], preset_id)
    return dict(row)


async def update_preset(preset_id: int, data: dict) -> dict:
    now = datetime.now(UTC).isoformat()
    fields = []
    values = []
    allowed = ["name", "description", "min_price", "min_avg_volume", "market_cap",
                "rsi_filter", "performance_filter", "conviction_threshold", "limit_candidates"]
    for k in allowed:
        if k in data:
            fields.append(f"{k} = ?")
            values.append(data[k])
    if not fields:
        return {"error": "no valid fields to update"}
    fields.append("updated_at = ?")
    values.extend([now, preset_id])
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(f"UPDATE filter_presets SET {', '.join(fields)} WHERE id = ?", values)
        await db.commit()
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM filter_presets WHERE id = ?", (preset_id,)) as cur:
            row = await cur.fetchone()
    return dict(row) if row else {"error": "not found"}


async def delete_preset(preset_id: int) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT name, is_active FROM filter_presets WHERE id = ?", (preset_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            return {"error": "preset not found"}
        if row[1]:
            return {"error": "cannot delete the active preset — activate another first"}
        await db.execute("DELETE FROM filter_presets WHERE id = ?", (preset_id,))
        await db.commit()
    return {"deleted": True, "id": preset_id}
