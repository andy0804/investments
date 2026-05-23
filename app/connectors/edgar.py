import logging
import requests
import aiosqlite
from datetime import date, timedelta, datetime
from app.config import DB_PATH
from app.db.schema import log_sync

logger = logging.getLogger(__name__)
BASE = "https://efts.sec.gov/LATEST/search-index"
HEADERS = {"User-Agent": "investment-agent ananth.bhagyavahana@gmail.com"}
TIMEOUT = 20


async def sync_sec_filings(symbols: list[str]) -> int:
    count = 0
    end = date.today().isoformat()
    start = (date.today() - timedelta(days=7)).isoformat()

    try:
        async with aiosqlite.connect(DB_PATH) as db:
            for symbol in symbols[:10]:
                try:
                    r = requests.get(
                        BASE,
                        params={
                            "q": f'"{symbol}"',
                            "forms": "8-K,10-Q,10-K",
                            "dateRange": "custom",
                            "startdt": start,
                            "enddt": end,
                        },
                        headers=HEADERS,
                        timeout=TIMEOUT,
                    )
                    r.raise_for_status()
                    data = r.json()
                    hits = data.get("hits", {}).get("hits", [])
                    for hit in hits[:3]:
                        src = hit.get("_source", {})
                        title = src.get("display_names", [symbol])[0] if src.get("display_names") else symbol
                        form = src.get("file_type", "filing")
                        await db.execute(
                            """INSERT INTO events (source, event_type, title, url, impact_score, related_symbols, event_date)
                               VALUES (?,?,?,?,?,?,?)""",
                            (
                                "edgar",
                                form,
                                f"{symbol} {form}: {title}"[:500],
                                f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company={symbol}&type={form}&dateb=&owner=include&count=5",
                                5.0,
                                symbol,
                                datetime.utcnow().isoformat(),
                            ),
                        )
                        count += 1
                except Exception as e:
                    logger.error("edgar fetch failed for %s: %s", symbol, e)
            await db.commit()
        await log_sync("edgar_filings", "success", count)
    except Exception as e:
        logger.error("sync_sec_filings failed: %s", e)
        await log_sync("edgar_filings", "failed", count, str(e))
    return count
