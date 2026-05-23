"""
app/simulator/backtest_engine.py

Historical backtest engine.

Phase 1 — Download & Cache:
  Downloads yfinance OHLCV for the universe + SPY + VIX + sector ETFs.
  Stores in cached_prices table (one download, reused forever).

Phase 2 — Precompute Score Matrix:
  For each (ticker, day), computes all technical indicators using only
  data up to that day (no lookahead). Scores with _score_v2 once.
  Result is held in memory for the run.

Phase 3 — Parameter Sweep:
  For each strategy/param combo, iterates through pre-scored days.
  No indicator recomputation — just threshold filtering on cached scores.
  ~5-10ms per combo after precompute.

No LLM calls anywhere in this module.
"""
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Callable, Optional

import aiosqlite
import pandas as pd
import numpy as np
from ta.momentum import RSIIndicator
from ta.trend import SMAIndicator, ADXIndicator
from ta.volatility import BollingerBands
import yfinance as yf

from app.config import DB_PATH
from app.simulator.universe import UNIVERSE, SECTOR_ETFS, TICKERS, ALL_DOWNLOAD_TICKERS
from app.simulator.metrics import compute_metrics, compute_composite_scores
from app.analysis.virtual_engine import _score_v2, _scalar

logger = logging.getLogger(__name__)

INITIAL_CAPITAL = 10_000.0


# ── Data download & cache ─────────────────────────────────────────────────────

def _yf_download_batch(tickers: list[str], start: str, end: str) -> dict[str, pd.DataFrame]:
    """Download OHLCV for all tickers in one call. Returns {ticker: df}."""
    import warnings
    warnings.filterwarnings("ignore")
    raw = yf.download(tickers, start=start, end=end, auto_adjust=True, progress=False, group_by="ticker")

    result: dict[str, pd.DataFrame] = {}
    if isinstance(raw.columns, pd.MultiIndex):
        # yfinance >= 0.2 uses (ticker, field) order; older used (field, ticker).
        # Detect by checking which level contains OHLCV field names.
        level0_sample = raw.columns.get_level_values(0)[0]
        ticker_first  = level0_sample not in ("Open", "High", "Low", "Close", "Volume")

        for ticker in tickers:
            try:
                if ticker_first:
                    # New format: raw[ticker][["Open", ...]]
                    df = raw[ticker][["Open", "High", "Low", "Close", "Volume"]].dropna()
                else:
                    # Old format: raw["Open"][ticker], etc.
                    df = pd.DataFrame({
                        "Open":   raw["Open"][ticker],
                        "High":   raw["High"][ticker],
                        "Low":    raw["Low"][ticker],
                        "Close":  raw["Close"][ticker],
                        "Volume": raw["Volume"][ticker],
                    }).dropna()
                if not df.empty:
                    result[ticker] = df
            except Exception:
                pass
    else:
        # Single ticker returned flat
        if tickers and not raw.empty:
            result[tickers[0]] = raw[["Open", "High", "Low", "Close", "Volume"]].dropna()
    return result


async def ensure_prices_cached(tickers: list[str], start: str, end: str,
                                progress_fn: Optional[Callable] = None) -> None:
    """
    Download and cache any missing (ticker, date) rows.
    Only downloads what's not already in cached_prices.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT DISTINCT ticker FROM cached_prices WHERE date >= ? AND date <= ?",
            (start, end)
        ) as cur:
            cached_tickers = {r[0] for r in await cur.fetchall()}

    missing = [t for t in tickers if t not in cached_tickers]
    if not missing:
        return

    if progress_fn:
        await progress_fn(f"Downloading price data for {len(missing)} symbols…")

    # Download in batches of 50 to avoid yfinance timeouts
    batch_size = 50
    all_dfs: dict[str, pd.DataFrame] = {}
    for i in range(0, len(missing), batch_size):
        batch = missing[i:i + batch_size]
        dfs = await asyncio.to_thread(_yf_download_batch, batch, start, end)
        all_dfs.update(dfs)

    # Write to cache
    async with aiosqlite.connect(DB_PATH) as db:
        for ticker, df in all_dfs.items():
            for idx, row in df.iterrows():
                date_str = str(idx.date() if hasattr(idx, "date") else idx)
                await db.execute(
                    """INSERT OR IGNORE INTO cached_prices
                       (ticker, date, open, high, low, close, volume)
                       VALUES (?,?,?,?,?,?,?)""",
                    (ticker, date_str,
                     round(float(row["Open"]), 4),
                     round(float(row["High"]), 4),
                     round(float(row["Low"]), 4),
                     round(float(row["Close"]), 4),
                     float(row["Volume"])),
                )
        await db.commit()

    logger.info("backtest: cached prices for %d tickers (%s to %s)", len(all_dfs), start, end)


async def load_cached_prices(tickers: list[str], start: str, end: str) -> dict[str, pd.DataFrame]:
    """Load cached OHLCV from DB into memory for fast iteration."""
    placeholders = ",".join("?" * len(tickers))
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"""SELECT ticker, date, open, high, low, close, volume
                FROM cached_prices
                WHERE ticker IN ({placeholders}) AND date >= ? AND date <= ?
                ORDER BY ticker, date""",
            (*tickers, start, end)
        ) as cur:
            rows = await cur.fetchall()

    by_ticker: dict[str, list] = {}
    for r in rows:
        by_ticker.setdefault(r["ticker"], []).append(dict(r))

    result: dict[str, pd.DataFrame] = {}
    for ticker, records in by_ticker.items():
        df = pd.DataFrame(records)
        df["date"] = pd.to_datetime(df["date"])
        df = df.set_index("date").sort_index()
        df.columns = [c.title() if c in ("open", "high", "low", "close", "volume") else c for c in df.columns]
        df = df.rename(columns={"Open": "Open", "High": "High", "Low": "Low",
                                 "Close": "Close", "Volume": "Volume"})
        result[ticker] = df

    return result


# ── Vectorized indicator precompute ──────────────────────────────────────────

def _precompute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute all rolling indicators for every day in df in one vectorized pass.
    Returns DataFrame indexed by date with one row per trading day.
    Requires ≥30 rows; earlier rows will have NaN indicators (skipped in scoring).
    """
    close, high, low, volume = df["Close"], df["High"], df["Low"], df["Volume"]

    rsi   = RSIIndicator(close, window=14).rsi()
    sma20 = SMAIndicator(close, window=20).sma_indicator()
    adx   = ADXIndicator(high, low, close, window=14).adx()
    bb    = BollingerBands(close, window=20, window_dev=2)

    bb_upper = bb.bollinger_hband()
    bb_lower = bb.bollinger_lband()
    bb_width = (bb_upper - bb_lower) / close.replace(0, np.nan)
    bb_width5 = bb_width.shift(5)

    vol_avg20 = volume.rolling(20).mean()
    vol_ratio = volume / vol_avg20.replace(0, np.nan)

    r3  = close.pct_change(3)  * 100
    r5  = close.pct_change(5)  * 100
    r10 = close.pct_change(10) * 100

    rsi5 = rsi.shift(5)
    rsi_recovering = (rsi5 < 40) & (rsi > 48)

    return pd.DataFrame({
        "price":          close,
        "rsi":            rsi,
        "adx":            adx,
        "vol_ratio":      vol_ratio,
        "return_3d":      r3,
        "return_5d":      r5,
        "return_10d":     r10,
        "above_sma20":    close > sma20,
        "bb_squeeze":     (bb_width < bb_width5 * 0.85) & bb_width5.notna(),
        "above_upper_bb": close > bb_upper,
        "rsi_recovering": rsi_recovering,
    }, index=df.index)


# ── Regime detection ──────────────────────────────────────────────────────────

def _build_regime_series(spy_df: pd.DataFrame, vix_df: pd.DataFrame) -> pd.Series:
    """
    Return a Series indexed by date with BULL/BEAR/CHOP for each trading day.
    Uses only data available on that day (no lookahead — rolling computations).
    """
    spy_close = spy_df["Close"]
    sma50     = SMAIndicator(spy_close, window=50).sma_indicator()
    spy_10d   = spy_close.pct_change(10) * 100
    vix_close = vix_df["Close"].reindex(spy_df.index, method="ffill")

    regimes = []
    dates   = []
    for d in spy_df.index:
        v10 = spy_10d.get(d, 0) or 0
        vix  = vix_close.get(d, 20) or 20
        spx  = spy_close.get(d, 0) or 0
        s50  = sma50.get(d, 0) or 0
        above50 = spx > s50 if s50 > 0 else True

        if vix < 20 and above50 and v10 > 0:
            regime = "BULL"
        elif vix > 25 or (not above50 and v10 < -2):
            regime = "BEAR"
        else:
            regime = "CHOP"
        regimes.append(regime)
        dates.append(d)

    return pd.Series(regimes, index=pd.DatetimeIndex(dates))


# ── Score precompute ──────────────────────────────────────────────────────────

async def build_score_matrix(
    start: str, end: str, progress_fn: Optional[Callable] = None
) -> tuple[dict, dict, dict]:
    """
    Returns:
      score_matrix:   {date_str: {ticker: {score, indicators}}}
      price_close:    {date_str: {ticker: close_price}}
      regime_by_day:  {date_str: 'BULL'|'BEAR'|'CHOP'}
    """
    # Extend start by 90 days to give indicators enough warmup data
    dt_start = (datetime.strptime(start, "%Y-%m-%d") - timedelta(days=90)).strftime("%Y-%m-%d")

    if progress_fn:
        await progress_fn("Ensuring price cache is up to date…")
    await ensure_prices_cached(ALL_DOWNLOAD_TICKERS, dt_start, end, progress_fn)

    if progress_fn:
        await progress_fn("Loading price data into memory…")
    all_dfs = await load_cached_prices(ALL_DOWNLOAD_TICKERS, dt_start, end)

    spy_df = all_dfs.get("SPY", pd.DataFrame())
    vix_df = all_dfs.get("^VIX", pd.DataFrame())

    if spy_df.empty:
        raise RuntimeError("SPY price data unavailable — cannot classify regimes")

    if progress_fn:
        await progress_fn("Computing regime series…")
    regime_series = _build_regime_series(spy_df, vix_df)

    # Sector 10-day returns per sector ETF
    sector_r10: dict[str, pd.Series] = {}
    for sector, etf in SECTOR_ETFS.items():
        etf_df = all_dfs.get(etf)
        if etf_df is not None and not etf_df.empty:
            sector_r10[sector] = etf_df["Close"].pct_change(10) * 100

    # SPY 10-day return
    spy_r10 = spy_df["Close"].pct_change(10) * 100

    if progress_fn:
        await progress_fn("Precomputing technical indicators for all stocks…")

    indicator_dfs: dict[str, pd.DataFrame] = {}
    for ticker in TICKERS:
        df = all_dfs.get(ticker)
        if df is not None and len(df) >= 30:
            indicator_dfs[ticker] = await asyncio.to_thread(_precompute_indicators, df)

    if progress_fn:
        await progress_fn("Scoring all candidates across all days…")

    # Only process days within the requested range
    start_ts = pd.Timestamp(start)
    trading_days = [d for d in spy_df.index if d >= start_ts]

    score_matrix: dict  = {}
    price_close: dict   = {}
    regime_by_day: dict = {}

    for d in trading_days:
        d_str   = str(d.date())
        regime  = regime_series.get(d, "CHOP")
        spy10d  = float(spy_r10.get(d, 0) or 0)

        regime_by_day[d_str] = regime
        score_matrix[d_str]  = {}
        price_close[d_str]   = {}

        for ticker in TICKERS:
            ind_df = indicator_dfs.get(ticker)
            if ind_df is None or d not in ind_df.index:
                continue
            row = ind_df.loc[d]
            if pd.isna(row["rsi"]) or pd.isna(row["adx"]) or pd.isna(row["return_10d"]):
                continue

            price_close[d_str][ticker] = float(row["price"])

            ticker_sector = UNIVERSE.get(ticker, ("Unknown", "large"))[0]
            s10_series    = sector_r10.get(ticker_sector)
            s10d          = float(s10_series.get(d, 0) or 0) if s10_series is not None else 0.0

            ind = {
                "price":          float(row["price"]),
                "rsi":            float(row["rsi"]),
                "adx":            float(row["adx"]),
                "vol_ratio":      float(row["vol_ratio"]) if not pd.isna(row["vol_ratio"]) else 1.0,
                "return_3d":      float(row["return_3d"]) if not pd.isna(row["return_3d"]) else 0.0,
                "return_5d":      float(row["return_5d"]) if not pd.isna(row["return_5d"]) else 0.0,
                "return_10d":     float(row["return_10d"]),
                "above_sma20":    bool(row["above_sma20"]),
                "bb_squeeze":     bool(row["bb_squeeze"]),
                "above_upper_bb": bool(row["above_upper_bb"]),
                "rsi_recovering": bool(row["rsi_recovering"]),
            }
            is_momentum = not ind["rsi_recovering"]
            bd = _score_v2(ind, spy10d, s10d, regime, is_momentum)
            score_matrix[d_str][ticker] = {"score": bd["total"], "breakdown": bd, "indicators": ind}

    return score_matrix, price_close, regime_by_day


# ── Single backtest run ───────────────────────────────────────────────────────

def run_single_backtest(
    score_matrix: dict,
    price_close: dict,
    regime_by_day: dict,
    params: dict,
    initial_capital: float = INITIAL_CAPITAL,
) -> dict:
    """
    Deterministic, no-LLM backtest pass with given params.
    Returns portfolio_values list and trades list.
    """
    cash         = initial_capital
    positions: dict = {}
    portfolio_values: list[tuple] = []
    trades: list[dict]            = []

    buy_threshold  = params["buy_threshold"]
    stop_loss_pct  = params["stop_loss_pct"]
    profit_target  = params["profit_target_pct"]
    max_hold_days  = params["max_hold_days"]
    min_hold_days  = params["min_hold_days"]
    max_positions  = params["max_positions"]
    allocation_pct = params["allocation_pct"]
    score_exit_th  = params.get("score_exit_threshold", 60)
    regime_filter  = params.get("regime_filter", "ALL")

    allocation_amt = initial_capital * allocation_pct / 100

    sorted_days = sorted(score_matrix.keys())
    day_index   = {d: i for i, d in enumerate(sorted_days)}

    for d_str in sorted_days:
        regime      = regime_by_day.get(d_str, "CHOP")
        scores_day  = score_matrix.get(d_str, {})
        prices_day  = price_close.get(d_str, {})

        # ── 1. Evaluate existing positions ──────────────────────────────────
        to_sell = []
        for ticker, pos in positions.items():
            price = prices_day.get(ticker)
            if price is None:
                continue
            days_held  = day_index[d_str] - day_index.get(pos["entry_date"], 0)
            return_pct = (price / pos["entry_price"] - 1) * 100
            cur_score  = scores_day.get(ticker, {}).get("score", score_exit_th)

            exit_reason = None
            if days_held >= min_hold_days:
                if days_held >= max_hold_days:
                    exit_reason = f"Max hold ({max_hold_days}d) reached"
                elif return_pct <= stop_loss_pct:
                    exit_reason = f"Stop loss hit ({return_pct:.1f}%)"
                elif return_pct >= profit_target:
                    exit_reason = f"Profit target reached ({return_pct:.1f}%)"
                elif cur_score < score_exit_th:
                    exit_reason = f"Signal weakened (score {cur_score} < {score_exit_th})"
                elif regime == "BEAR" and pos["entry_regime"] != "BEAR":
                    exit_reason = "Market shifted to BEAR — exited"

            if exit_reason:
                cash += price * pos["quantity"]
                trades.append({
                    "action":        "SELL",
                    "ticker":        ticker,
                    "date":          d_str,
                    "price":         round(price, 4),
                    "quantity":      round(pos["quantity"], 6),
                    "entry_price":   pos["entry_price"],
                    "return_pct":    round(return_pct, 2),
                    "days_held":     days_held,
                    "exit_reason":   exit_reason,
                    "entry_score":   pos["entry_score"],
                    "exit_score":    cur_score,
                    "entry_regime":  pos["entry_regime"],
                    "exit_regime":   regime,
                })
                to_sell.append(ticker)

        for ticker in to_sell:
            del positions[ticker]

        # ── 2. Find entry candidate ──────────────────────────────────────────
        can_enter = not (regime_filter == "BULL" and regime != "BULL")
        if can_enter and len(positions) < max_positions and cash >= allocation_amt:
            best_ticker = None
            best_score  = buy_threshold - 1

            for ticker, data in scores_day.items():
                if ticker in positions:
                    continue
                if data["score"] <= best_score:
                    continue
                ind = data["indicators"]
                # Minimum quality gates (same as production pipeline)
                if ind["vol_ratio"] < 1.2:
                    continue
                if not ind["above_sma20"]:
                    continue
                best_score  = data["score"]
                best_ticker = ticker

            if best_ticker:
                entry_price = prices_day.get(best_ticker)
                if entry_price and entry_price > 0:
                    quantity = allocation_amt / entry_price
                    cash    -= allocation_amt
                    positions[best_ticker] = {
                        "entry_date":   d_str,
                        "entry_price":  round(entry_price, 4),
                        "quantity":     round(quantity, 6),
                        "entry_score":  best_score,
                        "entry_regime": regime,
                    }
                    trades.append({
                        "action":     "BUY",
                        "ticker":     best_ticker,
                        "date":       d_str,
                        "price":      round(entry_price, 4),
                        "quantity":   round(quantity, 6),
                        "score":      best_score,
                        "regime":     regime,
                        "allocation": round(allocation_amt, 2),
                    })

        # ── 3. Mark to market ────────────────────────────────────────────────
        invested = 0.0
        for ticker, pos in positions.items():
            p = prices_day.get(ticker, pos["entry_price"])
            invested += p * pos["quantity"]

        portfolio_values.append((d_str, round(cash + invested, 2)))

    # Close remaining positions at last available price
    if sorted_days:
        last_day = sorted_days[-1]
        for ticker, pos in positions.items():
            price      = price_close.get(last_day, {}).get(ticker, pos["entry_price"])
            return_pct = (price / pos["entry_price"] - 1) * 100
            days_held  = day_index[last_day] - day_index.get(pos["entry_date"], 0)
            trades.append({
                "action":       "SELL",
                "ticker":       ticker,
                "date":         last_day,
                "price":        round(price, 4),
                "quantity":     round(pos["quantity"], 6),
                "entry_price":  pos["entry_price"],
                "return_pct":   round(return_pct, 2),
                "days_held":    days_held,
                "exit_reason":  "Backtest period ended (position closed)",
                "entry_score":  pos["entry_score"],
                "exit_score":   0,
                "entry_regime": pos["entry_regime"],
                "exit_regime":  regime_by_day.get(last_day, "CHOP"),
            })

    return {"portfolio_values": portfolio_values, "trades": trades, "final_cash": cash}


# ── Parameter sweep ───────────────────────────────────────────────────────────

def build_param_sweep(base_params: dict) -> list[dict]:
    """
    Generate sweep grid around a strategy's base params.
    ±5 on buy_threshold, ±2% on stop_loss, ±5% on profit_target.
    Returns list of param dicts (includes base).
    """
    buy_base  = base_params["buy_threshold"]
    stop_base = base_params["stop_loss_pct"]
    tgt_base  = base_params["profit_target_pct"]

    combos = []
    for b_delta in (-5, 0, 5):
        for s_delta in (-2, 0, 2):
            for t_delta in (-5, 0, 5):
                p = dict(base_params)
                p["buy_threshold"]    = buy_base + b_delta
                p["stop_loss_pct"]    = round(stop_base + s_delta, 1)
                p["profit_target_pct"] = round(tgt_base + t_delta, 1)
                # Sanity guards
                if p["buy_threshold"] < 50 or p["buy_threshold"] > 95:
                    continue
                if p["stop_loss_pct"] > -2:
                    continue
                if p["profit_target_pct"] < 5:
                    continue
                p["variant"] = f"b{p['buy_threshold']}_s{p['stop_loss_pct']}_t{p['profit_target_pct']}"
                combos.append(p)
    return combos


# ── Full run orchestration ────────────────────────────────────────────────────

async def run_backtest_job(
    run_id: str,
    strategies: list[dict],
    start: str,
    end: str,
    sweep_params: bool,
    progress_fn: Optional[Callable] = None,
    initial_capital: float = INITIAL_CAPITAL,
) -> list[dict]:
    """
    Full backtest job. Precomputes once, runs all strategy/param combos.
    Returns list of result dicts ready for storage + composite scoring.
    """
    # Phase 1+2: precompute (expensive, done once)
    score_matrix, price_close, regime_by_day = await build_score_matrix(start, end, progress_fn)

    if progress_fn:
        await progress_fn(f"Score matrix ready — {len(score_matrix)} trading days × {len(TICKERS)} stocks")

    results: list[dict] = []

    for strategy in strategies:
        base_params = {
            "buy_threshold":      strategy["buy_threshold"],
            "stop_loss_pct":      strategy["stop_loss_pct"],
            "profit_target_pct":  strategy["profit_target_pct"],
            "max_hold_days":      strategy["max_hold_days"],
            "min_hold_days":      strategy["min_hold_days"],
            "max_positions":      strategy["max_positions"],
            "allocation_pct":     strategy["allocation_pct"],
            "score_exit_threshold": strategy.get("score_exit_threshold", 60),
            "regime_filter":      strategy.get("regime_filter", "ALL"),
        }

        param_list = build_param_sweep(base_params) if sweep_params else [base_params]

        for params in param_list:
            variant = params.get("variant", "base")
            name    = f"{strategy['name']}" if variant == "base" else f"{strategy['name']}_{variant}"

            if progress_fn:
                await progress_fn(f"Running {name}…")

            raw = await asyncio.to_thread(
                run_single_backtest, score_matrix, price_close, regime_by_day,
                params, initial_capital
            )
            metrics = compute_metrics(
                raw["portfolio_values"], raw["trades"],
                initial_capital, regime_by_day
            )
            results.append({
                "strategy_name":   name,
                "base_strategy":   strategy["name"],
                "params":          params,
                "metrics":         metrics,
                "trades":          raw["trades"],
                "portfolio_values": raw["portfolio_values"],
                "composite_score": 0.0,
                "rank":            0,
            })

    # Compute composite scores + ranks across all results
    compute_composite_scores(results)

    return results
