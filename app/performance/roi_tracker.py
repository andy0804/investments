import logging
import aiosqlite
from datetime import datetime, date
from app.config import DB_PATH

logger = logging.getLogger(__name__)

MONTHLY_AGENT_COST_USD = 4.50


async def get_monthly_roi_report() -> dict:
    month_start = date.today().replace(day=1).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        async with db.execute(
            "SELECT SUM(cost_usd) as total FROM analysis_log WHERE date(ran_at) >= ?", (month_start,)
        ) as cur:
            api_row = await cur.fetchone()

        async with db.execute(
            """SELECT COUNT(*) as total,
                      SUM(CASE WHEN resolved_outcome = 'correct' THEN 1 ELSE 0 END) as correct
               FROM signals WHERE date(created_at) >= ? AND resolved_at IS NOT NULL""",
            (month_start,)
        ) as cur:
            sig_row = await cur.fetchone()

        async with db.execute(
            "SELECT SUM(total_value) as total FROM trade_log WHERE action = 'sell' AND date(traded_at) >= ?",
            (month_start,)
        ) as cur:
            trades_row = await cur.fetchone()

    api_cost = api_row["total"] or 0
    total_cost = api_cost + MONTHLY_AGENT_COST_USD
    signals_total = sig_row["total"] or 0
    signals_correct = sig_row["correct"] or 0
    accuracy = (signals_correct / signals_total * 100) if signals_total > 0 else 0
    value_traded = trades_row["total"] or 0

    return {
        "month": month_start[:7],
        "api_cost_usd": round(api_cost, 4),
        "total_cost_usd": round(total_cost, 2),
        "signals_generated": signals_total,
        "signal_accuracy_pct": round(accuracy, 1),
        "value_traded_usd": round(value_traded, 2),
        "cost_per_signal": round(total_cost / signals_total, 3) if signals_total > 0 else 0,
    }
