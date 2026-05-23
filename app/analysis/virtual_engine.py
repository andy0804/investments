"""
app/analysis/virtual_engine.py

Virtual Trading Engine — entry, exit, daily evaluation, backfill.
Uses the same deterministic scoring math as the SOTD pipeline.
LLM (Haiku) is used ONLY to generate structured explanations — never to make decisions.
"""
import json
import logging
import asyncio
from datetime import date, datetime, timedelta, UTC
from typing import Optional

import aiosqlite
import yfinance as yf
import pandas as pd
from ta.momentum import RSIIndicator
from ta.trend import SMAIndicator, ADXIndicator
from ta.volatility import BollingerBands

from app.config import DB_PATH
from app.analysis.claude_engine import call_claude

logger = logging.getLogger(__name__)

ACCOUNT_ID  = 1
CONFIG_ID   = 1


# ── Scoring helpers (identical math to sotd_engine._score_v2) ─────────────────

def _scalar(v):
    try:
        return float(v)
    except Exception:
        return 0.0


def _classify_regime(spy_df: pd.DataFrame, vix: float) -> str:
    close  = spy_df["Close"]
    sma50  = _scalar(SMAIndicator(close, window=min(50, len(close))).sma_indicator().iloc[-1])
    spy10d = (_scalar(close.iloc[-1]) / _scalar(close.iloc[-11]) - 1) * 100 if len(close) >= 11 else 0
    above50 = _scalar(close.iloc[-1]) > sma50
    if vix < 20 and above50 and spy10d > 0:
        return "BULL"
    if vix > 25 or (not above50 and spy10d < -2):
        return "BEAR"
    return "CHOP"


def _sector_multiplier(sector_10d: float, spy_10d: float) -> float:
    rel = sector_10d - spy_10d
    if rel > 5:         return 1.25
    if rel > 2:         return 1.10
    if rel > -2:        return 1.00
    if sector_10d < 0:  return 0.75
    return 0.90


def _score_v2(ind: dict, spy_10d: float, sector_10d: float,
              regime: str, is_momentum: bool) -> dict:
    r10 = ind["return_10d"]
    raw_mom = 25 if r10 >= 8 else 20 if r10 >= 5 else 15 if r10 >= 3 else 8 if r10 >= 1 else 3
    rmult = 1.0 if regime == "BULL" else 0.85 if regime == "CHOP" else 0.65
    if regime == "BEAR" and is_momentum and not ind["rsi_recovering"]:
        rmult = 0.50
    momentum = int(raw_mom * rmult)

    vr = ind["vol_ratio"]
    volume = 20 if vr >= 2.0 else 15 if vr >= 1.5 else 8 if vr >= 1.2 else 0

    if ind["bb_squeeze"] and ind["above_upper_bb"]:
        raw_setup = 19
    elif ind["rsi_recovering"] and ind["above_sma20"]:
        raw_setup = 16
    elif ind["above_sma20"] and 50 <= ind["rsi"] <= 65:
        raw_setup = 12
    elif ind["above_sma20"]:
        raw_setup = 7
    else:
        raw_setup = 2
    setup = int(raw_setup * _sector_multiplier(sector_10d, spy_10d))

    rel = ind["return_10d"] - spy_10d
    market = 15 if rel >= 5 else 11 if rel >= 2 else 7 if rel >= 0 else 3 if rel >= -3 else 0

    conviction = 10 if ind["adx"] >= 30 else 7 if ind["adx"] >= 20 else 3

    penalty = 0
    if ind["adx"] < 20:                                  penalty -= 3
    if ind["return_3d"] > 10:                            penalty -= 4
    if ind["vol_ratio"] < 1.5 and ind["above_upper_bb"]: penalty -= 3
    if regime == "BEAR" and is_momentum and not ind["rsi_recovering"]: penalty -= 5

    total = max(0, min(100, momentum + volume + setup + market + conviction + penalty))
    return {
        "total": total,
        "momentum": momentum, "volume": volume,
        "setup": setup, "market": market,
        "conviction": conviction, "penalty": penalty,
    }


def _compute_indicators(df: pd.DataFrame) -> dict:
    close, volume = df["Close"], df["Volume"]
    rsi   = _scalar(RSIIndicator(close, window=14).rsi().iloc[-1])
    sma20 = SMAIndicator(close, window=20).sma_indicator()
    bb    = BollingerBands(close, window=20, window_dev=2)
    adx   = _scalar(ADXIndicator(df["High"], df["Low"], close, window=14).adx().iloc[-1])

    p_now = _scalar(close.iloc[-1])
    p_3d  = _scalar(close.iloc[-4])  if len(df) >= 4  else p_now
    p_5d  = _scalar(close.iloc[-6])  if len(df) >= 6  else p_now
    p_10d = _scalar(close.iloc[-11]) if len(df) >= 11 else p_now

    vol_avg   = _scalar(volume.iloc[-21:-1].mean()) if len(volume) >= 21 else _scalar(volume.mean())
    vol_today = _scalar(volume.iloc[-1])
    vol_ratio = vol_today / vol_avg if vol_avg > 0 else 0

    bb_h = _scalar(bb.bollinger_hband().iloc[-1])
    bb_l = _scalar(bb.bollinger_lband().iloc[-1])
    bb_h5 = _scalar(bb.bollinger_hband().iloc[-6]) if len(df) >= 6 else bb_h
    bb_l5 = _scalar(bb.bollinger_lband().iloc[-6]) if len(df) >= 6 else bb_l
    bb_w  = (bb_h - bb_l) / p_now if p_now > 0 else 0
    bb_w5 = (bb_h5 - bb_l5) / p_5d if p_5d > 0 else bb_w

    rsi_series  = RSIIndicator(close, window=14).rsi()
    rsi_5d_ago  = _scalar(rsi_series.iloc[-6]) if len(df) >= 20 else rsi
    rsi_recovering = (rsi_5d_ago < 40) and (rsi > 48)

    return {
        "price":          round(p_now, 2),
        "rsi":            round(rsi, 1),
        "adx":            round(adx, 1),
        "vol_ratio":      round(vol_ratio, 2),
        "return_3d":      round((p_now / p_3d - 1) * 100, 2),
        "return_5d":      round((p_now / p_5d - 1) * 100, 2),
        "return_10d":     round((p_now / p_10d - 1) * 100, 2),
        "above_sma20":    bool(p_now > _scalar(sma20.iloc[-1])),
        "bb_squeeze":     bool(bb_w < bb_w5 * 0.85),
        "above_upper_bb": bool(p_now > bb_h),
        "rsi_recovering": bool(rsi_recovering),
    }


def _lightweight_rescore(ticker: str, spy_df: pd.DataFrame, vix: float) -> Optional[dict]:
    """Fetch 60d data for ticker, compute indicators, score. Returns None on failure."""
    try:
        raw = yf.download([ticker, "SPY"], period="60d", auto_adjust=True, progress=False)
        if isinstance(raw.columns, pd.MultiIndex):
            df = pd.DataFrame({
                "Open": raw["Open"][ticker], "High": raw["High"][ticker],
                "Low": raw["Low"][ticker], "Close": raw["Close"][ticker],
                "Volume": raw["Volume"][ticker],
            }).dropna()
        else:
            df = raw.copy()

        if len(df) < 20:
            return None

        ind = _compute_indicators(df)
        spy_close  = spy_df["Close"]
        spy_10d    = (_scalar(spy_close.iloc[-1]) / _scalar(spy_close.iloc[-11]) - 1) * 100 if len(spy_close) >= 11 else 0
        regime     = _classify_regime(spy_df, vix)
        is_momentum = not ind["rsi_recovering"]
        bd = _score_v2(ind, spy_10d, 0.0, regime, is_momentum)  # sector_10d=0 for re-score
        return {"score": bd["total"], "breakdown": bd, "indicators": ind,
                "regime": regime, "spy_10d": spy_10d}
    except Exception as e:
        logger.error("_lightweight_rescore failed for %s: %s", ticker, e)
        return None


async def _get_spy_vix() -> tuple[pd.DataFrame, float]:
    """Download SPY + VIX for regime classification."""
    def _fetch():
        raw = yf.download(["SPY", "^VIX"], period="60d", auto_adjust=True, progress=False)
        spy_df = pd.DataFrame({
            "Close": raw["Close"]["SPY"],
            "High":  raw["High"]["SPY"],
            "Low":   raw["Low"]["SPY"],
        }).dropna()
        vix_series = raw["Close"]["^VIX"].dropna()
        vix = _scalar(vix_series.iloc[-1]) if len(vix_series) else 20.0
        return spy_df, vix
    return await asyncio.get_event_loop().run_in_executor(None, _fetch)


# ── LLM explanation (Haiku, structured JSON only) ─────────────────────────────

async def _explain_decision(action: str, ticker: str, ind: dict, bd: dict,
                             entry_score: int, current_score: int,
                             regime_entry: str, regime_current: str,
                             return_pct: float, days_held: int,
                             cfg: dict, alternatives: list[str]) -> dict:
    prompt = f"""You are a quantitative trading system auditor. Generate a structured decision explanation.

ACTION: {action}
TICKER: {ticker}
SCORE: entry={entry_score} → current={current_score} (delta={current_score - entry_score:+d})
REGIME: entry={regime_entry} → current={regime_current}
RETURN: {return_pct:+.2f}%
DAYS HELD: {days_held}
INDICATORS: RSI={ind.get('rsi')}, ADX={ind.get('adx')}, vol_ratio={ind.get('vol_ratio')}, return_10d={ind.get('return_10d')}%, above_sma20={ind.get('above_sma20')}
SCORE BREAKDOWN: momentum={bd.get('momentum')}, volume={bd.get('volume')}, setup={bd.get('setup')}, market={bd.get('market')}, conviction={bd.get('conviction')}, penalty={bd.get('penalty')}
CONFIG THRESHOLDS: score_exit={cfg['score_exit_threshold']}, stop_loss={cfg['stop_loss_pct']}%, profit_target={cfg['profit_target_pct']}%, min_hold={cfg['min_hold_days']}d, max_hold={cfg['max_hold_days']}d
ALTERNATIVES CONSIDERED: {', '.join(alternatives) if alternatives else 'none'}

Respond ONLY with valid JSON in this exact structure — no prose, no markdown:
{{
  "rationale": "<one sentence, factual, uses numbers>",
  "why_selected": ["<bullet 1 with numbers>", "<bullet 2>", "<bullet 3>"],
  "why_rejected": ["<what threshold was NOT met or what signal WEAKENED — with specific numbers>"],
  "what_changed": ["<delta since last eval — e.g. RSI 68→52, score 82→64>"],
  "risk_signals": ["<active risk flags — or empty list if none>"],
  "confidence": "High|Medium|Low"
}}"""

    result = await call_claude(prompt, model="haiku", job_name=f"virtual_explain_{ticker}")
    if isinstance(result, dict) and "rationale" in result:
        return result
    return {
        "rationale": f"{action} — score {entry_score}→{current_score}, return {return_pct:+.2f}%",
        "why_selected": [], "why_rejected": [], "what_changed": [],
        "risk_signals": [], "confidence": "Medium",
    }


# ── Account helpers ───────────────────────────────────────────────────────────

async def get_account() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT va.*, sc.* FROM virtual_account va JOIN strategy_configs sc ON va.config_id = sc.id WHERE va.id = ?",
            (ACCOUNT_ID,)
        ) as cur:
            row = await cur.fetchone()
    return dict(row) if row else {}


async def get_open_positions() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM virtual_positions WHERE account_id = ? AND status = 'OPEN' ORDER BY entry_date",
            (ACCOUNT_ID,)
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def _open_position_count() -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT COUNT(*) FROM virtual_positions WHERE account_id = ? AND status = 'OPEN'",
            (ACCOUNT_ID,)
        ) as cur:
            row = await cur.fetchone()
    return row[0] if row else 0


async def _snapshot_portfolio(account_id: int, cash: float, invested_value: float,
                               open_count: int, initial_capital: float):
    today = date.today().isoformat()
    total = cash + invested_value

    async with aiosqlite.connect(DB_PATH) as db:
        # Previous total for daily return
        async with db.execute(
            "SELECT total_value FROM portfolio_daily WHERE account_id = ? ORDER BY date DESC LIMIT 1",
            (account_id,)
        ) as cur:
            prev = await cur.fetchone()
        prev_total = prev[0] if prev else total
        daily_ret  = round((total / prev_total - 1) * 100, 4) if prev_total > 0 else 0
        cum_ret    = round((total / initial_capital - 1) * 100, 4)

        await db.execute(
            """INSERT OR REPLACE INTO portfolio_daily
               (account_id, date, total_value, cash, invested_value, daily_return_pct, cumulative_return_pct, open_positions)
               VALUES (?,?,?,?,?,?,?,?)""",
            (account_id, today, total, cash, invested_value, daily_ret, cum_ret, open_count)
        )
        await db.commit()


async def _snapshot_benchmark():
    today = date.today().isoformat()
    try:
        def _fetch():
            t = yf.Ticker("SPY")
            info = t.fast_info
            return float(info.last_price), float(info.previous_close)
        price, prev = await asyncio.get_event_loop().run_in_executor(None, _fetch)
        day_ret = round((price / prev - 1) * 100, 4) if prev else 0

        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT spy_price FROM benchmark_daily ORDER BY date DESC LIMIT 1"
            ) as cur:
                first = await cur.fetchone()

            # Use first recorded price as baseline for cumulative
            baseline = first[0] if first else price
            cum = round((price / baseline - 1) * 100, 4)

            await db.execute(
                """INSERT OR REPLACE INTO benchmark_daily (date, spy_price, spy_return_pct, spy_cumulative_pct)
                   VALUES (?,?,?,?)""",
                (today, round(price, 2), day_ret, cum)
            )
            await db.commit()
    except Exception as e:
        logger.warning("_snapshot_benchmark failed: %s", e)


# ── Entry engine ──────────────────────────────────────────────────────────────

async def try_entry(sotd_ticker: str, sotd_score: int, sotd_regime: str,
                    sotd_price: float) -> Optional[dict]:
    """
    Called at 10:00 AM after SOTD fires. Buys if:
    - score >= buy_threshold
    - confirmation: price hasn't gapped > 2% above prev close
    - cash available for full allocation
    - max_positions not exceeded
    - account not suspended
    """
    acct = await get_account()
    if not acct:
        return None
    if acct["is_suspended"]:
        logger.info("virtual_engine: account suspended — skipping entry")
        return None
    if sotd_score < acct["buy_threshold"]:
        logger.info("virtual_engine: score %d < threshold %d — skip", sotd_score, acct["buy_threshold"])
        return None

    open_count = await _open_position_count()
    if open_count >= acct["max_positions"]:
        logger.info("virtual_engine: max positions %d reached — skip", acct["max_positions"])
        return None

    allocation = acct["cash"] * (acct["allocation_pct"] / 100)
    if acct["cash"] < allocation:
        logger.info("virtual_engine: insufficient cash %.2f < %.2f — skip", acct["cash"], allocation)
        return None

    # Confirmation window: fetch current price, ensure not gapped > 2%
    try:
        def _live():
            t = yf.Ticker(sotd_ticker)
            fi = t.fast_info
            return float(fi.last_price), float(fi.previous_close)
        live_price, prev_close = await asyncio.get_event_loop().run_in_executor(None, _live)
        gap_pct = (live_price - prev_close) / prev_close * 100 if prev_close else 0
        if gap_pct > 2.0:
            logger.info("virtual_engine: %s gapped +%.1f%% — skip chasing", sotd_ticker, gap_pct)
            return {"action": "SKIP", "reason": f"Gap-up +{gap_pct:.1f}% exceeds 2% threshold"}
        entry_price = live_price
    except Exception:
        entry_price = sotd_price  # fallback to SOTD price

    quantity = allocation / entry_price
    today = date.today().isoformat()

    spy_df, vix = await _get_spy_vix()
    rescore = await asyncio.get_event_loop().run_in_executor(
        None, _lightweight_rescore, sotd_ticker, spy_df, vix
    )

    explanation = await _explain_decision(
        "BUY", sotd_ticker,
        rescore["indicators"] if rescore else {},
        rescore["breakdown"] if rescore else {},
        sotd_score, sotd_score, sotd_regime, sotd_regime,
        0.0, 0, dict(acct), []
    )

    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO virtual_positions
               (account_id, config_id, ticker, entry_date, entry_price, quantity,
                entry_score, entry_regime, status)
               VALUES (?,?,?,?,?,?,?,?,'OPEN')""",
            (ACCOUNT_ID, CONFIG_ID, sotd_ticker, today,
             round(entry_price, 4), round(quantity, 6), sotd_score, sotd_regime)
        )
        pos_id = cur.lastrowid

        await db.execute(
            """INSERT INTO virtual_trades
               (position_id, action, trade_date, price, quantity, score_at_trade, reasoning_json)
               VALUES (?,?,?,?,?,?,?)""",
            (pos_id, "BUY", today, round(entry_price, 4),
             round(quantity, 6), sotd_score, json.dumps(explanation))
        )

        new_cash = acct["cash"] - (entry_price * quantity)
        await db.execute(
            "UPDATE virtual_account SET cash = ?, updated_at = ? WHERE id = ?",
            (round(new_cash, 4), datetime.now(UTC).isoformat(), ACCOUNT_ID)
        )

        await db.execute(
            """INSERT INTO decision_log
               (account_id, position_id, date, ticker, action, score_current, score_previous,
                regime_current, regime_entry, return_pct, days_held, confidence, reasoning_json)
               VALUES (?,?,?,?,'BUY',?,?,?,?,0,0,?,?)""",
            (ACCOUNT_ID, pos_id, today, sotd_ticker, sotd_score, sotd_score,
             sotd_regime, sotd_regime, explanation.get("confidence", "Medium"),
             json.dumps(explanation))
        )
        await db.commit()

    logger.info("virtual_engine: BUY %s @ %.2f qty=%.4f cash_remaining=%.2f",
                sotd_ticker, entry_price, quantity, new_cash)
    return {"action": "BUY", "ticker": sotd_ticker, "price": entry_price,
            "quantity": quantity, "explanation": explanation}


# ── Exit engine ───────────────────────────────────────────────────────────────

def _check_exit_triggers(pos: dict, ind: dict, current_score: int,
                          current_regime: str, cfg: dict) -> Optional[str]:
    """Returns exit reason string if any trigger fires, else None."""
    entry_date = date.fromisoformat(pos["entry_date"])
    days_held  = (date.today() - entry_date).days

    if days_held < cfg["min_hold_days"]:
        return None  # Hard lock — never exit before min_hold

    return_pct = (ind["price"] / pos["entry_price"] - 1) * 100

    if days_held >= cfg["max_hold_days"]:
        return f"Max hold {cfg['max_hold_days']}d reached"
    if return_pct <= cfg["stop_loss_pct"]:
        return f"Stop loss hit ({return_pct:.1f}% ≤ {cfg['stop_loss_pct']}%)"
    if return_pct >= cfg["profit_target_pct"]:
        return f"Profit target hit ({return_pct:.1f}% ≥ {cfg['profit_target_pct']}%)"
    if current_score < cfg["score_exit_threshold"]:
        return f"Score deterioration ({pos['entry_score']}→{current_score} < {cfg['score_exit_threshold']})"
    if current_regime != pos["entry_regime"] and current_regime == "BEAR":
        return f"Regime mismatch: entered {pos['entry_regime']}, now {current_regime}"
    if not ind["above_sma20"] and ind["rsi"] < 45 and ind["adx"] < 20:
        return "Momentum breakdown: below SMA20, RSI<45, ADX<20"

    return None


async def evaluate_positions() -> list[dict]:
    """
    Runs after market close. Evaluates all OPEN positions after min_hold_days.
    Returns list of actions taken.
    """
    acct     = await get_account()
    if not acct:
        return []

    positions = await get_open_positions()
    if not positions:
        await _snapshot_benchmark()
        return []

    cfg      = dict(acct)
    spy_df, vix = await _get_spy_vix()
    today    = date.today().isoformat()
    actions  = []
    tickers  = [p["ticker"] for p in positions]

    # Fetch all at once
    rescores: dict[str, Optional[dict]] = {}
    for t in tickers:
        rescores[t] = await asyncio.get_event_loop().run_in_executor(
            None, _lightweight_rescore, t, spy_df, vix
        )

    cash = acct["cash"]
    invested_value = 0.0

    for pos in positions:
        ticker    = pos["ticker"]
        rescore   = rescores.get(ticker)
        entry_date = date.fromisoformat(pos["entry_date"])
        days_held  = (date.today() - entry_date).days

        if rescore is None:
            # Can't score — just mark current value with entry price
            invested_value += pos["entry_price"] * pos["quantity"]
            continue

        ind            = rescore["indicators"]
        current_score  = rescore["score"]
        current_regime = rescore["regime"]
        return_pct     = round((ind["price"] / pos["entry_price"] - 1) * 100, 2)

        exit_reason = _check_exit_triggers(pos, ind, current_score, current_regime, cfg)

        if exit_reason:
            explanation = await _explain_decision(
                "SELL", ticker, ind, rescore["breakdown"],
                pos["entry_score"], current_score,
                pos["entry_regime"], current_regime,
                return_pct, days_held, cfg, []
            )

            async with aiosqlite.connect(DB_PATH) as db:
                await db.execute(
                    """UPDATE virtual_positions
                       SET status='CLOSED', exit_date=?, exit_price=?, exit_reason=?
                       WHERE id=?""",
                    (today, ind["price"], exit_reason, pos["id"])
                )
                await db.execute(
                    """INSERT INTO virtual_trades
                       (position_id, action, trade_date, price, quantity, score_at_trade, reasoning_json)
                       VALUES (?,?,?,?,?,?,?)""",
                    (pos["id"], "SELL", today, ind["price"],
                     pos["quantity"], current_score, json.dumps(explanation))
                )
                proceeds = ind["price"] * pos["quantity"]
                cash += proceeds
                await db.execute(
                    "UPDATE virtual_account SET cash = ?, updated_at = ? WHERE id = ?",
                    (round(cash, 4), datetime.now(UTC).isoformat(), ACCOUNT_ID)
                )
                await db.execute(
                    """INSERT INTO decision_log
                       (account_id, position_id, date, ticker, action,
                        score_current, score_previous, regime_current, regime_entry,
                        return_pct, days_held, confidence, reasoning_json)
                       VALUES (?,?,?,?,'SELL',?,?,?,?,?,?,?,?)""",
                    (ACCOUNT_ID, pos["id"], today, ticker, current_score,
                     pos["entry_score"], current_regime, pos["entry_regime"],
                     return_pct, days_held,
                     explanation.get("confidence", "Medium"), json.dumps(explanation))
                )
                await db.commit()

            actions.append({"action": "SELL", "ticker": ticker, "return_pct": return_pct,
                             "reason": exit_reason, "explanation": explanation})
            logger.info("virtual_engine: SELL %s return=%.2f%% reason=%s",
                        ticker, return_pct, exit_reason)

        else:
            # HOLD
            explanation = await _explain_decision(
                "HOLD", ticker, ind, rescore["breakdown"],
                pos["entry_score"], current_score,
                pos["entry_regime"], current_regime,
                return_pct, days_held, cfg, []
            )
            async with aiosqlite.connect(DB_PATH) as db:
                await db.execute(
                    """INSERT INTO decision_log
                       (account_id, position_id, date, ticker, action,
                        score_current, score_previous, regime_current, regime_entry,
                        return_pct, days_held, confidence, reasoning_json)
                       VALUES (?,?,?,?,'HOLD',?,?,?,?,?,?,?,?)""",
                    (ACCOUNT_ID, pos["id"], today, ticker, current_score,
                     pos["entry_score"], current_regime, pos["entry_regime"],
                     return_pct, days_held,
                     explanation.get("confidence", "Medium"), json.dumps(explanation))
                )
                await db.commit()

            invested_value += ind["price"] * pos["quantity"]
            actions.append({"action": "HOLD", "ticker": ticker, "return_pct": return_pct,
                             "score": current_score, "explanation": explanation})
            logger.info("virtual_engine: HOLD %s return=%.2f%% score=%d",
                        ticker, return_pct, current_score)

    # Check floor — suspend if cash below floor
    total_value = cash + invested_value
    if total_value < acct["floor_value"] and cash < acct["floor_value"]:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "UPDATE virtual_account SET is_suspended = 1, updated_at = ? WHERE id = ?",
                (datetime.now(UTC).isoformat(), ACCOUNT_ID)
            )
            await db.commit()
        logger.warning("virtual_engine: portfolio below floor $%.0f — SUSPENDED", acct["floor_value"])

    await _snapshot_portfolio(ACCOUNT_ID, cash, invested_value,
                               await _open_position_count(), acct["initial_capital"])
    await _snapshot_benchmark()

    return actions


# ── Wallet reload ─────────────────────────────────────────────────────────────

async def reload_wallet(amount: float) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT cash, is_suspended FROM virtual_account WHERE id = ?", (ACCOUNT_ID,)
        ) as cur:
            row = await cur.fetchone()
    if not row:
        return {"error": "account not found"}
    new_cash = round(row[0] + amount, 2)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE virtual_account SET cash = ?, is_suspended = 0, updated_at = ? WHERE id = ?",
            (new_cash, datetime.now(UTC).isoformat(), ACCOUNT_ID)
        )
        await db.commit()
    logger.info("virtual_engine: reloaded $%.2f — new cash $%.2f", amount, new_cash)
    return {"cash": new_cash, "reloaded": amount, "suspended": False}


# ── Backfill from stock_picks ─────────────────────────────────────────────────

async def backfill_from_history() -> dict:
    """
    Seed virtual positions from historical stock_picks where score >= buy_threshold.
    Skips picks that are already in virtual_positions.
    Applies max_positions and cash constraints in chronological order.
    """
    acct = await get_account()
    if not acct:
        return {"error": "no account"}

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM stock_picks ORDER BY pick_date ASC"
        ) as cur:
            picks = [dict(r) for r in await cur.fetchall()]

        async with db.execute(
            "SELECT ticker, entry_date FROM virtual_positions WHERE account_id = ?",
            (ACCOUNT_ID,)
        ) as cur:
            existing = {(r["ticker"], r["entry_date"]) for r in await cur.fetchall()}

    cfg      = dict(acct)
    cash     = acct["cash"]
    open_pos: list[dict] = []
    today_str = date.today().isoformat()
    created  = 0
    skipped  = 0

    for pick in picks:
        sig = json.loads(pick["signal_json"] or "{}")

        # V2 SOTD pipeline nests pick under "stock_of_the_day"
        sotd = sig.get("stock_of_the_day") or {}

        # Skip no-trade days
        if sig.get("no_trade_day") or not sotd:
            skipped += 1
            continue

        score = sotd.get("confidence_score") or sotd.get("score") or sig.get("score")
        if score is None:
            skipped += 1
            continue
        if score < cfg["buy_threshold"]:
            skipped += 1
            continue

        ticker     = pick["symbol"]
        pick_date  = pick["pick_date"]

        if (ticker, pick_date) in existing:
            skipped += 1
            continue

        # Expire positions over max_hold_days
        cutoff = (date.fromisoformat(pick_date) - timedelta(days=cfg["max_hold_days"])).isoformat()
        open_pos = [p for p in open_pos if p["entry_date"] > cutoff]

        if len(open_pos) >= cfg["max_positions"]:
            skipped += 1
            continue

        allocation = cash * (cfg["allocation_pct"] / 100)
        if cash < allocation:
            skipped += 1
            continue

        # Price is nested at stock_of_the_day.metrics.price in V2 pipeline output
        metrics = sotd.get("metrics") or {}
        price = metrics.get("price") or (sotd.get("technicals") or {}).get("price")
        if not price or price <= 0:
            skipped += 1
            continue

        quantity = allocation / price
        regime   = pick.get("regime") or "BULL"

        # Determine status
        days_since = (date.today() - date.fromisoformat(pick_date)).days
        status = "OPEN" if days_since < cfg["max_hold_days"] else "CLOSED"
        exit_date  = None
        exit_price = None
        exit_reason = None

        if status == "CLOSED":
            exit_date   = (date.fromisoformat(pick_date) + timedelta(days=cfg["max_hold_days"])).isoformat()
            exit_reason = f"Max hold {cfg['max_hold_days']}d reached (backfill)"
            try:
                def _close_price(t=ticker):
                    hist = yf.Ticker(t).history(period="3mo")
                    return round(float(hist["Close"].iloc[-1]), 4) if len(hist) else price
                exit_price = await asyncio.get_event_loop().run_in_executor(None, _close_price)
            except Exception:
                exit_price = price

        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """INSERT OR IGNORE INTO virtual_positions
                   (account_id, config_id, ticker, entry_date, entry_price, quantity,
                    entry_score, entry_regime, status, exit_date, exit_price, exit_reason)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (ACCOUNT_ID, CONFIG_ID, ticker, pick_date, round(price, 4),
                 round(quantity, 6), score, regime, status,
                 exit_date, exit_price, exit_reason)
            )
            await db.commit()

        cash -= allocation
        if cash < 0:
            cash = 0
        if status == "OPEN":
            open_pos.append({"ticker": ticker, "entry_date": pick_date})
        created += 1

    # Sync cash to account
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE virtual_account SET cash = ?, updated_at = ? WHERE id = ?",
            (round(max(cash, 0), 2), datetime.now(UTC).isoformat(), ACCOUNT_ID)
        )
        await db.commit()

    logger.info("virtual_engine: backfill complete — created=%d skipped=%d", created, skipped)
    return {"created": created, "skipped": skipped}


# ── Portfolio summary ─────────────────────────────────────────────────────────

async def get_portfolio_summary() -> dict:
    acct = await get_account()
    if not acct:
        return {}

    positions = await get_open_positions()

    spy_df, vix = await _get_spy_vix()

    invested = 0.0
    positions_out = []
    for pos in positions:
        rescore = await asyncio.get_event_loop().run_in_executor(
            None, _lightweight_rescore, pos["ticker"], spy_df, vix
        )
        current_price = rescore["indicators"]["price"] if rescore else pos["entry_price"]
        return_pct    = round((current_price / pos["entry_price"] - 1) * 100, 2)
        days_held     = (date.today() - date.fromisoformat(pos["entry_date"])).days
        value         = current_price * pos["quantity"]
        invested      += value

        score_status = "Unknown"
        if rescore:
            s = rescore["score"]
            score_status = "Strong" if s >= 75 else "Watchlist" if s >= 60 else "Weakening"

        positions_out.append({
            "id":            pos["id"],
            "ticker":        pos["ticker"],
            "entry_date":    pos["entry_date"],
            "entry_price":   pos["entry_price"],
            "current_price": round(current_price, 2),
            "return_pct":    return_pct,
            "days_held":     days_held,
            "current_score": rescore["score"] if rescore else None,
            "entry_score":   pos["entry_score"],
            "score_status":  score_status,
            "value":         round(value, 2),
        })

    total      = acct["cash"] + invested
    cum_return = round((total / acct["initial_capital"] - 1) * 100, 2)

    # SPY benchmark
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM benchmark_daily ORDER BY date DESC LIMIT 1"
        ) as cur:
            bench = await cur.fetchone()
    spy_cum = dict(bench)["spy_cumulative_pct"] if bench else 0.0
    alpha   = round(cum_return - spy_cum, 2)

    return {
        "total_value":     round(total, 2),
        "cash":            round(acct["cash"], 2),
        "invested_value":  round(invested, 2),
        "initial_capital": acct["initial_capital"],
        "cumulative_return_pct": cum_return,
        "spy_cumulative_pct":    spy_cum,
        "alpha_pct":       alpha,
        "is_suspended":    bool(acct["is_suspended"]),
        "floor_value":     acct["floor_value"],
        "open_positions":  positions_out,
    }
