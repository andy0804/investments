"""
Finnhub MCP connector — wraps existing Finnhub API as structured tool functions
the Research Agent can call. Returns standardised dicts for agent consumption.
"""

import os
import logging
import httpx
from datetime import datetime, timedelta, UTC

log = logging.getLogger(__name__)
_KEY = os.getenv("FINNHUB_API_KEY", "")
_BASE = "https://finnhub.io/api/v1"


async def _get(endpoint: str, params: dict = {}) -> dict | list:
    params = {"token": _KEY, **params}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(f"{_BASE}{endpoint}", params=params)
            r.raise_for_status()
            return r.json()
    except Exception as e:
        log.warning("Finnhub MCP %s failed: %s", endpoint, e)
        return {}


async def get_company_news(ticker: str, days_back: int = 7) -> list[dict]:
    """Recent news articles for a ticker."""
    today = datetime.now(UTC).date()
    from_date = (today - timedelta(days=days_back)).isoformat()
    data = await _get("/company-news", {"symbol": ticker.upper(), "from": from_date, "to": today.isoformat()})
    if not isinstance(data, list):
        return []
    return [{"headline": a.get("headline"), "source": a.get("source"), "url": a.get("url"),
             "datetime": a.get("datetime"), "summary": a.get("summary")} for a in data[:15]]


async def get_earnings_estimates(ticker: str) -> dict:
    """Analyst EPS estimates and revisions."""
    data = await _get("/stock/eps-estimate", {"symbol": ticker.upper(), "freq": "quarterly"})
    return data if isinstance(data, dict) else {}


async def get_analyst_recommendations(ticker: str) -> list[dict]:
    """Latest analyst buy/sell/hold ratings."""
    data = await _get("/stock/recommendation", {"symbol": ticker.upper()})
    if not isinstance(data, list):
        return []
    return data[:6]


async def get_price_target(ticker: str) -> dict:
    """Analyst consensus price target."""
    data = await _get("/stock/price-target", {"symbol": ticker.upper()})
    return data if isinstance(data, dict) else {}


async def get_basic_financials(ticker: str) -> dict:
    """Key financial metrics (PE, revenue growth, margins, etc.)."""
    data = await _get("/stock/metric", {"symbol": ticker.upper(), "metric": "all"})
    return data.get("metric", {}) if isinstance(data, dict) else {}


async def get_earnings_surprises(ticker: str, limit: int = 4) -> list[dict]:
    """Recent earnings vs estimate surprises."""
    data = await _get("/stock/earnings", {"symbol": ticker.upper(), "limit": limit})
    if not isinstance(data, list):
        return []
    return data


async def build_research_brief(ticker: str) -> dict:
    """Aggregate all Finnhub data for the Research Agent."""
    import asyncio
    news, estimates, recs, target, financials, surprises = await asyncio.gather(
        get_company_news(ticker, 14),
        get_earnings_estimates(ticker),
        get_analyst_recommendations(ticker),
        get_price_target(ticker),
        get_basic_financials(ticker),
        get_earnings_surprises(ticker),
        return_exceptions=True,
    )

    def _safe(v, default):
        return v if not isinstance(v, Exception) else default

    return {
        "ticker":           ticker.upper(),
        "source":           "finnhub",
        "news":             _safe(news, []),
        "earnings_estimates": _safe(estimates, {}),
        "analyst_ratings":  _safe(recs, []),
        "price_target":     _safe(target, {}),
        "financials":       _safe(financials, {}),
        "earnings_surprises": _safe(surprises, []),
    }
