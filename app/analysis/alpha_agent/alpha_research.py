"""
Alpha Research Engine — query and update interface for alpha_pattern_memory.

Used by:
  - portfolio_manager.py: inject historical evidence into committee prompt
  - opportunity_ranking.py: score candidates (uses _query_pattern_memory directly)
  - engine.py: update pattern memory when a position closes (live calibration)
"""

import logging
import aiosqlite
from datetime import datetime, UTC

from app.config import DB_PATH

log = logging.getLogger(__name__)

ALPHA_SOURCES = {
    "Sector Momentum", "Event Catalyst", "Mean Reversion", "Earnings Re-rate", "Macro Theme"
}

_REGIME_SPY_BASELINES = {
    "EVENT_DRIVEN": 1.8,
    "RISK_ON":      2.5,
    "NORMAL":       1.4,
    "RISK_OFF":     0.5,
    "CRISIS":      -1.5,
}


async def get_research(regime: str, alpha_source: str = "", sector: str = "") -> dict:
    """
    Returns best matching historical pattern for the committee to use.
    Always returns a dict — falls back to regime defaults when no match found.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Specific: regime + alpha_source + sector
        if alpha_source and sector:
            async with db.execute(
                """SELECT * FROM alpha_pattern_memory
                   WHERE regime=?
                     AND (alpha_source LIKE ? OR theme LIKE ? OR theme LIKE ?)
                     AND observations >= 3
                   ORDER BY observations DESC, confidence DESC LIMIT 1""",
                (regime, f"%{alpha_source}%", f"%{sector}%", f"%{alpha_source}%"),
            ) as cur:
                row = await cur.fetchone()
            if row:
                return _format_pattern(dict(row))

        # Alpha source only
        if alpha_source:
            async with db.execute(
                """SELECT * FROM alpha_pattern_memory
                   WHERE regime=? AND alpha_source LIKE ? AND observations >= 3
                   ORDER BY observations DESC, confidence DESC LIMIT 1""",
                (regime, f"%{alpha_source}%"),
            ) as cur:
                row = await cur.fetchone()
            if row:
                return _format_pattern(dict(row))

        # Regime only
        async with db.execute(
            """SELECT * FROM alpha_pattern_memory
               WHERE regime=? AND observations >= 3
               ORDER BY observations DESC LIMIT 1""",
            (regime,),
        ) as cur:
            row = await cur.fetchone()
        if row:
            return _format_pattern(dict(row))

    # No match — use regime defaults
    spy_baseline = _REGIME_SPY_BASELINES.get(regime, 1.4)
    return {
        "pattern": f"{regime} / No pattern match",
        "observations": 0,
        "avg_5d_return": 2.0,
        "avg_20d_return": 4.0,
        "avg_spy_return_20d": spy_baseline,
        "avg_alpha": max(4.0 - spy_baseline, 0),
        "confidence": 40,
        "data_source": "regime_default",
        "sufficient_evidence": False,
    }


def _format_pattern(row: dict) -> dict:
    avg_alpha = float(row.get("avg_alpha") or 0)
    avg_20d = float(row.get("avg_20d_return") or 0)
    avg_spy = float(row.get("avg_spy_return_20d") or 0)
    obs = int(row.get("observations") or 0)
    return {
        "pattern": f"{row.get('regime')} / {row.get('alpha_source')} / {row.get('theme', '')}",
        "observations": obs,
        "avg_5d_return": float(row.get("avg_5d_return") or 0),
        "avg_20d_return": avg_20d,
        "avg_spy_return_20d": avg_spy,
        "avg_alpha": avg_alpha,
        "confidence": float(row.get("confidence") or 50),
        "data_source": row.get("data_source", "backtest"),
        "sufficient_evidence": obs >= 10,
    }


def format_for_prompt(research: dict) -> str:
    """Returns a concise block for injection into the committee prompt."""
    obs = research.get("observations", 0)
    evidence_note = "" if research.get("sufficient_evidence") else " [⚠ INSUFFICIENT — < 10 obs, reduce position size]"
    return (
        f"HISTORICAL EVIDENCE FROM PATTERN MEMORY:\n"
        f"  Pattern: {research.get('pattern')}\n"
        f"  Observations: {obs}{evidence_note}\n"
        f"  Avg 5d return: {research.get('avg_5d_return', 0):+.1f}%\n"
        f"  Avg 20d return: {research.get('avg_20d_return', 0):+.1f}%\n"
        f"  Avg SPY same period: {research.get('avg_spy_return_20d', 0):+.1f}%\n"
        f"  Avg alpha vs SPY: {research.get('avg_alpha', 0):+.1f}%\n"
        f"  Pattern confidence: {research.get('confidence', 0):.0f}%"
    )


async def update_with_outcome(
    regime: str,
    alpha_source: str,
    theme: str,
    actual_return_20d: float,
    actual_spy_return_20d: float,
) -> None:
    """
    Updates pattern memory with a live trade outcome.
    Called when a position closes — weighted 3× vs backtest observations.
    """
    if not alpha_source or alpha_source not in ALPHA_SOURCES:
        return
    alpha = actual_return_20d - actual_spy_return_20d
    now = datetime.now(UTC).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_pattern_memory WHERE regime=? AND alpha_source=? AND theme=?",
            (regime, alpha_source, theme),
        ) as cur:
            row = await cur.fetchone()

        if row:
            # Running weighted average: live trades count 3×
            old = dict(row)
            n = old["observations"]
            live_weight = 3
            new_obs = n + live_weight
            new_alpha = (old["avg_alpha"] * n + alpha * live_weight) / new_obs
            new_20d   = (old["avg_20d_return"] * n + actual_return_20d * live_weight) / new_obs
            new_spy   = (old["avg_spy_return_20d"] * n + actual_spy_return_20d * live_weight) / new_obs
            await db.execute(
                """UPDATE alpha_pattern_memory
                   SET observations=?, avg_20d_return=?, avg_spy_return_20d=?,
                       avg_alpha=?, last_updated=?, data_source='live'
                   WHERE id=?""",
                (new_obs, round(new_20d, 2), round(new_spy, 2),
                 round(new_alpha, 2), now, old["id"]),
            )
        else:
            await db.execute(
                """INSERT INTO alpha_pattern_memory
                   (regime, alpha_source, theme, observations,
                    avg_20d_return, avg_spy_return_20d, avg_alpha,
                    confidence, data_source, last_updated)
                   VALUES (?,?,?,3,?,?,?,55,'live',?)""",
                (regime, alpha_source, theme,
                 round(actual_return_20d, 2), round(actual_spy_return_20d, 2),
                 round(alpha, 2), now),
            )
        await db.commit()
    log.info("alpha_research: updated pattern %s/%s/%s → alpha %.1f%%",
             regime, alpha_source, theme, alpha)
