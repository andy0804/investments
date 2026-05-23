"""
app/performance/signal_event_tracker.py

Signal lifecycle tracking for SOTD picks.

Flow:
  1. run_sotd_pipeline() → record_signal_event() on each new pick
  2. Nightly job → compute_pending_outcomes() fetches prices and stores results
  3. GET /performance/signal-outcomes → get_signal_outcome_stats()
"""

import asyncio
import logging
import warnings
from datetime import date, datetime, timedelta, UTC

import aiosqlite

from app.config import DB_PATH

warnings.filterwarnings("ignore")
logger = logging.getLogger(__name__)


# ── Write ─────────────────────────────────────────────────────────────────────

async def record_signal_event(
    pick_date: str,
    ticker: str,
    confidence_score: int,
    tier: str,
    signal_type: str,
    regime: str,
) -> int | None:
    """Insert a new signal event. Returns the new row id, or None if already exists."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """INSERT OR IGNORE INTO signal_events
                   (pick_date, ticker, confidence_score, tier, signal_type, regime, generated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (pick_date, ticker, confidence_score, tier, signal_type, regime,
                 datetime.now(UTC).isoformat()),
            )
            await db.commit()
            async with db.execute(
                "SELECT id FROM signal_events WHERE pick_date = ? AND ticker = ?",
                (pick_date, ticker),
            ) as cur:
                row = await cur.fetchone()
            return row[0] if row else None
    except Exception as e:
        logger.error("record_signal_event failed: %s", e)
        return None


# ── Outcome computation ───────────────────────────────────────────────────────

def _fetch_prices_for_outcome(ticker: str, pick_date_str: str) -> dict:
    """
    Download 50 days of OHLCV data ending today.
    Returns prices at +1, +3, +7, +14, +30 trading days from pick_date.
    Win definition: alpha_14d > +2% (outperforms SPY by more than 2 points at 14 days).
    """
    import yfinance as yf
    import pandas as pd

    def _scalar(val):
        if hasattr(val, "item"):  return val.item()
        if hasattr(val, "iloc"):
            v = val.iloc[0]
            return v.item() if hasattr(v, "item") else float(v)
        return float(val)

    raw = yf.download([ticker, "SPY"], period="50d", auto_adjust=True, progress=False)
    if raw.empty:
        return {}

    def _extract(sym):
        if isinstance(raw.columns, pd.MultiIndex):
            try:
                return raw["Close"][sym].dropna()
            except Exception:
                return pd.Series(dtype=float)
        return raw["Close"].dropna()

    t_close   = _extract(ticker)
    spy_close = _extract("SPY")

    if t_close.empty:
        return {}

    t_close.index   = [str(i.date()) for i in t_close.index]
    spy_close.index = [str(i.date()) for i in spy_close.index]

    dates = list(t_close.index)
    if pick_date_str not in dates:
        future = [d for d in dates if d >= pick_date_str]
        if not future:
            return {}
        pick_date_str = future[0]

    idx = dates.index(pick_date_str)
    entry_price = _scalar(t_close.iloc[idx])

    def _price_at(offset: int) -> float | None:
        i = idx + offset
        return _scalar(t_close.iloc[i]) if i < len(t_close) else None

    def _spy_at(offset: int) -> float | None:
        i = idx + offset
        return _scalar(spy_close.iloc[i]) if i < len(spy_close) else None

    def _pct(p_end, p_start):
        if p_end is None or p_start is None or p_start == 0:
            return None
        return round((p_end / p_start - 1) * 100, 2)

    p1,  p3,  p7  = _price_at(1),  _price_at(3),  _price_at(7)
    p14, p30      = _price_at(14), _price_at(30)
    s0,  s7       = _spy_at(0),    _spy_at(7)
    s14           = _spy_at(14)

    r1   = _pct(p1,  entry_price)
    r3   = _pct(p3,  entry_price)
    r7   = _pct(p7,  entry_price)
    r14  = _pct(p14, entry_price)
    r30  = _pct(p30, entry_price)

    spy_r7  = _pct(s7,  s0)
    spy_r14 = _pct(s14, s0)

    alpha7  = round(r7  - spy_r7,  2) if r7  is not None and spy_r7  is not None else None
    alpha14 = round(r14 - spy_r14, 2) if r14 is not None and spy_r14 is not None else None

    # Win = outperforms SPY by >2% at 14 trading days
    outcome = None
    if alpha14 is not None:
        if alpha14 > 2:
            outcome = "win"
        elif alpha14 < -2:
            outcome = "loss"
        else:
            outcome = "neutral"
    elif alpha7 is not None:
        # Fallback to 7d if 14d not yet available
        if r7 is not None and r7 > 2 and alpha7 > 0:
            outcome = "win"
        elif r7 is not None and (r7 < -2 or alpha7 < -2):
            outcome = "loss"
        elif r7 is not None:
            outcome = "neutral"

    return {
        "entry_price":    round(entry_price, 2),
        "price_1d":       round(p1,  2) if p1  is not None else None,
        "price_3d":       round(p3,  2) if p3  is not None else None,
        "price_7d":       round(p7,  2) if p7  is not None else None,
        "price_14d":      round(p14, 2) if p14 is not None else None,
        "price_30d":      round(p30, 2) if p30 is not None else None,
        "return_1d":      r1,
        "return_3d":      r3,
        "return_7d":      r7,
        "return_14d":     r14,
        "return_30d":     r30,
        "spy_return_7d":  spy_r7,
        "spy_return_14d": spy_r14,
        "alpha_7d":       alpha7,
        "alpha_14d":      alpha14,
        "outcome":        outcome,
    }


async def compute_pending_outcomes() -> int:
    """
    For every signal_event that has no outcome yet and is at least 1 trading day old,
    fetch prices and store results. Returns count of outcomes computed.
    """
    today = date.today().isoformat()
    computed = 0

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        # Events with no outcome row, OR outcome row exists but outcome field is still NULL
        async with db.execute(
            """SELECT se.id, se.pick_date, se.ticker
               FROM signal_events se
               LEFT JOIN signal_outcomes so ON so.signal_event_id = se.id
               WHERE se.pick_date < ?
                 AND (so.id IS NULL OR so.outcome IS NULL)
               ORDER BY se.pick_date""",
            (today,),
        ) as cur:
            pending = [dict(r) for r in await cur.fetchall()]

    if not pending:
        logger.info("compute_pending_outcomes: nothing to evaluate")
        return 0

    for evt in pending:
        event_id  = evt["id"]
        ticker    = evt["ticker"]
        pick_date = evt["pick_date"]

        try:
            prices = await asyncio.to_thread(_fetch_prices_for_outcome, ticker, pick_date)
        except Exception as e:
            logger.warning("outcome fetch failed for %s on %s: %s", ticker, pick_date, e)
            continue

        if not prices or prices.get("return_1d") is None:
            continue  # not enough data yet

        try:
            async with aiosqlite.connect(DB_PATH) as db:
                await db.execute(
                    """INSERT OR REPLACE INTO signal_outcomes
                       (signal_event_id, ticker, pick_date,
                        entry_price, price_1d, price_3d, price_7d, price_14d, price_30d,
                        return_1d, return_3d, return_7d, return_14d, return_30d,
                        spy_return_7d, spy_return_14d, alpha_7d, alpha_14d,
                        outcome, evaluated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        event_id, ticker, pick_date,
                        prices.get("entry_price"),
                        prices.get("price_1d"),   prices.get("price_3d"),
                        prices.get("price_7d"),   prices.get("price_14d"),
                        prices.get("price_30d"),
                        prices.get("return_1d"),  prices.get("return_3d"),
                        prices.get("return_7d"),  prices.get("return_14d"),
                        prices.get("return_30d"),
                        prices.get("spy_return_7d"), prices.get("spy_return_14d"),
                        prices.get("alpha_7d"),   prices.get("alpha_14d"),
                        prices.get("outcome"),
                        datetime.now(UTC).isoformat(),
                    ),
                )
                await db.commit()
            computed += 1
            logger.info("outcome computed: %s %s r7=%s outcome=%s",
                        ticker, pick_date, prices.get("return_7d"), prices.get("outcome"))
        except Exception as e:
            logger.error("outcome insert failed for %s: %s", ticker, e)

    return computed


# ── Read / Stats ──────────────────────────────────────────────────────────────

async def get_signal_outcome_stats() -> dict:
    """Return full outcome history + summary statistics."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Join events + outcomes for full history
        async with db.execute(
            """SELECT
                 se.pick_date, se.ticker, se.confidence_score, se.tier,
                 se.signal_type, se.regime,
                 so.entry_price, so.price_1d, so.price_3d, so.price_7d,
                 so.price_14d, so.price_30d,
                 so.return_1d, so.return_3d, so.return_7d,
                 so.return_14d, so.return_30d,
                 so.spy_return_7d, so.spy_return_14d,
                 so.alpha_7d, so.alpha_14d, so.outcome, so.evaluated_at
               FROM signal_events se
               LEFT JOIN signal_outcomes so ON so.signal_event_id = se.id
               ORDER BY se.pick_date DESC""",
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]

        async with db.execute("SELECT COUNT(*) FROM signal_events") as cur:
            total_picks = (await cur.fetchone())[0]

    evaluated = [r for r in rows if r.get("outcome") is not None]
    pending   = [r for r in rows if r.get("outcome") is None]

    def _avg(vals):
        vals = [v for v in vals if v is not None]
        return round(sum(vals) / len(vals), 2) if vals else None

    wins     = [r for r in evaluated if r["outcome"] == "win"]
    win_rate = round(len(wins) / len(evaluated), 3) if evaluated else None

    # Breakdown by regime
    by_regime: dict[str, dict] = {}
    for regime in ("BULL", "BEAR", "CHOP"):
        subset = [r for r in evaluated if r["regime"] == regime]
        if subset:
            w = [r for r in subset if r["outcome"] == "win"]
            by_regime[regime] = {
                "count":    len(subset),
                "win_rate": round(len(w) / len(subset), 3),
                "avg_alpha_7d": _avg([r["alpha_7d"] for r in subset]),
                "avg_return_7d": _avg([r["return_7d"] for r in subset]),
            }

    # Breakdown by tier
    by_tier: dict[str, dict] = {}
    for tier in ("Stock of the Day", "Best Watchlist Candidate"):
        subset = [r for r in evaluated if r["tier"] == tier]
        if subset:
            w = [r for r in subset if r["outcome"] == "win"]
            by_tier[tier] = {
                "count":    len(subset),
                "win_rate": round(len(w) / len(subset), 3),
                "avg_alpha_7d": _avg([r["alpha_7d"] for r in subset]),
            }

    return {
        "outcomes": rows,
        "stats": {
            "total_picks":     total_picks,
            "evaluated":       len(evaluated),
            "pending":         len(pending),
            "win_rate":        win_rate,
            "avg_return_7d":   _avg([r["return_7d"]  for r in evaluated]),
            "avg_return_14d":  _avg([r["return_14d"] for r in evaluated]),
            "avg_alpha_7d":    _avg([r["alpha_7d"]   for r in evaluated]),
            "avg_alpha_14d":   _avg([r["alpha_14d"]  for r in evaluated]),
            "by_regime":       by_regime,
            "by_tier":         by_tier,
        },
    }


# ── Universe Cooldown ─────────────────────────────────────────────────────────

async def update_universe_cooldown() -> list[str]:
    """
    After outcomes settle, auto-block stocks that consistently underperform.
    Rules:
      - alpha_14d < -15% on any single pick → immediate 30-day block
      - 2+ losses in last 4 evaluated picks for same ticker → 30-day block
    Returns list of newly blocked tickers.
    """
    newly_blocked = []
    today_str = date.today().isoformat()
    unblock_date = (date.today() + timedelta(days=30)).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Rule 1: severe alpha_14d underperformance
        async with db.execute(
            """SELECT se.ticker, so.alpha_14d
               FROM signal_events se
               JOIN signal_outcomes so ON so.signal_event_id = se.id
               WHERE so.alpha_14d IS NOT NULL AND so.alpha_14d < -15
               ORDER BY se.pick_date DESC"""
        ) as cur:
            severe = [dict(r) for r in await cur.fetchall()]

        for row in severe:
            ticker = row["ticker"]
            alpha  = row["alpha_14d"]
            await db.execute(
                """INSERT INTO universe_cooldown (ticker, reason, alpha_14d, times_blocked, blocked_at, unblock_after)
                   VALUES (?, ?, ?, 1, ?, ?)
                   ON CONFLICT(ticker) DO UPDATE SET
                     reason       = excluded.reason,
                     alpha_14d    = excluded.alpha_14d,
                     times_blocked = times_blocked + 1,
                     blocked_at   = excluded.blocked_at,
                     unblock_after = excluded.unblock_after""",
                (ticker, f"Severe underperformance: alpha_14d={alpha:.1f}%", alpha, today_str, unblock_date),
            )
            newly_blocked.append(ticker)

        # Rule 2: 2+ losses in last 4 picks per ticker
        async with db.execute(
            """SELECT se.ticker, so.outcome, se.pick_date
               FROM signal_events se
               JOIN signal_outcomes so ON so.signal_event_id = se.id
               WHERE so.outcome IS NOT NULL
               ORDER BY se.ticker, se.pick_date DESC"""
        ) as cur:
            all_rows = [dict(r) for r in await cur.fetchall()]

        from collections import defaultdict
        by_ticker: dict[str, list] = defaultdict(list)
        for r in all_rows:
            by_ticker[r["ticker"]].append(r["outcome"])

        for ticker, outcomes in by_ticker.items():
            last4 = outcomes[:4]
            if len(last4) >= 4 and last4.count("loss") >= 2:
                reason = f"Repeated losses: {last4.count('loss')}/{len(last4)} recent picks"
                await db.execute(
                    """INSERT INTO universe_cooldown (ticker, reason, alpha_14d, times_blocked, blocked_at, unblock_after)
                       VALUES (?, ?, NULL, 1, ?, ?)
                       ON CONFLICT(ticker) DO UPDATE SET
                         reason        = excluded.reason,
                         times_blocked = times_blocked + 1,
                         blocked_at    = excluded.blocked_at,
                         unblock_after = excluded.unblock_after""",
                    (ticker, reason, today_str, unblock_date),
                )
                if ticker not in newly_blocked:
                    newly_blocked.append(ticker)

        await db.commit()

    if newly_blocked:
        logger.info("universe_cooldown: blocked %s", newly_blocked)
    return newly_blocked


async def get_cooldown_list() -> list[dict]:
    """Return all stocks currently on the cooldown list."""
    today_str = date.today().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM universe_cooldown WHERE unblock_after > ? ORDER BY blocked_at DESC",
            (today_str,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def remove_from_cooldown(ticker: str) -> bool:
    """Manually remove a stock from the cooldown list."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM universe_cooldown WHERE ticker = ?", (ticker,))
        await db.commit()
    logger.info("universe_cooldown: manually removed %s", ticker)
    return True
