"""
Opportunity Ranking — ranks promoted/watchlist stocks by expected alpha vs SPY.

Queries alpha_pattern_memory for historical context.
Falls back to regime-aware defaults when pattern memory is sparse.
Minimum hurdle: expected alpha > 3% over 20 days.
"""

import logging
import aiosqlite
from datetime import datetime, UTC

from app.config import DB_PATH

log = logging.getLogger(__name__)

# Regime-aware defaults when no pattern memory exists yet
_REGIME_DEFAULTS = {
    "EVENT_DRIVEN": {"avg_alpha": 4.5, "confidence": 58},
    "RISK_ON":      {"avg_alpha": 3.2, "confidence": 52},
    "NORMAL":       {"avg_alpha": 1.8, "confidence": 45},
    "RISK_OFF":     {"avg_alpha": 0.5, "confidence": 35},
    "CRISIS":       {"avg_alpha": -2.0, "confidence": 25},
}

MIN_ALPHA_HURDLE = 3.0  # % over 20 days — below this → no trade

# Tier thresholds (composite score 0-100)
TIER_FULL   = 80
TIER_LIGHT  = 50
TIER_WATCH  = 20


async def _query_pattern_memory(regime: str, sector: str = "") -> dict | None:
    """Queries alpha_pattern_memory for best matching pattern."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if sector:
            async with db.execute(
                """SELECT * FROM alpha_pattern_memory
                   WHERE regime=? AND (theme LIKE ? OR alpha_source LIKE ?)
                     AND observations >= 3
                   ORDER BY observations DESC, confidence DESC LIMIT 1""",
                (regime, f"%{sector}%", f"%{sector}%"),
            ) as cur:
                row = await cur.fetchone()
            if row:
                return dict(row)
        # Regime-level fallback
        async with db.execute(
            """SELECT * FROM alpha_pattern_memory
               WHERE regime=? AND observations >= 3
               ORDER BY observations DESC, confidence DESC LIMIT 1""",
            (regime,),
        ) as cur:
            row = await cur.fetchone()
        return dict(row) if row else None


def _compute_score(
    price_move: float,
    vol_ratio: float,
    regime: str,
    sector: str,
    pattern: dict | None,
) -> tuple[float, float, int, str]:
    """
    Returns (expected_alpha, confidence, tier_score, data_source).
    tier_score 0-100 drives tier assignment.
    """
    if pattern:
        expected_alpha = float(pattern.get("avg_alpha") or 2.0)
        confidence = float(pattern.get("confidence") or 50)
        observations = int(pattern.get("observations") or 0)
        data_source = f"{pattern.get('data_source','backtest')} ({observations} obs)"
    else:
        defaults = _REGIME_DEFAULTS.get(regime, {"avg_alpha": 1.8, "confidence": 45})
        expected_alpha = defaults["avg_alpha"]
        confidence = defaults["confidence"]
        data_source = "regime_default"

    # Adjust for move size: larger moves get alpha boost in EVENT_DRIVEN
    if regime == "EVENT_DRIVEN" and abs(price_move) >= 5.0:
        expected_alpha = min(expected_alpha + 0.8, 12.0)
        confidence = min(confidence + 5, 90)
    elif abs(price_move) >= 4.0:
        expected_alpha = min(expected_alpha + 0.3, 12.0)

    # Volume confirmation
    if vol_ratio >= 2.5:
        expected_alpha = min(expected_alpha + 0.4, 12.0)
        confidence = min(confidence + 3, 90)

    # Composite score: alpha drives 70%, confidence 30%
    alpha_score = min(expected_alpha / 10.0 * 100, 100)
    tier_score = round(alpha_score * 0.7 + confidence * 0.3)

    return round(expected_alpha, 1), round(confidence), tier_score, data_source


def _assign_tier(score: int) -> tuple[str, str]:
    if score >= TIER_FULL:
        return "FULL_COMMITTEE", "Full Committee"
    if score >= TIER_LIGHT:
        return "LIGHT_REVIEW", "Light Review"
    if score >= TIER_WATCH:
        return "WATCH", "Watch"
    return "IGNORE", "Ignore"


async def rank_opportunities(
    moving_stocks: list[dict],
    narrative: dict,
) -> list[dict]:
    """
    Ranks all stocks with price/volume events by expected alpha vs SPY.

    moving_stocks: list of {ticker, price_move, vol_ratio, sector, ...}
    narrative: from macro_intelligence.analyze_market_narrative()
    Returns list sorted by expected_alpha_20d descending.
    """
    regime = narrative.get("regime", "NORMAL")
    ranked: list[dict] = []

    for stock in moving_stocks:
        ticker = stock["ticker"]
        sector = stock.get("sector", "")
        price_move = float(stock.get("price_move", 0))
        vol_ratio = float(stock.get("vol_ratio", 1.0))

        pattern = await _query_pattern_memory(regime, sector)
        expected_alpha, confidence, score, data_source = _compute_score(
            price_move, vol_ratio, regime, sector, pattern
        )
        tier, tier_label = _assign_tier(score)

        ranked.append({
            "ticker": ticker,
            "price_move": round(price_move, 1),
            "vol_ratio": round(vol_ratio, 1),
            "sector": sector,
            "expected_alpha_20d": expected_alpha,
            "confidence": confidence,
            "score": score,
            "tier": tier,
            "tier_label": tier_label,
            "meets_hurdle": expected_alpha >= MIN_ALPHA_HURDLE,
            "data_source": data_source,
            "regime": regime,
        })

    ranked.sort(key=lambda x: x["expected_alpha_20d"], reverse=True)
    return ranked


async def log_counterfactual(
    ticker: str,
    reason_passed: str,
    price_at_pass: float,
    expected_alpha: float,
    regime: str,
    theme: str,
) -> None:
    """Logs a passed opportunity to alpha_agent_counterfactuals for outcome tracking."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """INSERT INTO alpha_agent_counterfactuals
                   (ticker, passed_at, reason_passed, price_at_pass,
                    expected_alpha_at_pass, regime, theme)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    ticker.upper(),
                    datetime.now(UTC).isoformat(),
                    reason_passed,
                    price_at_pass,
                    expected_alpha,
                    regime,
                    theme,
                ),
            )
            await db.commit()
    except Exception as e:
        log.debug("counterfactual log failed for %s: %s", ticker, e)
