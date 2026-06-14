"""
RSS MCP connector — wraps existing feedparser usage as structured tool functions
for the Research Agent. Fetches relevant headlines for a given ticker.
"""

import logging
import asyncio
import feedparser

log = logging.getLogger(__name__)

NEWS_FEEDS = [
    "https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}&region=US&lang=en-US",
    "https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best",
    "https://feeds.marketwatch.com/marketwatch/topstories/",
    "https://www.fool.com/feeds/index.aspx",
]


def _fetch_ticker_headlines(ticker: str, max_items: int = 15) -> list[dict]:
    results = []
    # Yahoo Finance per-ticker RSS
    url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}&region=US&lang=en-US"
    try:
        feed = feedparser.parse(url)
        for entry in feed.entries[:max_items]:
            results.append({
                "title":     entry.get("title", ""),
                "source":    "yahoo_finance",
                "url":       entry.get("link", ""),
                "published": entry.get("published", ""),
                "summary":   entry.get("summary", "")[:300],
            })
    except Exception as e:
        log.warning("RSS fetch failed for %s: %s", ticker, e)
    return results


def _fetch_market_headlines(max_items: int = 10) -> list[dict]:
    """General market news that may affect any position."""
    results = []
    feeds = [
        "https://feeds.marketwatch.com/marketwatch/topstories/",
    ]
    for url in feeds:
        try:
            feed = feedparser.parse(url)
            for entry in feed.entries[:max_items]:
                results.append({
                    "title":     entry.get("title", ""),
                    "source":    "marketwatch",
                    "url":       entry.get("link", ""),
                    "published": entry.get("published", ""),
                })
        except Exception as e:
            log.warning("RSS market headlines failed: %s", e)
    return results[:max_items]


async def get_ticker_headlines(ticker: str, max_items: int = 15) -> list[dict]:
    return await asyncio.to_thread(_fetch_ticker_headlines, ticker, max_items)


async def get_market_headlines(max_items: int = 10) -> list[dict]:
    return await asyncio.to_thread(_fetch_market_headlines, max_items)


async def build_research_brief(ticker: str) -> dict:
    ticker_news, market_news = await asyncio.gather(
        get_ticker_headlines(ticker),
        get_market_headlines(),
        return_exceptions=True,
    )
    return {
        "ticker":       ticker.upper(),
        "source":       "rss",
        "ticker_news":  ticker_news if isinstance(ticker_news, list) else [],
        "market_news":  market_news if isinstance(market_news, list) else [],
    }
