import logging
import time
import requests
import aiosqlite
from datetime import datetime
from app.config import DB_PATH
from app.db.schema import log_sync

logger = logging.getLogger(__name__)
BASE = "https://api.gdeltproject.org/api/v2/doc/doc"
TIMEOUT = 30


def _gdelt_request(query: str, max_records: int = 10) -> list[dict]:
    for attempt in range(3):
        try:
            r = requests.get(
                BASE,
                params={"query": query, "mode": "artlist", "maxrecords": max_records, "format": "json"},
                timeout=TIMEOUT,
            )
            if r.status_code == 429:
                wait = 10 * (attempt + 1)
                logger.warning("GDELT rate limited, waiting %ds (attempt %d)", wait, attempt + 1)
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.json().get("articles", [])
        except requests.exceptions.ReadTimeout:
            logger.warning("GDELT timeout on attempt %d", attempt + 1)
            time.sleep(5)
        except Exception as e:
            logger.error("GDELT request failed: %s", e)
            break
    return []


async def sync_geopolitical_events(symbols: list[str]) -> int:
    queries = ["stock market geopolitical", "US economy trade war", "federal reserve inflation"]
    for sym in symbols[:5]:
        queries.append(f"{sym} stock")

    all_articles = []
    for query in queries[:4]:
        articles = _gdelt_request(query, max_records=5)
        all_articles.extend(articles)
        time.sleep(2)

    if not all_articles:
        await log_sync("gdelt_events", "failed", 0, "No articles returned")
        return 0

    seen_urls = set()
    unique = []
    for a in all_articles:
        url = a.get("url", "")
        if url and url not in seen_urls:
            seen_urls.add(url)
            unique.append(a)

    count = 0
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            for article in unique:
                await db.execute(
                    """INSERT INTO events (source, event_type, title, url, tone, impact_score, event_date)
                       VALUES (?,?,?,?,?,?,?)""",
                    (
                        "gdelt",
                        "news",
                        article.get("title", "")[:500],
                        article.get("url", "")[:500],
                        float(article.get("tone", 0) or 0),
                        None,
                        datetime.utcnow().isoformat(),
                    ),
                )
                count += 1
            await db.commit()
        await log_sync("gdelt_events", "success", count)
    except Exception as e:
        logger.error("gdelt insert failed: %s", e)
        await log_sync("gdelt_events", "failed", count, str(e))
    return count
