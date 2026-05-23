import logging
import feedparser
import aiosqlite
from datetime import datetime
from app.config import DB_PATH, RSS_FEEDS
from app.db.schema import log_sync

logger = logging.getLogger(__name__)


def _parse_feed(url: str) -> list[dict]:
    try:
        feed = feedparser.parse(url)
        articles = []
        for entry in feed.entries[:5]:
            articles.append({
                "title": entry.get("title", "")[:500],
                "url": entry.get("link", "")[:500],
                "published": entry.get("published", datetime.utcnow().isoformat()),
            })
        return articles
    except Exception as e:
        logger.error("rss parse failed for %s: %s", url, e)
        return []


async def sync_rss_news() -> int:
    all_articles = []
    for feed_url in RSS_FEEDS:
        articles = _parse_feed(feed_url)
        all_articles.extend(articles)

    if not all_articles:
        await log_sync("rss_news", "failed", 0, "No articles parsed")
        return 0

    count = 0
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            for article in all_articles:
                try:
                    await db.execute(
                        """INSERT INTO events (source, event_type, title, url, event_date)
                           VALUES (?,?,?,?,?)""",
                        ("rss", "news", article["title"], article["url"], datetime.utcnow().isoformat()),
                    )
                    count += 1
                except Exception:
                    pass
            await db.commit()
        await log_sync("rss_news", "success", count)
    except Exception as e:
        logger.error("sync_rss_news failed: %s", e)
        await log_sync("rss_news", "failed", count, str(e))
    return count
