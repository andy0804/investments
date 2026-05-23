import logging
import requests
from datetime import date, timedelta
from app.config import FMP_API_KEY
from app.db.schema import log_sync

logger = logging.getLogger(__name__)
BASE = "https://financialmodelingprep.com/stable"
TIMEOUT = 15


def _get(endpoint: str, params: dict = None) -> list | dict | None:
    try:
        p = {"apikey": FMP_API_KEY, **(params or {})}
        r = requests.get(f"{BASE}/{endpoint}", params=p, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()
        if isinstance(data, dict) and "Error Message" in data:
            logger.error("FMP error on %s: %s", endpoint, data["Error Message"])
            return None
        return data
    except Exception as e:
        logger.error("FMP request failed (%s): %s", endpoint, e)
        return None


async def get_quote(symbol: str) -> dict | None:
    data = _get("quote", {"symbol": symbol})
    if data and isinstance(data, list) and len(data) > 0:
        return data[0]
    return None


async def get_earnings_calendar(days_ahead: int = 28) -> list[dict]:
    start = date.today().isoformat()
    end = (date.today() + timedelta(days=days_ahead)).isoformat()
    data = _get("earnings-calendar", {"from": start, "to": end})
    return data if isinstance(data, list) else []


async def get_company_profile(symbol: str) -> dict | None:
    data = _get("profile", {"symbol": symbol})
    if data and isinstance(data, list) and len(data) > 0:
        return data[0]
    return None


async def get_income_statement(symbol: str, limit: int = 4) -> list[dict]:
    data = _get("income-statement", {"symbol": symbol, "limit": limit})
    return data if isinstance(data, list) else []


async def get_historical_prices(symbol: str, days_back: int = 90) -> list[dict]:
    start = (date.today() - timedelta(days=days_back)).isoformat()
    data = _get("historical-price-eod/full", {"symbol": symbol, "from": start})
    return data if isinstance(data, list) else []
