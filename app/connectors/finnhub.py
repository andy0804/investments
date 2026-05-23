import logging
import finnhub
from datetime import date, timedelta
import aiosqlite
from app.config import FINNHUB_API_KEY, DB_PATH
from app.db.schema import log_sync

logger = logging.getLogger(__name__)
_client = finnhub.Client(api_key=FINNHUB_API_KEY)


async def fetch_quote(symbol: str) -> dict | None:
    try:
        q = _client.quote(symbol)
        if not q or q.get("c", 0) == 0:
            return None
        return {
            "symbol": symbol,
            "price": q["c"],
            "change_pct": q.get("dp", 0.0),
            "volume": None,
            "high_52w": q.get("h", None),
            "low_52w": q.get("l", None),
        }
    except Exception as e:
        logger.error("finnhub.fetch_quote failed for %s: %s", symbol, e)
        return None


async def sync_market_data(symbols: list[str]) -> int:
    count = 0
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            for symbol in symbols:
                data = await fetch_quote(symbol)
                if not data:
                    continue
                await db.execute(
                    """INSERT OR REPLACE INTO market_data
                       (symbol, price, change_pct, volume, high_52w, low_52w, fetched_at)
                       VALUES (?,?,?,?,?,?, datetime('now'))""",
                    (data["symbol"], data["price"], data["change_pct"],
                     data["volume"], data["high_52w"], data["low_52w"]),
                )
                count += 1
            await db.commit()
        await log_sync("finnhub_market_data", "success", count)
    except Exception as e:
        logger.error("sync_market_data failed: %s", e)
        await log_sync("finnhub_market_data", "failed", count, str(e))
    return count


async def fetch_company_news(symbol: str, days_back: int = 7) -> list[dict]:
    try:
        end = date.today().isoformat()
        start = (date.today() - timedelta(days=days_back)).isoformat()
        news = _client.company_news(symbol, _from=start, to=end)
        return news[:10] if news else []
    except Exception as e:
        logger.error("finnhub.fetch_company_news failed for %s: %s", symbol, e)
        return []


async def fetch_earnings_calendar(days_ahead: int = 14) -> list[dict]:
    try:
        start = date.today().isoformat()
        end = (date.today() + timedelta(days=days_ahead)).isoformat()
        cal = _client.earnings_calendar(_from=start, to=end, symbol="", international=False)
        return cal.get("earningsCalendar", []) if cal else []
    except Exception as e:
        logger.error("finnhub.fetch_earnings_calendar failed: %s", e)
        return []
