import logging
import aiosqlite
from app.config import DB_PATH, STOP_LOSS_PCT, SOFT_REVIEW_PCT, TARGET_1_PCT, TARGET_2_PCT

logger = logging.getLogger(__name__)


async def check_risk_triggers(symbol: str) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT p.symbol, p.avg_cost_basis, p.quantity, p.current_value,
                      p.total_gain_loss_percent, m.price as live_price
               FROM positions p
               LEFT JOIN market_data m ON p.symbol = m.symbol
               WHERE p.symbol = ? AND p.position_type NOT IN ('Cash_MM')""",
            (symbol,),
        ) as cur:
            row = await cur.fetchone()

    if not row:
        return None

    cost_basis = row["avg_cost_basis"]
    live_price = row["live_price"] or row["current_value"] / (row["quantity"] or 1)

    if not cost_basis or cost_basis == 0:
        return None

    gain_pct = ((live_price - cost_basis) / cost_basis) * 100

    triggers = []
    if gain_pct <= STOP_LOSS_PCT:
        triggers.append({"type": "stop_loss", "threshold": STOP_LOSS_PCT,
                         "message": f"STOP LOSS HIT: {symbol} is down {gain_pct:.1f}% from your cost basis of ${cost_basis:.2f}"})
    elif gain_pct <= SOFT_REVIEW_PCT:
        triggers.append({"type": "soft_review", "threshold": SOFT_REVIEW_PCT,
                         "message": f"Review needed: {symbol} is down {gain_pct:.1f}%"})

    if gain_pct >= TARGET_2_PCT:
        triggers.append({"type": "target_2", "threshold": TARGET_2_PCT,
                         "message": f"TARGET 2 HIT: {symbol} is up {gain_pct:.1f}% — consider taking partial profits"})
    elif gain_pct >= TARGET_1_PCT:
        triggers.append({"type": "target_1", "threshold": TARGET_1_PCT,
                         "message": f"TARGET 1 HIT: {symbol} is up {gain_pct:.1f}%"})

    return {
        "symbol": symbol,
        "cost_basis": cost_basis,
        "live_price": live_price,
        "gain_loss_pct": round(gain_pct, 2),
        "triggers": triggers,
    }


async def check_all_positions() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT DISTINCT symbol FROM positions WHERE position_type NOT IN ('Cash_MM')"
        ) as cur:
            symbols = [r["symbol"] for r in await cur.fetchall()]

    results = []
    for sym in symbols:
        risk = await check_risk_triggers(sym)
        if risk and risk["triggers"]:
            results.append(risk)
    return results


async def get_position_risk_summary() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT p.symbol, p.avg_cost_basis, p.total_gain_loss_percent,
                      p.current_value, m.price as live_price
               FROM positions p
               LEFT JOIN market_data m ON p.symbol = m.symbol
               WHERE p.position_type NOT IN ('Cash_MM')
               ORDER BY p.total_gain_loss_percent ASC"""
        ) as cur:
            rows = await cur.fetchall()

    return [
        {
            "symbol": r["symbol"],
            "cost_basis": r["avg_cost_basis"],
            "gain_loss_pct": r["total_gain_loss_percent"],
            "current_value": r["current_value"],
            "live_price": r["live_price"],
            "status": _position_status(r["total_gain_loss_percent"]),
        }
        for r in rows
    ]


def _position_status(gain_pct) -> str:
    if gain_pct is None:
        return "unknown"
    if gain_pct <= STOP_LOSS_PCT:
        return "stop_loss"
    if gain_pct <= SOFT_REVIEW_PCT:
        return "soft_review"
    if gain_pct >= TARGET_2_PCT:
        return "target_2"
    if gain_pct >= TARGET_1_PCT:
        return "target_1"
    return "normal"
