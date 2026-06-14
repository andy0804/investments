"""Tracks every Haiku API call made by the Alpha Agent."""

import aiosqlite
import logging
from datetime import datetime, UTC
from app.config import DB_PATH

log = logging.getLogger(__name__)

# claude-haiku-4-5 pricing (per million tokens)
_COST_IN  = 1.0 / 1_000_000   # $1/M input
_COST_OUT = 5.0 / 1_000_000   # $5/M output


def compute_cost(tokens_in: int, tokens_out: int) -> float:
    return round(tokens_in * _COST_IN + tokens_out * _COST_OUT, 6)


async def log_call(
    stage: str,
    model: str,
    tokens_in: int,
    tokens_out: int,
    run_id: int | None = None,
) -> float:
    cost = compute_cost(tokens_in, tokens_out)
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """INSERT INTO alpha_agent_costs
                   (run_id, stage, model, tokens_in, tokens_out, cost_usd, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (run_id, stage, model, tokens_in, tokens_out, cost,
                 datetime.now(UTC).isoformat()),
            )
            await db.commit()
    except Exception as e:
        log.warning("cost_tracker: failed to log: %s", e)
    return cost


async def get_monthly_spend() -> dict:
    """Return total spend and call count for the current calendar month."""
    from datetime import date
    month_start = date.today().replace(day=1).isoformat()
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                """SELECT COUNT(*), COALESCE(SUM(cost_usd),0), COALESCE(SUM(tokens_in+tokens_out),0)
                   FROM alpha_agent_costs WHERE created_at >= ?""",
                (month_start,),
            ) as cur:
                calls, total_cost, total_tokens = await cur.fetchone()
        return {"calls": calls, "cost_usd": round(total_cost, 4), "tokens": total_tokens}
    except Exception:
        return {"calls": 0, "cost_usd": 0.0, "tokens": 0}


async def get_today_spend() -> dict:
    from datetime import date
    today = date.today().isoformat()
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                """SELECT COUNT(*), COALESCE(SUM(cost_usd),0)
                   FROM alpha_agent_costs WHERE created_at >= ?""",
                (today,),
            ) as cur:
                calls, cost = await cur.fetchone()
        return {"calls": calls, "cost_usd": round(cost, 4)}
    except Exception:
        return {"calls": 0, "cost_usd": 0.0}
