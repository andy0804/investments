"""
app/simulator/market_engine.py

Synthetic market data generator.

Model: Hybrid GBM + GARCH(1,1) + Markov regime switching + sector factor model
       + fat-tail jump events + correlated volume.

All randomness seeded via numpy.random.default_rng(seed) — same seed → identical data.
Output stored in simulated_prices table keyed by run_id.

Mathematical details:

  Price:   S(t+1) = S(t) * exp(μ_t + σ_t * ε_t + jump_t)
  GARCH:   σ²_t = α + β * σ²_{t-1} + γ * ε²_{t-1}
  Sector:  R_stock = ρ * R_sector + sqrt(1-ρ²) * ε_idio
  Volume:  V_t = V_base * (1 + |R_t| * k) * exp(N(0, 0.3))
  Regime:  Markov transition matrix with daily probabilities
  Momentum: slight positive autocorrelation φ=0.03
"""
import asyncio
import logging
import math
from datetime import date, timedelta
from typing import Optional, Callable

import numpy as np
import aiosqlite

from app.config import DB_PATH

logger = logging.getLogger(__name__)

# ── Regime parameters ─────────────────────────────────────────────────────────

REGIME_PARAMS = {
    "BULL": {"mu_daily": 0.0008,  "sigma_base": 0.012, "vol_of_vol": 0.10},
    "BEAR": {"mu_daily": -0.0008, "sigma_base": 0.022, "vol_of_vol": 0.20},
    "CHOP": {"mu_daily": 0.0001,  "sigma_base": 0.018, "vol_of_vol": 0.15},
}

# Markov transition matrix: BULL, BEAR, CHOP (rows = from, cols = to)
TRANSITION = {
    "BULL": {"BULL": 0.97, "BEAR": 0.01, "CHOP": 0.02},
    "BEAR": {"BULL": 0.03, "BEAR": 0.93, "CHOP": 0.04},
    "CHOP": {"BULL": 0.06, "BEAR": 0.04, "CHOP": 0.90},
}

# GARCH(1,1) parameters (same across regimes, regime shifts mu/sigma_base)
GARCH_ALPHA = 0.000002   # long-run variance floor
GARCH_BETA  = 0.88       # volatility persistence
GARCH_GAMMA = 0.10       # shock impact on next period variance

# Sector factor model
SECTOR_CORR = 0.55       # ρ: sector factor loading

# Momentum autocorrelation
PHI = 0.03

# Fat tail events
JUMP_PROB      = 0.02    # 2% daily probability of a shock
JUMP_MIN_PCT   = 0.05    # ±5% minimum shock
JUMP_MAX_PCT   = 0.15    # ±15% maximum shock

# Volume model
VOLUME_K = 5.0           # volume sensitivity to absolute return

# Cap size parameters
CAP_PARAMS = {
    "large": {"sigma_mult": 1.0,  "sector_corr_mult": 1.0,  "base_volume": 5_000_000},
    "mid":   {"sigma_mult": 1.4,  "sector_corr_mult": 0.80, "base_volume": 1_500_000},
    "small": {"sigma_mult": 2.0,  "sector_corr_mult": 0.55, "base_volume": 300_000},
}

REGIMES = ("BULL", "BEAR", "CHOP")


def _next_regime(current: str, rng: np.random.Generator) -> str:
    probs  = TRANSITION[current]
    states = list(probs.keys())
    p      = [probs[s] for s in states]
    idx    = rng.choice(len(states), p=p)
    return states[idx]


def _trading_days(start: date, n_days: int) -> list[date]:
    """Return n_days worth of weekday dates starting from start."""
    days  = []
    d     = start
    while len(days) < n_days:
        if d.weekday() < 5:   # Mon-Fri
            days.append(d)
        d += timedelta(days=1)
    return days


def generate_market(
    config: dict,
    sector_list: list[str],
    tickers: list[tuple],    # [(ticker, sector, cap_tier, initial_price), ...]
) -> dict[str, list[dict]]:
    """
    Core synchronous generator. Called via asyncio.to_thread.

    Args:
        config: simulation config dict (seed, num_stocks, simulation_days,
                market_regime, volatility_level, sector_bias)
        sector_list: list of sector names
        tickers: list of (ticker, sector, cap_tier, initial_price) tuples

    Returns:
        {ticker: [{"date": str, "open": float, "high": float, "low": float,
                   "close": float, "volume": float, "regime": str}, ...]}
    """
    seed    = config.get("seed", 42)
    n_days  = config.get("simulation_days", 30)
    vol_lvl = config.get("volatility_level", "MEDIUM")
    start_d = date.today()

    rng = np.random.default_rng(seed)

    # Volatility level multiplier
    vol_mult = {"LOW": 0.7, "MEDIUM": 1.0, "HIGH": 1.6}.get(vol_lvl, 1.0)

    # Regime series (shared across all stocks)
    start_regime = config.get("market_regime", "BULL")
    regime_series: list[str] = [start_regime]
    for _ in range(n_days - 1):
        regime_series.append(_next_regime(regime_series[-1], rng))

    trading_days = _trading_days(start_d, n_days)

    # Sector-level returns per day (one per sector)
    sector_returns: dict[str, list[float]] = {s: [] for s in sector_list}
    sector_sigma: dict[str, float]         = {s: 0.012 for s in sector_list}
    sector_eps_prev: dict[str, float]      = {s: 0.0 for s in sector_list}
    sector_var_prev: dict[str, float]      = {s: 0.012 ** 2 for s in sector_list}
    sector_bias = config.get("sector_bias", {})

    for i, d in enumerate(trading_days):
        regime = regime_series[i]
        rp = REGIME_PARAMS[regime]
        mu_base = rp["mu_daily"]

        for sector in sector_list:
            bias      = sector_bias.get(sector, 0.0) / 252   # annualized → daily
            # GARCH variance update
            var_t     = (GARCH_ALPHA + GARCH_BETA * sector_var_prev[sector]
                         + GARCH_GAMMA * sector_eps_prev[sector] ** 2)
            sigma_t   = math.sqrt(var_t) * vol_mult
            eps       = float(rng.standard_normal())
            ret       = mu_base + bias + sigma_t * eps
            sector_returns[sector].append(ret)
            sector_eps_prev[sector] = eps
            sector_var_prev[sector] = var_t

    # Per-stock simulation
    output: dict[str, list[dict]] = {}

    for ticker, sector, cap_tier, initial_price in tickers:
        cp    = CAP_PARAMS.get(cap_tier, CAP_PARAMS["large"])
        rho   = SECTOR_CORR * cp["sector_corr_mult"]
        sig_mult = vol_mult * cp["sigma_mult"]
        base_vol = cp["base_volume"]

        price   = float(initial_price)
        var_t   = (REGIME_PARAMS[regime_series[0]]["sigma_base"] * sig_mult) ** 2
        eps_prev = 0.0
        ret_prev = 0.0
        records  = []

        for i in range(n_days):
            regime = regime_series[i]
            rp     = REGIME_PARAMS[regime]
            d      = trading_days[i]

            # GARCH variance
            var_t  = max(GARCH_ALPHA, GARCH_BETA * var_t + GARCH_GAMMA * eps_prev ** 2)
            sigma_t = math.sqrt(var_t) * sig_mult

            # Sector + idiosyncratic return
            r_sector = sector_returns[sector][i]
            eps_idio = float(rng.standard_normal())
            r_stock  = rho * r_sector + math.sqrt(max(0, 1 - rho ** 2)) * sigma_t * eps_idio

            # Momentum autocorrelation
            r_stock += PHI * ret_prev

            # Drift
            r_stock += rp["mu_daily"]

            # Fat tail jump
            if rng.random() < JUMP_PROB:
                jump_pct = float(rng.uniform(JUMP_MIN_PCT, JUMP_MAX_PCT))
                if rng.random() < 0.5:
                    jump_pct = -jump_pct
                r_stock += jump_pct

            eps_prev = float(rng.standard_normal())  # for next GARCH update
            ret_prev = r_stock

            # Price update
            close_price = max(0.01, price * math.exp(r_stock))

            # OHLCV construction
            intra_sigma = sigma_t * 0.6
            hi_noise    = abs(float(rng.standard_normal())) * intra_sigma
            lo_noise    = abs(float(rng.standard_normal())) * intra_sigma
            open_price  = max(0.01, price * math.exp(float(rng.standard_normal()) * intra_sigma * 0.3))

            high_price  = max(open_price, close_price) * (1 + hi_noise)
            low_price   = min(open_price, close_price) * (1 - lo_noise)

            # Volume: correlated with |return|
            vol_noise = math.exp(float(rng.standard_normal()) * 0.3)
            volume    = max(1000, int(base_vol * (1 + abs(r_stock) * VOLUME_K) * vol_noise))

            records.append({
                "date":   str(d),
                "open":   round(open_price, 4),
                "high":   round(high_price, 4),
                "low":    round(low_price, 4),
                "close":  round(close_price, 4),
                "volume": volume,
                "regime": regime,
            })

            price = close_price

        output[ticker] = records

    return output


async def run_simulation(
    run_id: str,
    config: dict,
    progress_fn: Optional[Callable] = None,
) -> dict:
    """
    Generate synthetic market data and store in simulated_prices.
    Returns summary metadata.
    """
    from app.simulator.universe import UNIVERSE, TICKERS

    sector_list = list({v[0] for v in UNIVERSE.values()})

    # Build ticker list with initial prices (distribute $10–$500 range)
    rng_meta = np.random.default_rng(config.get("seed", 42) + 9999)
    tickers_input = [
        (t, UNIVERSE[t][0], UNIVERSE[t][1], float(rng_meta.uniform(10, 300)))
        for t in TICKERS
    ]

    if progress_fn:
        await progress_fn(f"Generating {config.get('simulation_days', 30)}-day synthetic market (seed={config.get('seed', 42)})…")

    ohlcv_data = await asyncio.to_thread(generate_market, config, sector_list, tickers_input)

    if progress_fn:
        await progress_fn("Storing synthetic prices in DB…")

    async with aiosqlite.connect(DB_PATH) as db:
        for ticker, records in ohlcv_data.items():
            for r in records:
                await db.execute(
                    """INSERT OR REPLACE INTO simulated_prices
                       (run_id, ticker, date, open, high, low, close, volume, regime)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (run_id, ticker, r["date"], r["open"], r["high"],
                     r["low"], r["close"], r["volume"], r["regime"])
                )
        await db.commit()

    n_stocks = len(ohlcv_data)
    n_days   = config.get("simulation_days", 30)
    logger.info("market_engine: generated %d stocks × %d days for run %s", n_stocks, n_days, run_id)
    return {"stocks_generated": n_stocks, "days": n_days, "run_id": run_id}


async def load_simulated_prices(run_id: str) -> dict[str, list[dict]]:
    """Load synthetic OHLCV from DB for a completed simulation run."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT ticker, date, open, high, low, close, volume, regime
               FROM simulated_prices WHERE run_id = ? ORDER BY ticker, date""",
            (run_id,)
        ) as cur:
            rows = await cur.fetchall()

    by_ticker: dict[str, list[dict]] = {}
    for r in rows:
        by_ticker.setdefault(r["ticker"], []).append(dict(r))
    return by_ticker
