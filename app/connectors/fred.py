import logging
import requests
import aiosqlite
from app.config import FRED_API_KEY, DB_PATH
from app.db.schema import log_sync

logger = logging.getLogger(__name__)
BASE = "https://api.stlouisfed.org/fred"
TIMEOUT = 15


async def sync_vix() -> float | None:
    try:
        r = requests.get(
            f"{BASE}/series/observations",
            params={
                "series_id": "VIXCLS",
                "limit": 5,
                "sort_order": "desc",
                "api_key": FRED_API_KEY,
                "file_type": "json",
            },
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        obs = r.json().get("observations", [])
        valid = [o for o in obs if o.get("value") not in (".", "")]
        if not valid:
            return None
        latest = valid[0]
        vix_value = float(latest["value"])
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "INSERT OR REPLACE INTO vix_history (date, value) VALUES (?,?)",
                (latest["date"], vix_value),
            )
            await db.commit()
        await log_sync("fred_vix", "success", 1)
        logger.info("VIX synced: %.2f on %s", vix_value, latest["date"])
        return vix_value
    except Exception as e:
        logger.error("fred.sync_vix failed: %s", e)
        await log_sync("fred_vix", "failed", 0, str(e))
        return None


async def get_latest_vix() -> float | None:
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT value FROM vix_history ORDER BY date DESC LIMIT 1"
            ) as cur:
                row = await cur.fetchone()
        return row[0] if row else None
    except Exception as e:
        logger.error("get_latest_vix failed: %s", e)
        return None
