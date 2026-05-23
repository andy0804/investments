import logging
import aiosqlite
from app.config import DB_PATH, PORTFOLIO_SIZE, MAX_SINGLE_POSITION_PCT

logger = logging.getLogger(__name__)


def kelly_fraction(win_rate: float, avg_win_pct: float, avg_loss_pct: float) -> float:
    if avg_loss_pct == 0:
        return 0.0
    b = avg_win_pct / avg_loss_pct
    f = (b * win_rate - (1 - win_rate)) / b
    return max(0.0, min(f, 0.25))


async def compute_kelly_for_symbol(symbol: str) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT action, quantity, price,
                      LAG(price) OVER (PARTITION BY symbol ORDER BY traded_at) as prev_price
               FROM trade_log WHERE symbol = ? ORDER BY traded_at""",
            (symbol,),
        ) as cur:
            trades = await cur.fetchall()

    if len(trades) < 2:
        return _default_sizing(symbol)

    returns = []
    for t in trades:
        if t["prev_price"] and t["prev_price"] > 0:
            r = (t["price"] - t["prev_price"]) / t["prev_price"]
            returns.append(r)

    if not returns:
        return _default_sizing(symbol)

    wins = [r for r in returns if r > 0]
    losses = [r for r in returns if r < 0]
    win_rate = len(wins) / len(returns) if returns else 0.5
    avg_win = sum(wins) / len(wins) * 100 if wins else 5.0
    avg_loss = abs(sum(losses) / len(losses)) * 100 if losses else 3.0

    frac = kelly_fraction(win_rate, avg_win, avg_loss)
    half_kelly_pct = round(frac * 50, 2)
    suggested_pct = min(half_kelly_pct, MAX_SINGLE_POSITION_PCT)

    result = {
        "symbol": symbol,
        "win_rate": round(win_rate, 3),
        "avg_win_pct": round(avg_win, 2),
        "avg_loss_pct": round(avg_loss, 2),
        "kelly_fraction": round(frac, 4),
        "suggested_position_pct": suggested_pct,
        "suggested_dollar": round(PORTFOLIO_SIZE * suggested_pct / 100, 0),
    }

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT OR REPLACE INTO kelly_stats
               (symbol, win_rate, avg_win, avg_loss, kelly_fraction, suggested_position_pct)
               VALUES (?,?,?,?,?,?)""",
            (symbol, result["win_rate"], result["avg_win_pct"],
             result["avg_loss_pct"], result["kelly_fraction"], suggested_pct),
        )
        await db.commit()

    return result


def _default_sizing(symbol: str) -> dict:
    default_pct = min(5.0, MAX_SINGLE_POSITION_PCT)
    return {
        "symbol": symbol,
        "win_rate": None,
        "avg_win_pct": None,
        "avg_loss_pct": None,
        "kelly_fraction": None,
        "suggested_position_pct": default_pct,
        "suggested_dollar": round(PORTFOLIO_SIZE * default_pct / 100, 0),
        "note": "Insufficient trade history — using default sizing",
    }
