import logging
import aiosqlite
from datetime import datetime, timedelta
from app.config import DB_PATH
from app.db.schema import log_sync

logger = logging.getLogger(__name__)


async def resolve_old_signals():
    cutoff = (datetime.utcnow() - timedelta(days=30)).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM signals WHERE resolved_at IS NULL AND created_at < ?", (cutoff,)
        ) as cur:
            unresolved = await cur.fetchall()

    resolved = 0
    async with aiosqlite.connect(DB_PATH) as db:
        for sig in unresolved:
            symbol = sig["symbol"]
            signal_type = sig["signal_type"]
            created = sig["created_at"]

            async with db.execute(
                """SELECT m.price, p.avg_cost_basis FROM market_data m
                   LEFT JOIN positions p ON m.symbol = p.symbol
                   WHERE m.symbol = ?""",
                (symbol,)
            ) as cur:
                row = await cur.fetchone()

            if row and row["avg_cost_basis"]:
                current_price = row["price"]
                cost = row["avg_cost_basis"]
                actual_pct = ((current_price - cost) / cost * 100) if cost else 0
                predicted_direction = "buy" if signal_type in ("buy", "strong_buy") else "sell"
                correct = (predicted_direction == "buy" and actual_pct > 0) or \
                          (predicted_direction == "sell" and actual_pct < 0)
                outcome = "correct" if correct else "incorrect"
            else:
                outcome = "unresolvable"

            await db.execute(
                "UPDATE signals SET resolved_at = ?, resolved_outcome = ? WHERE id = ?",
                (datetime.utcnow().isoformat(), outcome, sig["id"]),
            )
            resolved += 1
        await db.commit()

    await log_sync("signal_tracker", "success", resolved)
    return resolved


async def get_signal_accuracy() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT signal_type,
                      COUNT(*) as total,
                      SUM(CASE WHEN resolved_outcome = 'correct' THEN 1 ELSE 0 END) as correct
               FROM signals
               WHERE resolved_at IS NOT NULL
               GROUP BY signal_type"""
        ) as cur:
            rows = await cur.fetchall()

    results = {}
    for row in rows:
        total = row["total"]
        correct = row["correct"] or 0
        results[row["signal_type"]] = {
            "total": total,
            "correct": correct,
            "accuracy_pct": round((correct / total) * 100, 1) if total > 0 else 0,
        }
    return results
