import logging
import aiosqlite
from app.config import DB_PATH
from app.connectors.fred import get_latest_vix, sync_vix

logger = logging.getLogger(__name__)


async def get_macro_snapshot() -> dict:
    vix = await get_latest_vix()
    if vix is None:
        vix = await sync_vix()

    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT date, value FROM vix_history ORDER BY date DESC LIMIT 5"
        ) as cur:
            vix_history = [{"date": r[0], "value": r[1]} for r in await cur.fetchall()]

        # SPY 1-day return as a proxy from cached market_data
        async with db.execute(
            "SELECT price, change_pct FROM market_data WHERE symbol='SPY' LIMIT 1"
        ) as cur:
            spy_row = await cur.fetchone()

    vix_trend = None
    if len(vix_history) >= 2:
        recent = vix_history[0]["value"]
        older = vix_history[-1]["value"]
        vix_trend = "rising" if recent > older else "falling"

    # Use SPY's stored 1-day change_pct as the header badge value
    spy_10d = None
    if spy_row and spy_row[1] is not None:
        try:
            spy_10d = round(float(spy_row[1]), 2)
        except Exception:
            pass

    regime = _regime_label(vix)

    return {
        "vix": vix,
        "vix_level": _vix_level(vix),
        "vix_signal": _vix_signal(vix),
        "vix_trend": vix_trend,
        "vix_history": vix_history,
        "market_regime": _market_regime(vix),
        "regime": regime,
        "spy_10d": spy_10d,
    }


def _vix_level(vix) -> str:
    if not vix:
        return "unknown"
    if vix < 15:
        return "calm"
    if vix < 20:
        return "normal"
    if vix < 30:
        return "elevated"
    return "high_fear"


def _vix_signal(vix) -> str:
    if not vix:
        return "VIX data unavailable"
    if vix < 15:
        return "Market is calm — low fear, investors complacent"
    if vix < 20:
        return "Normal market conditions"
    if vix < 30:
        return "Elevated uncertainty — consider tighter stops"
    return "High fear — potential opportunity for long-term buys, but expect volatility"


def _market_regime(vix) -> str:
    if not vix:
        return "unknown"
    if vix < 20:
        return "risk_on"
    if vix < 30:
        return "neutral"
    return "risk_off"


def _regime_label(vix) -> str:
    """BULL/CHOP/BEAR label matching SOTD engine output."""
    if not vix:
        return "UNKNOWN"
    if vix < 20:
        return "BULL"
    if vix < 30:
        return "CHOP"
    return "BEAR"
