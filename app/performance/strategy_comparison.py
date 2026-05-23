"""
app/performance/strategy_comparison.py

Five parallel strategies each pick a stock from the same daily candidate pool.
Outcomes settle at 14 trading days (alpha vs SPY). The UI shows which strategy
is winning in real time.

Strategies:
  1. SOTD Default    — highest composite score (mirrors the live system)
  2. High Conviction — score ≥ 75 only
  3. Momentum        — highest vol_ratio (≥1.3 required)
  4. Recovery        — RSI 35-55 bounce, top scorer among those
  5. Composite       — best average percentile rank of score + vol_ratio + return_10d
"""

import asyncio
import json
import logging
from datetime import date, datetime, UTC

import aiosqlite

from app.config import DB_PATH

logger = logging.getLogger(__name__)

# ── Strategy definitions ──────────────────────────────────────────────────────

STRATEGIES: dict[str, dict] = {
    "SOTD Default": {
        "description": "Highest composite score from filtered universe — mirrors the live system",
        "color": "#2563eb",
        "short": "Default",
    },
    "High Conviction": {
        "description": "Score ≥ 75 only — waits for the strongest setups, skips on weak days",
        "color": "#16a34a",
        "short": "Hi-Conv",
    },
    "Momentum": {
        "description": "Highest volume surge (vol ratio ≥ 1.3) — follows institutional accumulation",
        "color": "#d97706",
        "short": "Momentum",
    },
    "Recovery": {
        "description": "RSI 35–55 bounce — early-stage recovery from oversold conditions",
        "color": "#7c3aed",
        "short": "Recovery",
    },
    "Composite": {
        "description": "Best average percentile rank across score, volume surge, and 10d return",
        "color": "#db2777",
        "short": "Composite",
    },
}

STRATEGY_NAMES = list(STRATEGIES.keys())


# ── Candidate selection per strategy ─────────────────────────────────────────

def _percentile_rank(values: list[float], val: float) -> float:
    if not values or len(values) == 1:
        return 1.0
    below = sum(1 for v in values if v < val)
    return below / (len(values) - 1)


def _select(candidates: list[dict], strategy: str) -> tuple[dict | None, str | None]:
    """
    Return (best_candidate, no_pick_reason).
    no_pick_reason is set when the strategy has no qualifying candidates today.
    """
    if not candidates:
        return None, "No candidates in pool"

    if strategy == "SOTD Default":
        ranked = sorted(candidates, key=lambda c: c.get("score", 0), reverse=True)
        return ranked[0], None

    elif strategy == "High Conviction":
        pool = [c for c in candidates if (c.get("score") or 0) >= 75]
        if not pool:
            # Fallback: best available scorer below threshold
            best = max(candidates, key=lambda c: c.get("score", 0))
            score = best.get("score", 0)
            return best, f"Fallback: no candidate scored ≥75; best available is {score}"
        return max(pool, key=lambda c: c.get("score", 0)), None

    elif strategy == "Momentum":
        m_cands = [c for c in candidates
                   if c.get("metrics", {}).get("vol_ratio") is not None
                   and c["metrics"]["vol_ratio"] >= 1.3]
        if not m_cands:
            # Fallback: highest vol_ratio regardless of threshold
            pool = [c for c in candidates if c.get("metrics", {}).get("vol_ratio") is not None]
            if not pool:
                return None, "No volume data available"
            best = max(pool, key=lambda c: c["metrics"]["vol_ratio"])
            return best, "Fallback: no candidate had vol_ratio ≥1.3; used highest available"
        return max(m_cands, key=lambda c: c["metrics"]["vol_ratio"]), None

    elif strategy == "Recovery":
        pool = [c for c in candidates
                if c.get("metrics", {}).get("rsi") is not None
                and 35 <= c["metrics"]["rsi"] <= 55]
        if not pool:
            return None, "No candidates with RSI 35–55 today"
        return max(pool, key=lambda c: c.get("score", 0)), None

    elif strategy == "Composite":
        pool = [c for c in candidates
                if c.get("score") and c.get("metrics", {}).get("vol_ratio") is not None]
        if not pool:
            pool = candidates  # fallback to all

        scores    = [c.get("score", 0) for c in pool]
        vol_ratios = [c.get("metrics", {}).get("vol_ratio", 0) for c in pool]
        returns   = [c.get("metrics", {}).get("return_10d", 0) or 0 for c in pool]

        for c in pool:
            sp = _percentile_rank(scores,    c.get("score", 0))
            vp = _percentile_rank(vol_ratios, c.get("metrics", {}).get("vol_ratio", 0))
            rp = _percentile_rank(returns,    c.get("metrics", {}).get("return_10d", 0) or 0)
            c["_composite"] = round((sp + vp + rp) / 3, 3)

        return max(pool, key=lambda c: c.get("_composite", 0)), None

    return None, f"Unknown strategy: {strategy}"


# ── Write picks ───────────────────────────────────────────────────────────────

async def run_strategy_forward_picks(
    pick_date: str | None = None,
    backfill: bool = False,
) -> dict[str, str | None]:
    """
    Record strategy picks for a given date (defaults to today).
    If backfill=True, process all available stock_picks dates.
    Returns {strategy_name: ticker_picked_or_None}.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """CREATE TABLE IF NOT EXISTS strategy_forward_picks (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               strategy_name TEXT NOT NULL, pick_date TEXT NOT NULL,
               ticker TEXT, company TEXT, sector TEXT,
               score INTEGER, regime TEXT, metrics_json TEXT,
               entry_price REAL, price_14d REAL, return_14d REAL,
               spy_return_14d REAL, alpha_14d REAL, outcome TEXT,
               evaluated_at TEXT, no_pick INTEGER DEFAULT 0, no_pick_reason TEXT,
               UNIQUE(strategy_name, pick_date))"""
        )
        await db.commit()

    if backfill:
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT pick_date FROM stock_picks WHERE signal_json IS NOT NULL ORDER BY pick_date ASC"
            ) as cur:
                dates = [r["pick_date"] for r in await cur.fetchall()]
        results = {}
        for d in dates:
            r = await _run_for_date(d)
            results.update(r)
        return results

    target = pick_date or date.today().isoformat()
    return await _run_for_date(target)


async def _run_for_date(pick_date: str) -> dict[str, str | None]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT symbol, regime, signal_json FROM stock_picks WHERE date(pick_date) = ?",
            (pick_date,),
        ) as cur:
            row = await cur.fetchone()

    if not row:
        logger.info("strategy_comparison: no stock_picks for %s", pick_date)
        return {}

    sig       = json.loads(row["signal_json"] or "{}")
    regime    = row["regime"] or "UNKNOWN"
    candidates = [c for c in sig.get("all_candidates", []) if c.get("passed_filter") and c.get("metrics")]

    results: dict[str, str | None] = {}

    async with aiosqlite.connect(DB_PATH) as db:
        for strategy in STRATEGY_NAMES:
            pick, no_pick_reason = _select(candidates, strategy)

            if pick:
                await db.execute(
                    """INSERT OR REPLACE INTO strategy_forward_picks
                       (strategy_name, pick_date, ticker, company, sector,
                        score, regime, metrics_json, no_pick, no_pick_reason)
                       VALUES (?,?,?,?,?,?,?,?,0,?)""",
                    (
                        strategy, pick_date,
                        pick.get("ticker"), pick.get("company"), pick.get("sector"),
                        pick.get("score"), regime,
                        json.dumps(pick.get("metrics", {})),
                        no_pick_reason,
                    ),
                )
                results[strategy] = pick.get("ticker")
            else:
                await db.execute(
                    """INSERT OR REPLACE INTO strategy_forward_picks
                       (strategy_name, pick_date, no_pick, no_pick_reason, regime)
                       VALUES (?,?,1,?,?)""",
                    (strategy, pick_date, no_pick_reason, regime),
                )
                results[strategy] = None

        await db.commit()

    logger.info("strategy_comparison: recorded picks for %s → %s", pick_date, results)
    return results


# ── Outcome computation ───────────────────────────────────────────────────────

async def compute_strategy_outcomes() -> int:
    """Fetch 14d prices for all pending strategy picks. Returns count updated."""
    from app.performance.signal_event_tracker import _fetch_prices_for_outcome

    today = date.today().isoformat()
    computed = 0

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT id, strategy_name, pick_date, ticker
               FROM strategy_forward_picks
               WHERE no_pick = 0 AND ticker IS NOT NULL
                 AND outcome IS NULL
                 AND pick_date < ?
               ORDER BY pick_date ASC""",
            (today,),
        ) as cur:
            pending = [dict(r) for r in await cur.fetchall()]

    for row in pending:
        try:
            prices = await asyncio.to_thread(
                _fetch_prices_for_outcome, row["ticker"], row["pick_date"]
            )
        except Exception as e:
            logger.warning("strategy outcomes: fetch failed %s %s: %s", row["ticker"], row["pick_date"], e)
            continue

        if not prices or prices.get("return_1d") is None:
            continue

        try:
            async with aiosqlite.connect(DB_PATH) as db:
                await db.execute(
                    """UPDATE strategy_forward_picks SET
                       entry_price=?, price_14d=?, return_14d=?,
                       spy_return_14d=?, alpha_14d=?, outcome=?, evaluated_at=?
                       WHERE id=?""",
                    (
                        prices.get("entry_price"),
                        prices.get("price_14d"),
                        prices.get("return_14d"),
                        prices.get("spy_return_14d"),
                        prices.get("alpha_14d"),
                        prices.get("outcome"),
                        datetime.now(UTC).isoformat(),
                        row["id"],
                    ),
                )
                await db.commit()
            computed += 1
        except Exception as e:
            logger.error("strategy outcomes: insert failed %s: %s", row["id"], e)

    return computed


# ── Read / stats ──────────────────────────────────────────────────────────────

async def get_strategy_comparison() -> dict:
    """Return full per-strategy pick history + stats for the dashboard."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        async with db.execute(
            """SELECT * FROM strategy_forward_picks ORDER BY pick_date DESC"""
        ) as cur:
            all_picks = [dict(r) for r in await cur.fetchall()]

    def _avg(vals):
        vals = [v for v in vals if v is not None]
        return round(sum(vals) / len(vals), 2) if vals else None

    today = date.today().isoformat()
    by_strategy: dict[str, dict] = {}

    for name, cfg in STRATEGIES.items():
        picks = [p for p in all_picks if p["strategy_name"] == name]
        real_picks  = [p for p in picks if not p.get("no_pick")]
        evaluated   = [p for p in real_picks if p.get("outcome") is not None]
        pending     = [p for p in real_picks if p.get("outcome") is None]
        wins        = [p for p in evaluated if p["outcome"] == "win"]
        no_fire_days = [p for p in picks if p.get("no_pick")]

        win_rate = round(len(wins) / len(evaluated), 3) if evaluated else None
        today_pick = next(
            (p for p in real_picks if p.get("pick_date", "").startswith(today[:10])),
            None,
        )

        # Parse metrics_json for display
        for p in picks:
            if p.get("metrics_json"):
                try:
                    p["metrics"] = json.loads(p["metrics_json"])
                except Exception:
                    p["metrics"] = {}

        by_strategy[name] = {
            "color":       cfg["color"],
            "description": cfg["description"],
            "short":       cfg["short"],
            "today_pick":  today_pick,
            "picks":       real_picks,
            "stats": {
                "total_picks":    len(real_picks),
                "evaluated":      len(evaluated),
                "wins":           len(wins),
                "losses":         len([p for p in evaluated if p["outcome"] == "loss"]),
                "pending":        len(pending),
                "no_fire_days":   len(no_fire_days),
                "win_rate":       win_rate,
                "avg_alpha_14d":  _avg([p["alpha_14d"] for p in evaluated]),
                "avg_return_14d": _avg([p["return_14d"] for p in evaluated]),
            },
        }

    # Leaderboard: sort by weighted win rate (penalise tiny samples)
    def _weighted_wr(s):
        if not s.get("evaluated"):
            return -1.0
        wr  = s.get("win_rate") or 0
        n   = s["evaluated"]
        # Wilson score lower bound approximation — discounts small samples
        z = 1.645  # 90% confidence
        phat = wr
        denom = 1 + z**2 / n
        centre = phat + z**2 / (2 * n)
        spread = z * ((phat * (1 - phat) / n + z**2 / (4 * n**2)) ** 0.5)
        return (centre - spread) / denom

    leaderboard = sorted(
        [{"name": k, **v["stats"], "color": v["color"]} for k, v in by_strategy.items()],
        key=_weighted_wr,
        reverse=True,
    )

    # Mark the leader
    for i, row in enumerate(leaderboard):
        row["rank"] = i + 1
        row["is_leader"] = i == 0 and row["evaluated"] >= 3

    # Consensus: strategies agreeing on same ticker today
    today_tickers = [
        v["today_pick"]["ticker"]
        for v in by_strategy.values()
        if v.get("today_pick") and v["today_pick"].get("ticker")
    ]
    from collections import Counter
    ticker_counts = Counter(today_tickers)
    consensus_ticker, consensus_count = ticker_counts.most_common(1)[0] if ticker_counts else (None, 0)
    consensus = {
        "ticker": consensus_ticker,
        "agreement": consensus_count,
        "total": len(STRATEGY_NAMES),
        "is_strong": consensus_count >= 3,
    } if consensus_ticker else None

    # Unified pick history timeline (all strategies, sorted by date desc)
    timeline = sorted(
        [p for p in all_picks if not p.get("no_pick") and p.get("ticker")],
        key=lambda p: p.get("pick_date", ""),
        reverse=True,
    )

    return {
        "strategies":     by_strategy,
        "leaderboard":    leaderboard,
        "consensus":      consensus,
        "timeline":       timeline[:120],   # last ~24 picks × 5 strategies
        "target_picks":   30,
        "strategy_names": STRATEGY_NAMES,
    }
