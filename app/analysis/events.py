import logging
import aiosqlite
from app.config import DB_PATH

logger = logging.getLogger(__name__)


async def get_recent_events(limit: int = 20, symbols: list[str] = None) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if symbols:
            placeholders = ",".join("?" * len(symbols))
            query = f"""SELECT * FROM events
                        WHERE related_symbols IN ({placeholders}) OR related_symbols IS NULL
                        ORDER BY fetched_at DESC LIMIT ?"""
            params = symbols + [limit]
        else:
            query = "SELECT * FROM events ORDER BY fetched_at DESC LIMIT ?"
            params = [limit]
        async with db.execute(query, params) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def score_events_for_portfolio(symbols: list[str]) -> list[dict]:
    events = await get_recent_events(limit=50, symbols=symbols)
    scored = []
    for event in events:
        tone = event.get("tone") or 0
        score = min(10, max(1, int(5 + (tone / 10))))
        scored.append({**event, "computed_score": score})
    return sorted(scored, key=lambda x: abs(x["computed_score"] - 5), reverse=True)[:10]
