"""
app/performance/best_bet.py

Pattern-match the entire pick history against today's candidates to surface
the one stock that best fits conditions that have actually worked.

Flow:
  1. compute_patterns()      → win rates by regime / score bucket / sector
  2. score_candidates()      → rank today's candidates against those patterns
  3. generate_rationale()    → one Haiku call for the #1 pick
  4. get_best_bet()          → cached orchestrator (1 call per day)
"""

import json
import logging
from datetime import date, datetime, UTC

import aiosqlite

from app.config import DB_PATH

logger = logging.getLogger(__name__)

_CACHE: dict = {}   # in-memory: {date_str: result_dict}


# ── Pattern computation ───────────────────────────────────────────────────────

async def compute_patterns() -> dict:
    """
    Read all evaluated signal outcomes and return win-rate breakdowns by
    regime, score bucket, and sector.  Only cells with ≥2 picks are shown.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT
                 se.ticker, se.confidence_score, se.regime, se.signal_type, se.tier,
                 sp.signal_json,
                 so.alpha_14d, so.return_14d, so.outcome
               FROM signal_events se
               JOIN signal_outcomes so ON so.signal_event_id = se.id
               LEFT JOIN stock_picks sp
                 ON sp.symbol = se.ticker AND date(sp.pick_date) = se.pick_date
               WHERE so.outcome IS NOT NULL""",
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]

    if not rows:
        return {"total_evaluated": 0, "by_regime": {}, "by_score_bucket": {}, "by_sector": {}}

    def _stats(subset: list) -> dict:
        wins = [r for r in subset if r["outcome"] == "win"]
        alphas = [r["alpha_14d"] for r in subset if r["alpha_14d"] is not None]
        return {
            "count":    len(subset),
            "wins":     len(wins),
            "win_rate": round(len(wins) / len(subset), 3) if subset else None,
            "avg_alpha_14d": round(sum(alphas) / len(alphas), 2) if alphas else None,
        }

    def _wr(subset: list) -> float:
        if not subset:
            return 0.0
        wins = sum(1 for r in subset if r["outcome"] == "win")
        return wins / len(subset)

    # Overall
    overall = _stats(rows)
    overall_wr = _wr(rows)

    # By regime
    by_regime: dict[str, dict] = {}
    for regime in ("BULL", "BEAR", "CHOP"):
        sub = [r for r in rows if r["regime"] == regime]
        if len(sub) >= 2:
            by_regime[regime] = _stats(sub)

    # By score bucket
    def _bucket(score):
        if score is None:
            return None
        if score >= 85:
            return "85+"
        if score >= 75:
            return "75-84"
        if score >= 65:
            return "65-74"
        return "50-64"

    by_score: dict[str, dict] = {}
    for label in ("85+", "75-84", "65-74", "50-64"):
        sub = [r for r in rows if _bucket(r["confidence_score"]) == label]
        if len(sub) >= 2:
            by_score[label] = _stats(sub)

    # By sector (extracted from stock_picks.signal_json → all_candidates)
    by_sector: dict[str, dict] = {}
    sector_map: dict[str, str] = {}
    for r in rows:
        if r.get("signal_json"):
            try:
                sig = json.loads(r["signal_json"])
                for c in sig.get("all_candidates", []):
                    if c.get("ticker") == r["ticker"] and c.get("sector"):
                        sector_map[r["ticker"]] = c["sector"]
                        break
            except Exception:
                pass

    sector_rows = [dict(r, sector=sector_map.get(r["ticker"])) for r in rows]
    sectors = {r["sector"] for r in sector_rows if r.get("sector")}
    for sec in sectors:
        sub = [r for r in sector_rows if r.get("sector") == sec]
        if len(sub) >= 2:
            by_sector[sec] = _stats(sub)

    return {
        "total_evaluated": len(rows),
        "total_wins":      overall["wins"],
        "overall_win_rate": overall_wr,
        "avg_alpha_14d":   overall["avg_alpha_14d"],
        "by_regime":       by_regime,
        "by_score_bucket": by_score,
        "by_sector":       by_sector,
        "_wr_fn":          _wr,
        "_bucket_fn":      _bucket,
        "_raw_rows":       rows,
        "_sector_map":     sector_map,
    }


# ── Candidate scoring ─────────────────────────────────────────────────────────

def _score_candidate(
    candidate: dict,
    regime: str,
    patterns: dict,
) -> float:
    """
    Compute a 0–1 match score for this candidate against historical patterns.
    Higher = more like conditions that have actually produced wins.
    """
    wr_fn     = patterns["_wr_fn"]
    bucket_fn = patterns["_bucket_fn"]

    regime_data = patterns["by_regime"].get(regime)
    regime_wr   = regime_data["win_rate"] if regime_data else patterns["overall_win_rate"]

    score_bkt    = bucket_fn(candidate.get("score"))
    score_data   = patterns["by_score_bucket"].get(score_bkt) if score_bkt else None
    score_wr     = score_data["win_rate"] if score_data else patterns["overall_win_rate"]

    sector       = candidate.get("sector")
    sector_data  = patterns["by_sector"].get(sector) if sector else None
    sector_wr    = sector_data["win_rate"] if sector_data else None

    if sector_wr is not None:
        match = regime_wr * 0.40 + score_wr * 0.40 + sector_wr * 0.20
    else:
        match = regime_wr * 0.50 + score_wr * 0.50

    return round(match, 3)


def _confidence_label(match_score: float, sample_n: int) -> str:
    if match_score >= 0.65 and sample_n >= 5:
        return "HIGH"
    if match_score >= 0.50 and sample_n >= 3:
        return "MEDIUM"
    return "LOW"


# ── Haiku rationale ───────────────────────────────────────────────────────────

async def _generate_rationale(pick: dict, patterns: dict, regime: str, market_ctx: dict) -> dict:
    """One Haiku call to narrate why this pick is the best match today."""
    from app.analysis.claude_engine import call_claude

    regime_data  = patterns["by_regime"].get(regime, {})
    regime_wr    = f"{round((regime_data.get('win_rate') or 0) * 100)}%"
    regime_n     = regime_data.get("count", 0)

    bkt          = patterns["_bucket_fn"](pick.get("score"))
    score_data   = patterns["by_score_bucket"].get(bkt, {})
    score_wr     = f"{round((score_data.get('win_rate') or 0) * 100)}%"
    score_n      = score_data.get("count", 0)

    m            = pick.get("metrics", {})
    vix          = market_ctx.get("vix", "N/A")
    spy          = market_ctx.get("spy_10d", "N/A")

    prompt = f"""You are summarizing why a stock is the best bet today based on pick history patterns.

Current market: {regime} regime, VIX {vix}, SPY 10d {spy}%

Today's top-ranked pick:
- Ticker: {pick['ticker']} ({pick.get('company','')})
- Sector: {pick.get('sector','—')}
- Pipeline score: {pick.get('score','—')}/100
- RSI: {m.get('rsi','—')}, Vol ratio: {m.get('vol_ratio','—')}x, 10d return: {m.get('return_10d','—')}%

Historical win rates for these exact conditions:
- {regime} regime: {regime_wr} ({regime_n} picks)
- Score bucket {bkt}: {score_wr} ({score_n} picks)
- Overall system: {round(patterns['overall_win_rate']*100)}% ({patterns['total_evaluated']} picks)

Pattern match score: {round(pick['match_score']*100)}%

Return ONLY valid JSON with exactly these keys (no markdown, no extra text):
{{
  "rationale": "2-3 sentences. Reference the actual win rates and what specifically about this stock matches winning conditions. Be direct.",
  "key_factors": ["specific factor 1", "specific factor 2", "specific factor 3"],
  "risk_note": "one sentence on the main risk to watch for this pick"
}}"""

    result = await call_claude(prompt, model="haiku", job_name="best_bet_rationale")
    if "error" in result:
        return {
            "rationale":    f"In {regime} regime with a score of {pick.get('score')}, this pick matches conditions with a {regime_wr} historical win rate.",
            "key_factors":  [f"{regime} regime: {regime_wr} win rate", f"Score {bkt}: {score_wr}", f"10d return: {m.get('return_10d','—')}%"],
            "risk_note":    "Monitor for regime change or volume confirmation.",
        }
    return result


# ── Main orchestrator ─────────────────────────────────────────────────────────

async def get_best_bet(force_refresh: bool = False) -> dict:
    """
    Return the best-bet pick for today.
    Cached in memory per calendar day; force_refresh bypasses cache.
    """
    today = date.today().isoformat()

    if not force_refresh and _CACHE.get("date") == today:
        return _CACHE["data"]

    patterns = await compute_patterns()

    if patterns["total_evaluated"] < 3:
        return {
            "status": "insufficient_data",
            "message": "Need at least 3 evaluated picks to compute patterns. Check back in a few days.",
            "total_evaluated": patterns["total_evaluated"],
        }

    # Get today's candidates (or most recent available)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT pick_date, symbol, regime, signal_json, market_context_json
               FROM stock_picks
               ORDER BY pick_date DESC LIMIT 1"""
        ) as cur:
            row = await cur.fetchone()

    if not row:
        return {"status": "no_candidates", "message": "No SOTD pipeline run found."}

    sig         = json.loads(row["signal_json"] or "{}")
    mkt_raw     = json.loads(row["market_context_json"] or "{}")
    regime      = row["regime"] or "BULL"
    pick_date   = row["pick_date"]
    candidates  = [c for c in sig.get("all_candidates", []) if c.get("passed_filter") and c.get("score")]

    if not candidates:
        return {"status": "no_candidates", "message": "No qualifying candidates in most recent pipeline run."}

    # Score every candidate against historical patterns
    for c in candidates:
        c["match_score"] = _score_candidate(c, regime, patterns)

    ranked   = sorted(candidates, key=lambda c: (c["match_score"], c.get("score", 0)), reverse=True)
    top_pick = ranked[0]
    runners  = ranked[1:4]

    # Confidence label
    top_pick["confidence"] = _confidence_label(
        top_pick["match_score"],
        patterns["total_evaluated"],
    )

    # Haiku rationale
    mkt_ctx = {
        "vix":    mkt_raw.get("vix"),
        "spy_10d": mkt_raw.get("spy_10d"),
        "regime": regime,
    }
    ai_result = await _generate_rationale(top_pick, patterns, regime, mkt_ctx)
    top_pick["rationale"]   = ai_result.get("rationale", "")
    top_pick["key_factors"] = ai_result.get("key_factors", [])
    top_pick["risk_note"]   = ai_result.get("risk_note", "")

    # Clean up internal-only keys from patterns before returning
    clean_patterns = {k: v for k, v in patterns.items() if not k.startswith("_")}
    # Build best conditions summary string
    best_regime = max(
        [(k, v["win_rate"]) for k, v in clean_patterns["by_regime"].items()],
        key=lambda x: x[1], default=(None, 0)
    )
    best_bucket = max(
        [(k, v["win_rate"]) for k, v in clean_patterns["by_score_bucket"].items()],
        key=lambda x: x[1], default=(None, 0)
    )
    if best_regime[0] and best_bucket[0]:
        clean_patterns["best_conditions"] = (
            f"{best_regime[0]} regime + score {best_bucket[0]} "
            f"→ {round(best_regime[1]*100)}% / {round(best_bucket[1]*100)}% win rate"
        )

    # Strip large nested objects from runners-up to keep payload light
    slim_runners = []
    for r in runners:
        slim_runners.append({
            "ticker":      r.get("ticker"),
            "company":     r.get("company"),
            "sector":      r.get("sector"),
            "score":       r.get("score"),
            "match_score": r.get("match_score"),
            "confidence":  _confidence_label(r.get("match_score", 0), patterns["total_evaluated"]),
            "metrics":     r.get("metrics", {}),
            "tags":        r.get("tags", []),
        })

    # Strip heavy nested keys from top pick
    slim_pick = {k: v for k, v in top_pick.items()
                 if k not in ("score_breakdown", "fundamental")}

    result = {
        "status":         "ok",
        "computed_at":    datetime.now(UTC).isoformat(),
        "pick_date":      pick_date,
        "regime":         regime,
        "market_context": mkt_ctx,
        "pick":           slim_pick,
        "runners_up":     slim_runners,
        "patterns":       clean_patterns,
        "candidate_count": len(candidates),
    }

    _CACHE["date"] = today
    _CACHE["data"] = result
    return result
