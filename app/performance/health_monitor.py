import logging
import requests
import finnhub
from app.config import (FINNHUB_API_KEY, FRED_API_KEY, FMP_API_KEY,
                         TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY)
from app.db.schema import log_sync

logger = logging.getLogger(__name__)
TIMEOUT = 10

_failure_counts: dict[str, int] = {}
ALERT_THRESHOLD = 3


async def check_all_apis() -> dict:
    results = {}

    results["finnhub"] = _check_finnhub()
    results["fred"] = _check_fred()
    results["fmp"] = _check_fmp()
    results["telegram"] = _check_telegram()
    results["edgar"] = _check_edgar()

    for name, status in results.items():
        if status != "ok":
            _failure_counts[name] = _failure_counts.get(name, 0) + 1
            if _failure_counts[name] >= ALERT_THRESHOLD:
                logger.error("HEALTH ALERT: %s has failed %d times in a row", name, _failure_counts[name])
        else:
            _failure_counts[name] = 0

    await log_sync("health_monitor", "success", len(results))
    return results


def _check_finnhub() -> str:
    try:
        client = finnhub.Client(api_key=FINNHUB_API_KEY)
        q = client.quote("AAPL")
        return "ok" if q and q.get("c", 0) > 0 else "degraded"
    except Exception as e:
        return f"error: {str(e)[:50]}"


def _check_fred() -> str:
    try:
        r = requests.get(
            "https://api.stlouisfed.org/fred/series/observations",
            params={"series_id": "VIXCLS", "limit": 1, "sort_order": "desc",
                    "api_key": FRED_API_KEY, "file_type": "json"},
            timeout=TIMEOUT,
        )
        return "ok" if r.status_code == 200 else f"http_{r.status_code}"
    except Exception as e:
        return f"error: {str(e)[:50]}"


def _check_fmp() -> str:
    try:
        r = requests.get(
            "https://financialmodelingprep.com/stable/quote",
            params={"symbol": "AAPL", "apikey": FMP_API_KEY},
            timeout=TIMEOUT,
        )
        return "ok" if r.status_code == 200 else f"http_{r.status_code}"
    except Exception as e:
        return f"error: {str(e)[:50]}"


def _check_telegram() -> str:
    try:
        r = requests.get(f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getMe", timeout=TIMEOUT)
        return "ok" if r.json().get("ok") else "degraded"
    except Exception as e:
        return f"error: {str(e)[:50]}"


def _check_edgar() -> str:
    try:
        r = requests.get(
            "https://efts.sec.gov/LATEST/search-index?q=AAPL&hits.hits.total=1",
            headers={"User-Agent": "investment-agent ananth.bhagyavahana@gmail.com"},
            timeout=TIMEOUT,
        )
        return "ok" if r.status_code == 200 else f"http_{r.status_code}"
    except Exception as e:
        return f"error: {str(e)[:50]}"
