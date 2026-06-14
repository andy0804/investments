"""
app/analysis/sotd_engine.py

V3 Stock-of-the-Day pipeline — Technical + Fundamental + Market Narrative + Risk Intelligence.

Architecture:
  Screener → yfinance OHLCV download → Fundamental batch fetch (cache + yfinance.info)
  → Technical Indicators → Hard Filters
  → V3 Scoring (70% technical, regime-aware + 30% fundamental quality)
  → Haiku Explainer (6-dimension institutional analysis) → DB cache

Entry point: run_sotd_pipeline(force_refresh=False) → dict
"""

import asyncio
import json
import logging
import os
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, UTC

import aiosqlite
import pandas as pd
import yfinance as yf
from ta.momentum import RSIIndicator
from ta.trend import ADXIndicator, SMAIndicator
from ta.volatility import BollingerBands

from app.config import DB_PATH

warnings.filterwarnings("ignore")
logger = logging.getLogger(__name__)

HAIKU_MODEL = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")

SECTOR_ETF: dict[str, str] = {
    "Technology": "XLK",
    "Financial Services": "XLF",
    "Healthcare": "XLV",
    "Consumer Cyclical": "XLY",
    "Communication Services": "XLC",
    "Industrials": "XLI",
    "Consumer Defensive": "XLP",
    "Energy": "XLE",
    "Utilities": "XLU",
    "Real Estate": "XLRE",
    "Basic Materials": "XLB",
}


# ── DB helpers ────────────────────────────────────────────────────────────────

async def _get_portfolio_symbols() -> set[str]:
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT DISTINCT symbol FROM positions WHERE position_type NOT IN ('Cash_MM')"
            ) as cur:
                rows = await cur.fetchall()
        return {r[0] for r in rows}
    except Exception:
        return set()


async def _get_cached_pick(pick_date: str) -> dict | None:
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT signal_json FROM stock_picks WHERE pick_date = ?", (pick_date,)
            ) as cur:
                row = await cur.fetchone()
        if row and row[0]:
            cached = json.loads(row[0])
            # Treat pipeline-failure caches as stale so they re-run automatically
            reason = cached.get("no_trade_reason", "")
            if cached.get("no_trade_day") and "unavailable" in reason.lower():
                logger.info("sotd_engine: stale failure cache (%s) — re-running", reason)
                return None
            return cached
    except Exception:
        pass
    return None


async def _cache_pick(pick_date: str, symbol: str | None, result: dict):
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """INSERT INTO stock_picks (pick_date, symbol, signal_json, regime, market_context_json)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(pick_date) DO UPDATE SET
                     symbol = excluded.symbol,
                     signal_json = excluded.signal_json,
                     regime = excluded.regime,
                     market_context_json = excluded.market_context_json,
                     created_at = excluded.created_at""",
                (
                    pick_date,
                    symbol or "",
                    json.dumps(result),
                    result.get("market_context", {}).get("regime", ""),
                    json.dumps(result.get("market_context", {})),
                ),
            )
            await db.commit()
    except Exception as e:
        logger.warning("_cache_pick failed: %s", e)


async def _get_prev_pick() -> str | None:
    """Return the most recent prior pick symbol, or None."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT symbol FROM stock_picks WHERE symbol != '' ORDER BY pick_date DESC LIMIT 1"
            ) as cur:
                row = await cur.fetchone()
        return row[0] if row else None
    except Exception:
        return None


async def _log_repeat_hit(ticker: str, score: int, pick_date: str) -> None:
    """Record that ticker scored #1 but was suppressed as a repeat pick."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """CREATE TABLE IF NOT EXISTS repeat_pick_log (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   ticker TEXT NOT NULL,
                   score INTEGER,
                   suppressed_on TEXT NOT NULL,
                   hit_count INTEGER NOT NULL DEFAULT 1
                )"""
            )
            await db.execute(
                """INSERT INTO repeat_pick_log (ticker, score, suppressed_on)
                   VALUES (?, ?, ?)""",
                (ticker, score, pick_date),
            )
            await db.commit()
        logger.info("sotd_engine: repeat pick suppressed — %s (score %s) on %s", ticker, score, pick_date)
    except Exception as e:
        logger.warning("_log_repeat_hit failed: %s", e)


# ── Scalar helper ─────────────────────────────────────────────────────────────

def _scalar(val) -> float:
    if hasattr(val, "item"):
        return val.item()
    if hasattr(val, "iloc"):
        v = val.iloc[0]
        return v.item() if hasattr(v, "item") else float(v)
    return float(val)


# ── Step 1: Screener (blocking — run in thread) ───────────────────────────────

_MARKET_CAP_MAP = {
    "large": "+Large (over $10bln)",
    "mid":   "+Mid (over $2bln)",
    "small": "+Small (over $300mln)",
}

_VOLUME_MAP = {
    500_000:   "Over 500K",
    750_000:   "Over 750K",
    1_000_000: "Over 1M",
    2_000_000: "Over 2M",
}


def _volume_filter(min_vol: int) -> str:
    for threshold in sorted(_VOLUME_MAP.keys(), reverse=True):
        if min_vol >= threshold:
            return _VOLUME_MAP[threshold]
    return "Over 500K"


def _price_filter(min_price: float) -> str:
    for p in [100, 90, 80, 70, 60, 50, 40, 30, 20, 15, 10, 7, 5, 4, 3, 2, 1]:
        if min_price >= p:
            return f"Over ${p}"
    return "Any"


def _fetch_candidates(
    portfolio: set[str],
    limit: int = 40,
    min_price: float = 10.0,
    min_avg_volume: int = 1_000_000,
    market_cap: str = "mid",
) -> list[dict]:
    from finvizfinance.screener.overview import Overview

    cap_filter = _MARKET_CAP_MAP.get(market_cap, "+Mid (over $2bln)")
    vol_filter  = _volume_filter(int(min_avg_volume))
    price_filter = _price_filter(min_price)

    fov = Overview()
    base_filters: dict = {
        "Country":        "USA",
        "Market Cap.":    cap_filter,
        "Average Volume": vol_filter,
        "Performance":    "Week Up",
        "RSI (14)":       "Not Overbought (<60)",
    }
    if price_filter != "Any":
        base_filters["Price"] = price_filter

    fov.set_filter(filters_dict=base_filters)
    try:
        df = fov.screener_view(order="Performance (Week)", ascend=False)
    except Exception as e:
        logger.warning("screener primary filter failed (%s) — retrying without RSI filter", e)
        fallback = {k: v for k, v in base_filters.items() if k != "RSI (14)"}
        fov.set_filter(filters_dict=fallback)
        df = fov.screener_view(order="Performance (Week)", ascend=False)

    logger.info("screener filters: price>%s vol>%s cap>%s", min_price, min_avg_volume, market_cap)

    out = []
    for _, row in df.head(limit).iterrows():
        t = str(row.get("Ticker", "")).strip()
        if t and t not in portfolio:
            out.append({
                "ticker":  t,
                "company": str(row.get("Company", t)),
                "sector":  str(row.get("Sector", "Unknown")),
            })
    logger.info("screener: %d raw → %d after portfolio exclusion", len(df), len(out))
    return out


# ── Step 2: Market data (blocking — run in thread) ────────────────────────────

def _fetch_market_data(tickers: list[str]) -> dict[str, pd.DataFrame]:
    all_t = tickers + ["SPY", "^VIX"] + list(SECTOR_ETF.values())
    unique = list(dict.fromkeys(all_t))
    raw = yf.download(unique, period="60d", auto_adjust=True, progress=False)
    out: dict[str, pd.DataFrame] = {}
    for t in unique:
        try:
            if isinstance(raw.columns, pd.MultiIndex):
                df = pd.DataFrame({
                    "Open":   raw["Open"][t],
                    "High":   raw["High"][t],
                    "Low":    raw["Low"][t],
                    "Close":  raw["Close"][t],
                    "Volume": raw["Volume"][t] if t != "^VIX" else 0,
                }).dropna()
            else:
                df = raw.copy()
            if len(df) >= 20:
                out[t] = df
        except Exception:
            pass
    logger.info("market data: downloaded %d tickers", len(out))
    return out


# ── Step 3: Indicators ────────────────────────────────────────────────────────

def _compute_indicators(df: pd.DataFrame) -> dict:
    close, volume = df["Close"], df["Volume"]
    rsi   = _scalar(RSIIndicator(close, window=14).rsi().iloc[-1])
    sma20 = SMAIndicator(close, window=20).sma_indicator()
    sma50 = SMAIndicator(close, window=min(50, len(df))).sma_indicator()
    bb    = BollingerBands(close, window=20, window_dev=2)
    try:
        adx = _scalar(ADXIndicator(df["High"], df["Low"], close, window=14).adx().iloc[-1])
    except (IndexError, Exception):
        adx = 0.0

    p_now = _scalar(close.iloc[-1])
    p_3d  = _scalar(close.iloc[-4])  if len(df) >= 4  else p_now
    p_5d  = _scalar(close.iloc[-6])  if len(df) >= 6  else p_now
    p_10d = _scalar(close.iloc[-11]) if len(df) >= 11 else p_now

    vol_avg   = _scalar(volume.iloc[-21:-1].mean()) if len(volume) >= 21 else _scalar(volume.mean())
    vol_today = _scalar(volume.iloc[-1])
    vol_ratio = vol_today / vol_avg if vol_avg > 0 else 0

    bb_h_now = _scalar(bb.bollinger_hband().iloc[-1])
    bb_l_now = _scalar(bb.bollinger_lband().iloc[-1])
    bb_h_5d  = _scalar(bb.bollinger_hband().iloc[-6]) if len(df) >= 6 else bb_h_now
    bb_l_5d  = _scalar(bb.bollinger_lband().iloc[-6]) if len(df) >= 6 else bb_l_now
    bb_w_now = (bb_h_now - bb_l_now) / p_now
    bb_w_5d  = (bb_h_5d - bb_l_5d) / p_5d if p_5d > 0 else bb_w_now

    bb_squeeze  = bb_w_now < bb_w_5d * 0.85
    above_upper = p_now > bb_h_now
    above_sma20 = p_now > _scalar(sma20.iloc[-1])
    above_sma50 = p_now > _scalar(sma50.iloc[-1])

    rsi_series     = RSIIndicator(close, window=14).rsi()
    rsi_5d_ago     = _scalar(rsi_series.iloc[-6]) if len(df) >= 20 else rsi
    rsi_recovering = (rsi_5d_ago < 40) and (rsi > 48)

    return {
        "price":         round(p_now, 2),
        "rsi":           round(rsi, 1),
        "adx":           round(adx, 1),
        "vol_ratio":     round(vol_ratio, 2),
        "avg_volume":    int(vol_avg),
        "return_3d":     round((p_now / p_3d - 1) * 100, 2),
        "return_5d":     round((p_now / p_5d - 1) * 100, 2),
        "return_10d":    round((p_now / p_10d - 1) * 100, 2),
        "above_sma20":   bool(above_sma20),
        "above_sma50":   bool(above_sma50),
        "bb_squeeze":    bool(bb_squeeze),
        "above_upper_bb": bool(above_upper),
        "rsi_recovering": bool(rsi_recovering),
    }


# ── Step 4: Hard filters ──────────────────────────────────────────────────────

def _apply_hard_filters(ind: dict) -> tuple[bool, str]:
    if ind["rsi"] > 78:
        return False, f"RSI {ind['rsi']} > 78 (overbought)"
    if ind["return_3d"] > 18:
        return False, f"3d move {ind['return_3d']}% > 18% (overextended)"
    if ind["avg_volume"] < 500_000:
        return False, f"avg vol {ind['avg_volume']:,} < 500K (illiquid)"
    if ind["return_5d"] > 10 and ind["vol_ratio"] < 1.2:
        return False, f"+{ind['return_5d']}% 5d on weak vol {ind['vol_ratio']}x (noise)"
    if ind["adx"] < 15 and not ind["bb_squeeze"] and ind["return_10d"] < 2:
        return False, f"ADX {ind['adx']} + no squeeze + flat 10d (no structure)"
    return True, "passed"


# ── Step 5: Regime classifier ─────────────────────────────────────────────────

def _classify_regime(spy_df: pd.DataFrame, vix: float) -> str:
    close   = spy_df["Close"]
    sma50   = _scalar(SMAIndicator(close, window=min(50, len(close))).sma_indicator().iloc[-1])
    spy_10d = (_scalar(close.iloc[-1]) / _scalar(close.iloc[-11]) - 1) * 100 if len(close) >= 11 else 0
    above50 = _scalar(close.iloc[-1]) > sma50
    if vix < 20 and above50 and spy_10d > 0:
        return "BULL"
    if vix > 25 or (not above50 and spy_10d < -2):
        return "BEAR"
    return "CHOP"


def _sector_multiplier(sector_10d: float, spy_10d: float) -> float:
    rel = sector_10d - spy_10d
    if rel > 5:   return 1.25
    if rel > 2:   return 1.10
    if rel > -2:  return 1.00
    if sector_10d < 0: return 0.75
    return 0.90


# ── Fundamental batch fetch (V3) ──────────────────────────────────────────────

async def _fetch_fundamental_batch(tickers: list[str]) -> dict[str, dict]:
    """Cache-first fundamental snapshot for all candidates. Falls back to yfinance.info."""
    result: dict[str, dict] = {t: {} for t in tickers}
    cache_hits: set[str] = set()

    # 1. Check fundamental_cache (30-day window)
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            placeholders = ",".join("?" for _ in tickers)
            async with db.execute(
                f"SELECT symbol, raw_json FROM fundamental_cache "
                f"WHERE symbol IN ({placeholders}) AND date >= date('now','-30 days') "
                f"ORDER BY date DESC",
                tickers,
            ) as cur:
                seen: set[str] = set()
                async for row in cur:
                    sym, raw_text = row
                    if sym not in seen and raw_text:
                        seen.add(sym)
                        cache_hits.add(sym)
                        raw = json.loads(raw_text)
                        fh = raw.get("finnhub") or {}
                        result[sym] = {
                            "revenue_growth": fh.get("revenue_growth_yoy"),
                            "net_margin":     fh.get("net_margin_ttm"),
                            "eps_growth":     fh.get("eps_growth_yoy"),
                            "roa":            fh.get("roa_ttm"),
                            "roe":            fh.get("roe_ttm"),
                            "pe_ttm":         fh.get("pe_ttm"),
                            "source":         "cache",
                        }
    except Exception as e:
        logger.warning("fundamental cache batch read failed: %s", e)

    # 2. yfinance .info for cache misses — parallel threads
    misses = [t for t in tickers if t not in cache_hits]
    if misses:
        def _one(sym: str) -> tuple[str, dict]:
            try:
                info = yf.Ticker(sym).info
                def _pct(v):
                    return round(float(v) * 100, 1) if v is not None else None
                return sym, {
                    "revenue_growth": _pct(info.get("revenueGrowth")),
                    "net_margin":     _pct(info.get("profitMargins")),
                    "eps_growth":     _pct(info.get("earningsGrowth")),
                    "debt_equity":    info.get("debtToEquity"),
                    "trailing_pe":    info.get("trailingPE"),
                    "forward_pe":     info.get("forwardPE"),
                    "source":         "yfinance_info",
                }
            except Exception:
                return sym, {}

        def _batch(syms: list[str]) -> dict[str, dict]:
            out: dict[str, dict] = {}
            with ThreadPoolExecutor(max_workers=min(12, len(syms))) as ex:
                futures = {ex.submit(_one, s): s for s in syms}
                try:
                    for f in as_completed(futures, timeout=30):
                        try:
                            sym, data = f.result(timeout=20)
                        except Exception:
                            sym = futures[f]
                            data = {}
                        out[sym] = data
                except TimeoutError:
                    for f, sym in futures.items():
                        if sym not in out:
                            out[sym] = {}
            return out

        yf_data = await asyncio.to_thread(_batch, misses)
        for sym, data in yf_data.items():
            result[sym] = data

    logger.info("fundamentals: %d cache hits, %d yfinance fetches", len(cache_hits), len(misses))
    return result


def _score_fundamental(fdata: dict) -> dict:
    """Score fundamental quality 0–30 pts from available data."""
    rev_growth = fdata.get("revenue_growth")  # already in %
    net_margin = fdata.get("net_margin")
    eps_growth = fdata.get("eps_growth")

    # Revenue growth: 0-12
    if rev_growth is None:
        rev_pts = 0
    elif rev_growth >= 20: rev_pts = 12
    elif rev_growth >= 10: rev_pts = 9
    elif rev_growth >= 5:  rev_pts = 6
    elif rev_growth >= 0:  rev_pts = 3
    else:                  rev_pts = 0  # declining revenue hurts

    # Net margin quality: 0-10
    if net_margin is None:
        margin_pts = 0
    elif net_margin >= 20: margin_pts = 10
    elif net_margin >= 10: margin_pts = 7
    elif net_margin >= 5:  margin_pts = 4
    elif net_margin >= 0:  margin_pts = 2
    else:                  margin_pts = 0  # unprofitable

    # EPS / earnings growth: 0-8
    if eps_growth is None:
        eps_pts = 0
    elif eps_growth >= 20: eps_pts = 8
    elif eps_growth >= 10: eps_pts = 6
    elif eps_growth >= 0:  eps_pts = 3
    else:                  eps_pts = 0

    total = rev_pts + margin_pts + eps_pts
    has_data = any(v is not None for v in [rev_growth, net_margin, eps_growth])

    return {
        "total":          total,
        "revenue_pts":    rev_pts,
        "margin_pts":     margin_pts,
        "eps_pts":        eps_pts,
        "has_data":       has_data,
        "revenue_growth": rev_growth,
        "net_margin":     net_margin,
        "eps_growth":     eps_growth,
        "roa":            fdata.get("roa"),
        "roe":            fdata.get("roe"),
        "pe_ttm":         fdata.get("pe_ttm"),
        "debt_equity":    fdata.get("debt_equity"),
        "source":         fdata.get("source", "none"),
    }


# ── Step 5: V3 Scorer ─────────────────────────────────────────────────────────

def _score_technical(ind: dict, spy_10d: float, sector_10d: float,
                     regime: str, is_momentum_setup: bool) -> dict:
    """Technical sub-score 0–89 (same logic as V2, used as 70% weight in V3)."""
    r10 = ind["return_10d"]
    raw_mom = 25 if r10 >= 8 else 20 if r10 >= 5 else 15 if r10 >= 3 else 8 if r10 >= 1 else 3
    regime_mult = 1.0 if regime == "BULL" else 0.85 if regime == "CHOP" else 0.65
    if regime == "BEAR" and is_momentum_setup and not ind["rsi_recovering"]:
        regime_mult = 0.50
    momentum = int(raw_mom * regime_mult)

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
    s_mult = _sector_multiplier(sector_10d, spy_10d)
    setup  = int(raw_setup * s_mult)

    rel = ind["return_10d"] - spy_10d
    market = 15 if rel >= 5 else 11 if rel >= 2 else 7 if rel >= 0 else 3 if rel >= -3 else 0

    conviction = 10 if ind["adx"] >= 30 else 7 if ind["adx"] >= 20 else 3

    penalty = 0
    if ind["adx"] < 20:                                  penalty -= 3
    if ind["return_3d"] > 10:                            penalty -= 4
    if ind["vol_ratio"] < 1.5 and ind["above_upper_bb"]: penalty -= 3
    regime_pen = -5 if (regime == "BEAR" and is_momentum_setup and not ind["rsi_recovering"]) else 0
    penalty += regime_pen

    tech_raw = max(0, min(100, momentum + volume + setup + market + conviction + penalty))
    return {
        "momentum":       momentum,
        "volume":         volume,
        "setup":          setup,
        "market":         market,
        "conviction":     conviction,
        "penalty":        penalty,
        "regime_penalty": regime_pen,
        "tech_raw":       tech_raw,
    }


def _score_v3(ind: dict, spy_10d: float, sector_10d: float,
              regime: str, is_momentum_setup: bool,
              fund_score: dict) -> dict:
    """V3 score = technical (70%) + fundamental quality (30%, max 30 pts)."""
    tech = _score_technical(ind, spy_10d, sector_10d, regime, is_momentum_setup)
    tech_component  = round(tech["tech_raw"] * 0.70)
    fund_component  = fund_score["total"]   # 0–30
    total = min(100, tech_component + fund_component)
    return {
        **tech,
        "tech_component":  tech_component,
        "fund_component":  fund_component,
        "fundamental":     fund_score,
        "total":           total,
    }


def _threshold_for_regime(regime: str) -> int:
    return 85 if regime == "CHOP" else 80


# ── Step 6: V3 LLM Explainer ──────────────────────────────────────────────────

async def _call_llm(candidates: list[dict], regime: str) -> dict:
    import anthropic
    key = os.getenv("ANTHROPIC_API_KEY", "")
    client = anthropic.AsyncAnthropic(api_key=key)

    prompt = f"""You are the intelligence layer of a professional-grade AI equity discovery system.

MARKET REGIME: {regime}

OBJECTIVE: Identify the highest-quality LONG opportunity — not merely the hottest stock.
You think like a disciplined institutional analyst, not a retail momentum chaser.

CANDIDATES (pre-scored, V3 blended technical + fundamental):
{json.dumps(candidates, indent=2)}

EVALUATION FRAMEWORK — assess every candidate across all 6 dimensions:

1. TECHNICAL QUALITY — Is trend healthy or overextended? Is momentum accelerating or fading?
   Volume confirming? Early-stage or late-stage? Avoid vertical blowoffs, weak-volume breakouts.

2. FUNDAMENTAL VALIDATION — Does business quality support the technical move?
   Prefer: revenue growth + margin stability + positive FCF + manageable debt.
   Avoid: deteriorating margins, no cash generation, momentum disconnected from business quality.

3. REGIME ALIGNMENT — Does the setup fit {regime}?
   BULL = momentum preferred. CHOP = quality + conviction required. BEAR = reversals with confirmation only.

4. RISK vs REWARD — Is upside asymmetry attractive? Is setup crowded or exhausted?
   Identify: invalidation levels, momentum exhaustion risk, event risk, sector rotation risk.

5. NARRATIVE DURABILITY — Is there a durable reason this move can continue?
   Prefer: improving fundamentals, sector tailwinds, earnings revisions, institutional accumulation.
   Avoid: narrative-less spikes, social-media pumps, isolated one-day squeezes.

6. LONG-HORIZON SUITABILITY — Optimised for 2–12 week holds, not day trades.
   Prefer: repeatable trend behaviour, controlled volatility, sustained institutional participation.

RULES:
- ALWAYS select a stock_of_the_day — never null
- Tier: score ≥80 = "Stock of the Day" | 65–79 = "Watchlist Candidate" | <65 = "Best Available"
- conviction_level: "HIGH" only if strong technicals AND fundamental support both present
- trade_quality: "A" = high conviction + good fundamentals | "B" = one dimension weak | "C" = speculative
- Cite ACTUAL metric values — never invent data not in the input
- DO NOT use hype language. Use: "data indicates", "metrics show", "scores suggest"

Return ONLY valid JSON (no markdown fences):
{{
  "stock_of_the_day": {{
    "ticker": "...",
    "company_name": "...",
    "confidence_score": 0-100,
    "tier": "Stock of the Day | Watchlist Candidate | Best Available",
    "signal_type": "breakout | reversal | continuation | momentum",
    "conviction_level": "HIGH | MODERATE | SPECULATIVE",
    "trade_quality": "A | B | C",
    "holding_horizon": "2-4 weeks | 4-8 weeks | 8-12 weeks",
    "summary": "2-3 sentences citing specific score components and metric values",
    "why_this_stock": ["reason citing specific metric or score", "..."],
    "technical_strengths": ["specific technical evidence", "..."],
    "fundamental_strengths": ["specific fundamental evidence, or 'Fundamental data unavailable — technical-only pick' if no data", "..."],
    "risk_factors": ["specific risk with data point", "..."],
    "regime_fit": "one sentence on how this setup fits or fights {regime}",
    "invalidation_conditions": ["specific condition with metric threshold", "..."],
    "ideal_entry_profile": "one sentence describing what a good entry looks like",
    "avoid_if": "one sentence on the key condition that makes this trade unattractive",
    "final_verdict": "one sentence institutional-style conclusion"
  }},
  "other_considered": [
    {{"ticker": "...", "score": 0, "reason_not_selected": "cite specific score/metric reason"}}
  ]
}}"""

    resp = await client.messages.create(
        model=HAIKU_MODEL,
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = resp.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())


def _build_llm_input(scored: list[dict]) -> list[dict]:
    if not scored:
        return []
    pool = sorted(scored, key=lambda x: -x["score"]["total"])
    high = [c for c in pool if c["score"]["total"] >= 65]
    candidates = high[:8] if high else pool[:1]
    if pool[0] not in candidates:
        candidates = [pool[0]] + candidates

    out = []
    for c in candidates[:8]:
        sc = c["score"]
        fd = sc.get("fundamental", {})
        out.append({
            "ticker":       c["ticker"],
            "company_name": c["company"],
            "sector":       c["sector"],
            "v3_score":     sc["total"],
            "score_breakdown": {
                "technical_component": sc.get("tech_component"),
                "fundamental_component": sc.get("fund_component"),
                "momentum":    sc.get("momentum"),
                "volume":      sc.get("volume"),
                "setup":       sc.get("setup"),
                "market":      sc.get("market"),
                "conviction":  sc.get("conviction"),
                "penalty":     sc.get("penalty"),
            },
            "tags": c["tags"],
            "technical_metrics": {
                "rsi":            c["ind"]["rsi"],
                "adx":            c["ind"]["adx"],
                "return_10d":     c["ind"]["return_10d"],
                "return_5d":      c["ind"]["return_5d"],
                "return_3d":      c["ind"]["return_3d"],
                "volume_ratio":   c["ind"]["vol_ratio"],
                "above_sma20":    c["ind"]["above_sma20"],
                "bb_squeeze":     c["ind"]["bb_squeeze"],
                "rsi_recovering": c["ind"]["rsi_recovering"],
            },
            "fundamental_metrics": {
                "revenue_growth_yoy": fd.get("revenue_growth"),
                "net_margin_ttm":     fd.get("net_margin"),
                "eps_growth_yoy":     fd.get("eps_growth"),
                "roa":                fd.get("roa"),
                "roe":                fd.get("roe"),
                "pe_ttm":             fd.get("pe_ttm"),
                "debt_equity":        fd.get("debt_equity"),
                "data_source":        fd.get("source", "none"),
                "fundamental_pts":    fd.get("total", 0),
            },
        })
    return out


# ── Main entry point ──────────────────────────────────────────────────────────

_pipeline_running = False


def reset_pipeline_lock() -> None:
    """Force-clear the pipeline running lock. Call from outer exception handlers."""
    global _pipeline_running
    _pipeline_running = False


async def run_sotd_pipeline(force_refresh: bool = False, emit=None) -> dict:
    """
    Run the full V2 SOTD pipeline.
    Returns cached result for today unless force_refresh=True.
    emit: optional async callable(dict) for streaming progress events.
    """
    async def _emit(event: dict):
        if emit:
            try:
                await emit(event)
            except Exception:
                pass

    today = date.today().isoformat()

    if not force_refresh:
        cached = await _get_cached_pick(today)
        if cached:
            logger.info("sotd_engine: returning cached pick for %s", today)
            await _emit({"step": "cached", "status": "done",
                         "msg": f"Returning cached result for {today}"})
            return cached

    global _pipeline_running
    if _pipeline_running:
        logger.warning("sotd_engine: pipeline already running — skipping duplicate for %s", today)
        return {"error": "Pipeline already running — try again shortly"}

    _pipeline_running = True
    logger.info("sotd_engine: running full V3 pipeline for %s", today)
    generated_at = datetime.now(UTC).isoformat()

    # Read active filter preset (falls back to agent_config if no preset active)
    from app.analysis.filter_presets import get_active_preset
    _preset = None
    try:
        _preset = await get_active_preset()
    except Exception:
        pass
    if _preset:
        min_price      = float(_preset.get("min_price", 10.0))
        min_avg_volume = int(_preset.get("min_avg_volume", 1_000_000))
        market_cap     = _preset.get("market_cap", "mid")
    else:
        import aiosqlite
        from app.config import DB_PATH
        _cfg: dict[str, str] = {}
        try:
            async with aiosqlite.connect(DB_PATH) as _db:
                async with _db.execute(
                    "SELECT key, value FROM agent_config WHERE key LIKE 'universe_%' OR key = 'sotd_conviction_threshold'"
                ) as _cur:
                    for _k, _v in await _cur.fetchall():
                        _cfg[_k] = _v
        except Exception:
            pass
        min_price      = float(_cfg.get("universe_min_price", "10.0"))
        min_avg_volume = int(float(_cfg.get("universe_min_avg_volume", "1000000")))
        market_cap     = _cfg.get("universe_min_market_cap", "mid")

    # Step 1: screener (no portfolio exclusion — all stocks considered)
    portfolio: set[str] = set()
    await _emit({"step": "screener", "status": "running",
                 "msg": f"Scanning FinViz (price>${min_price:.0f} · vol>{min_avg_volume//1000:.0f}K · cap>{market_cap})…"})
    try:
        candidates = await asyncio.to_thread(
            _fetch_candidates, portfolio, 40, min_price, min_avg_volume, market_cap
        )
    except Exception as e:
        logger.error("sotd_engine screener failed: %s", e)
        await _emit({"step": "screener", "status": "error", "msg": f"Screener failed: {e}"})
        result = _no_trade_result(today, generated_at, "Screener unavailable")
        await _cache_pick(today, None, result)
        _pipeline_running = False
        return result

    if not candidates:
        await _emit({"step": "screener", "status": "error", "msg": "Screener returned 0 candidates"})
        result = _no_trade_result(today, generated_at, "Screener returned no candidates")
        await _cache_pick(today, None, result)
        _pipeline_running = False
        return result

    await _emit({"step": "screener", "status": "done",
                 "msg": f"{len(candidates)} candidates passed filters",
                 "count": len(candidates)})

    # Step 2: market data
    tickers = [c["ticker"] for c in candidates]
    await _emit({"step": "market_data", "status": "running",
                 "msg": f"Downloading 60d OHLCV for {len(tickers) + 13} tickers (candidates + SPY + VIX + sectors)…"})
    try:
        mdata = await asyncio.to_thread(_fetch_market_data, tickers)
    except Exception as e:
        logger.error("sotd_engine market data failed: %s", e)
        await _emit({"step": "market_data", "status": "error", "msg": f"Market data failed: {e}"})
        result = _no_trade_result(today, generated_at, "Market data unavailable")
        await _cache_pick(today, None, result)
        _pipeline_running = False
        return result

    # Market context
    vix_df  = mdata.get("^VIX")
    spy_df  = mdata.get("SPY")
    vix_val = _scalar(vix_df["Close"].iloc[-1]) if vix_df is not None else 18.0
    spy_10d = ((_scalar(spy_df["Close"].iloc[-1]) / _scalar(spy_df["Close"].iloc[-11])) - 1) * 100 \
              if spy_df is not None and len(spy_df) >= 11 else 0.0
    spy_above_sma50 = False
    if spy_df is not None and len(spy_df) >= 50:
        sma50_val = _scalar(SMAIndicator(spy_df["Close"], window=50).sma_indicator().iloc[-1])
        spy_above_sma50 = bool(_scalar(spy_df["Close"].iloc[-1]) > sma50_val)

    sector_returns: dict[str, float] = {}
    for name, etf in SECTOR_ETF.items():
        df = mdata.get(etf)
        if df is not None and len(df) >= 11:
            sector_returns[name] = round(
                (_scalar(df["Close"].iloc[-1]) / _scalar(df["Close"].iloc[-11]) - 1) * 100, 2
            )
        else:
            sector_returns[name] = 0.0

    regime = _classify_regime(spy_df, vix_val) if spy_df is not None else "CHOP"
    threshold = _threshold_for_regime(regime)

    market_context = {
        "regime":          regime,
        "vix":             round(vix_val, 1),
        "spy_10d":         round(spy_10d, 2),
        "spy_above_sma50": spy_above_sma50,
        "sotd_threshold":  threshold,
        "sector_performance": sorted(
            [{"name": k, "etf": SECTOR_ETF[k], "return_10d": v}
             for k, v in sector_returns.items()],
            key=lambda x: -x["return_10d"],
        ),
    }

    await _emit({"step": "market_data", "status": "done",
                 "msg": f"Price data ready for {len(mdata)} tickers"})

    # Step 2b: fundamental batch fetch (cache-first, yfinance.info fallback)
    await _emit({"step": "indicators", "status": "running",
                 "msg": f"Fetching fundamentals + computing RSI · ADX · BB · Volume for {len(candidates)} candidates…"})
    fund_data = await _fetch_fundamental_batch(tickers)

    # Step 3–5: indicators, hard filters, V3 scoring
    scored:   list[dict] = []
    rejected: list[dict] = []

    for c in candidates:
        t  = c["ticker"]
        df = mdata.get(t)
        if df is None or len(df) < 20:
            rejected.append({"ticker": t, "reason": "insufficient price history"})
            continue

        try:
            ind = _compute_indicators(df)
        except Exception as e:
            rejected.append({"ticker": t, "reason": f"indicator error: {e}"})
            continue
        ok, reason = _apply_hard_filters(ind)
        if not ok:
            rejected.append({"ticker": t, "reason": reason})
            continue

        sec_10d     = sector_returns.get(c["sector"], 0.0)
        is_momentum = not ind["rsi_recovering"]
        fund_score  = _score_fundamental(fund_data.get(t, {}))
        sc          = _score_v3(ind, spy_10d, sec_10d, regime, is_momentum, fund_score)

        tags = (
            (["breakout"]         if ind["bb_squeeze"] and ind["above_upper_bb"] else []) +
            (["reversal"]         if ind["rsi_recovering"] else []) +
            (["volume_confirmed"] if ind["vol_ratio"] >= 1.5 else []) +
            (["above_sma20"]      if ind["above_sma20"] else [])
        )
        scored.append({**c, "ind": ind, "score": sc, "tags": tags})

    scored.sort(key=lambda x: -x["score"]["total"])
    top = scored[0] if scored else None
    await _emit({"step": "indicators", "status": "done",
                 "msg": f"{len(scored)} passed filters, {len(rejected)} rejected"})
    if top:
        fd = top["score"].get("fundamental", {})
        fund_note = f" | Fund: {fd.get('total', 0)}/30 pts" if fd.get("has_data") else " | Fund: no data"
        await _emit({"step": "scoring", "status": "done",
                     "msg": f"V3 top: {top['ticker']} {top['score']['total']} pts (tech {top['score'].get('tech_component')} + fund {top['score'].get('fund_component')}){fund_note} | {regime}",
                     "top_ticker": top["ticker"], "top_score": top["score"]["total"]})

    # Suppress repeat pick: if the #1 scorer was also yesterday's pick, log and exclude it
    repeat_suppressed: dict | None = None
    prev_ticker = await _get_prev_pick()
    scored_for_llm = scored
    if prev_ticker and scored and scored[0]["ticker"] == prev_ticker:
        suppressed = scored[0]
        repeat_suppressed = {
            "ticker": suppressed["ticker"],
            "score":  suppressed["score"]["total"],
            "reason": f"Already picked on the previous session — showing next best pick",
        }
        await _log_repeat_hit(suppressed["ticker"], suppressed["score"]["total"], today)
        scored_for_llm = scored[1:]  # drop the #1, pass the rest to LLM
        await _emit({"step": "scoring", "status": "done",
                     "msg": f"Repeat suppressed: {suppressed['ticker']} — expanding to next best candidate"})

    llm_input = _build_llm_input(scored_for_llm)
    if not llm_input:
        await _emit({"step": "llm", "status": "error",
                     "msg": "All candidates failed hard filters — nothing to rank"})
        result = _no_trade_result(today, generated_at, "All candidates failed hard filters",
                                  market_context=market_context)
        await _cache_pick(today, None, result)
        _pipeline_running = False
        return result

    n_candidates = len(llm_input)
    await _emit({"step": "llm", "status": "running",
                 "msg": f"Haiku analyzing top {n_candidates} candidates, generating rationale…"})
    try:
        llm_result = await _call_llm(llm_input, regime)
    except Exception as e:
        logger.error("sotd_engine LLM call failed: %s", e)
        await _emit({"step": "llm", "status": "error", "msg": f"LLM call failed: {e}"})
        result = _no_trade_result(today, generated_at, f"LLM unavailable: {e}",
                                  market_context=market_context)
        await _cache_pick(today, None, result)
        _pipeline_running = False
        return result

    # Merge LLM output with market context and full candidate list
    sotd_ticker = None
    if llm_result.get("stock_of_the_day"):
        sotd_ticker = llm_result["stock_of_the_day"].get("ticker")
        match = next((s for s in scored if s["ticker"] == sotd_ticker), None)
        if match:
            fd = match["score"].get("fundamental", {})
            llm_result["stock_of_the_day"]["sector"]          = match["sector"]
            llm_result["stock_of_the_day"]["score_breakdown"] = match["score"]
            llm_result["stock_of_the_day"]["metrics"] = {
                k: match["ind"][k]
                for k in ["price", "rsi", "adx", "vol_ratio", "return_10d",
                          "return_5d", "return_3d", "above_sma20", "bb_squeeze"]
            }
            llm_result["stock_of_the_day"]["fundamental_data"] = {
                "revenue_growth": fd.get("revenue_growth"),
                "net_margin":     fd.get("net_margin"),
                "eps_growth":     fd.get("eps_growth"),
                "roa":            fd.get("roa"),
                "roe":            fd.get("roe"),
                "pe_ttm":         fd.get("pe_ttm"),
                "fund_score":     fd.get("total", 0),
                "has_data":       fd.get("has_data", False),
                "source":         fd.get("source", "none"),
            }

    # Build full candidates list for UI
    all_candidates = []
    for s in scored:
        fd = s["score"].get("fundamental", {})
        all_candidates.append({
            "ticker":          s["ticker"],
            "company":         s["company"],
            "sector":          s["sector"],
            "score":           s["score"]["total"],
            "score_breakdown": s["score"],
            "tags":            s["tags"],
            "metrics":         {k: s["ind"][k] for k in ["rsi", "adx", "vol_ratio",
                                                           "return_10d", "above_sma20",
                                                           "bb_squeeze", "rsi_recovering"]},
            "fundamental": {
                "revenue_growth": fd.get("revenue_growth"),
                "net_margin":     fd.get("net_margin"),
                "fund_score":     fd.get("total", 0),
                "has_data":       fd.get("has_data", False),
            },
            "passed_filter":   True,
        })
    for r in rejected:
        all_candidates.append({
            "ticker":        r["ticker"],
            "passed_filter": False,
            "filter_reason": r["reason"],
        })

    conviction_threshold = int(_preset.get("conviction_threshold", 65)) if _preset else int(_cfg.get("sotd_conviction_threshold", "65"))
    full_result = {
        "generated_at":          generated_at,
        "pick_date":             today,
        "no_trade_day":          False,
        "market_context":        market_context,
        "stock_of_the_day":      llm_result.get("stock_of_the_day"),
        "other_considered":      llm_result.get("other_considered", []),
        "all_candidates":        all_candidates,
        "conviction_threshold":  conviction_threshold,
        "repeat_suppressed":     repeat_suppressed,
        "universe_filters": {
            "min_price":      min_price,
            "min_avg_volume": min_avg_volume,
            "market_cap":     market_cap,
        },
    }

    await _cache_pick(today, sotd_ticker, full_result)

    # Record signal event for outcome tracking
    if sotd_ticker and not full_result.get("no_trade_day"):
        sotd_data = full_result.get("stock_of_the_day", {})
        try:
            from app.performance.signal_event_tracker import record_signal_event
            await record_signal_event(
                pick_date=today,
                ticker=sotd_ticker,
                confidence_score=sotd_data.get("confidence_score", 0),
                tier=sotd_data.get("tier", ""),
                signal_type=sotd_data.get("signal_type", ""),
                regime=regime,
            )
        except Exception as e:
            logger.warning("signal event recording failed: %s", e)

    sotd_data = full_result.get("stock_of_the_day") or {}
    await _emit({"step": "llm", "status": "done",
                 "msg": f"{sotd_data.get('tier', 'Pick')}: {sotd_ticker} (score {sotd_data.get('confidence_score', '?')})"})

    logger.info("sotd_engine: pick=%s score=%s regime=%s",
                sotd_ticker,
                sotd_data.get("confidence_score"),
                regime)
    _pipeline_running = False
    return full_result


async def run_sotd_for_ticker(ticker: str, emit=None) -> dict:
    """Run the full SOTD analysis for a single specific ticker (bypasses FinViz screener)."""
    async def _emit(event: dict):
        if emit:
            try:
                await emit(event)
            except Exception:
                pass

    ticker = ticker.upper().strip()
    generated_at = datetime.now(UTC).isoformat()
    today = date.today().isoformat()

    await _emit({"step": "screener", "status": "running", "msg": f"Looking up {ticker}…"})

    def _get_info():
        try:
            info = yf.Ticker(ticker).info
            return {"sector": info.get("sector", "Unknown"), "company": info.get("longName", ticker)}
        except Exception:
            return {"sector": "Unknown", "company": ticker}

    info = await asyncio.to_thread(_get_info)
    await _emit({"step": "screener", "status": "done", "msg": f"{ticker} · {info['sector']}", "count": 1})

    await _emit({"step": "market_data", "status": "running",
                 "msg": f"Downloading 60d OHLCV for {ticker} + SPY + VIX + 11 sectors…"})
    try:
        mdata = await asyncio.to_thread(_fetch_market_data, [ticker])
    except Exception as e:
        await _emit({"step": "market_data", "status": "error", "msg": f"Market data failed: {e}"})
        return _no_trade_result(today, generated_at, f"Market data unavailable: {e}")

    vix_df  = mdata.get("^VIX")
    spy_df  = mdata.get("SPY")
    vix_val = _scalar(vix_df["Close"].iloc[-1]) if vix_df is not None else 18.0
    spy_10d = ((_scalar(spy_df["Close"].iloc[-1]) / _scalar(spy_df["Close"].iloc[-11])) - 1) * 100 \
              if spy_df is not None and len(spy_df) >= 11 else 0.0
    spy_above_sma50 = False
    if spy_df is not None and len(spy_df) >= 50:
        sma50_val = _scalar(SMAIndicator(spy_df["Close"], window=50).sma_indicator().iloc[-1])
        spy_above_sma50 = bool(_scalar(spy_df["Close"].iloc[-1]) > sma50_val)

    sector_returns: dict[str, float] = {}
    for name, etf in SECTOR_ETF.items():
        df = mdata.get(etf)
        if df is not None and len(df) >= 11:
            sector_returns[name] = round(
                (_scalar(df["Close"].iloc[-1]) / _scalar(df["Close"].iloc[-11]) - 1) * 100, 2
            )

    regime = _classify_regime(spy_df, vix_val) if spy_df is not None else "CHOP"
    market_context = {
        "regime":          regime,
        "vix":             round(vix_val, 1),
        "spy_10d":         round(spy_10d, 2),
        "spy_above_sma50": spy_above_sma50,
        "sotd_threshold":  _threshold_for_regime(regime),
        "sector_performance": sorted(
            [{"name": k, "etf": SECTOR_ETF[k], "return_10d": v} for k, v in sector_returns.items()],
            key=lambda x: -x["return_10d"],
        ),
    }
    await _emit({"step": "market_data", "status": "done", "msg": "Price data ready"})

    await _emit({"step": "indicators", "status": "running",
                 "msg": f"Fetching fundamentals + computing RSI · ADX · BB · Volume for {ticker}…"})

    fund_data = await _fetch_fundamental_batch([ticker])
    df = mdata.get(ticker)
    if df is None or len(df) < 20:
        await _emit({"step": "indicators", "status": "error", "msg": f"Insufficient price history for {ticker}"})
        return _no_trade_result(today, generated_at, f"Insufficient history for {ticker}", market_context=market_context)

    try:
        ind = _compute_indicators(df)
    except Exception as e:
        await _emit({"step": "indicators", "status": "error", "msg": f"Indicator error: {e}"})
        return _no_trade_result(today, generated_at, str(e), market_context=market_context)

    sec_10d    = sector_returns.get(info["sector"], 0.0)
    fund_score = _score_fundamental(fund_data.get(ticker, {}))
    sc         = _score_v3(ind, spy_10d, sec_10d, regime, not ind["rsi_recovering"], fund_score)
    tags = (
        (["breakout"]         if ind["bb_squeeze"] and ind.get("above_upper_bb") else []) +
        (["reversal"]         if ind["rsi_recovering"] else []) +
        (["volume_confirmed"] if ind["vol_ratio"] >= 1.5 else []) +
        (["above_sma20"]      if ind["above_sma20"] else [])
    )
    c = {"ticker": ticker, "sector": info["sector"], "company": info["company"]}
    scored_entry = {**c, "ind": ind, "score": sc, "tags": tags}

    fd = sc.get("fundamental", {})
    fund_note = f" | Fund: {fd.get('total', 0)}/30 pts" if fd.get("has_data") else " | Fund: no data"
    await _emit({"step": "scoring", "status": "done",
                 "msg": f"{ticker}: {sc['total']} pts (tech {sc.get('tech_component')} + fund {sc.get('fund_component')}){fund_note} | {regime}",
                 "top_ticker": ticker, "top_score": sc["total"]})
    await _emit({"step": "indicators", "status": "done", "msg": "1 ticker scored"})

    llm_input = _build_llm_input([scored_entry])
    await _emit({"step": "llm", "status": "running", "msg": f"Haiku generating full analysis for {ticker}…"})
    try:
        llm_result = await _call_llm(llm_input, regime)
    except Exception as e:
        logger.error("run_sotd_for_ticker LLM failed: %s", e)
        await _emit({"step": "llm", "status": "error", "msg": f"LLM failed: {e}"})
        return _no_trade_result(today, generated_at, f"LLM unavailable: {e}", market_context=market_context)

    if llm_result.get("stock_of_the_day"):
        fd = sc.get("fundamental", {})
        llm_result["stock_of_the_day"]["sector"]          = info["sector"]
        llm_result["stock_of_the_day"]["score_breakdown"] = sc
        llm_result["stock_of_the_day"]["metrics"] = {
            k: ind[k] for k in ["price", "rsi", "adx", "vol_ratio", "return_10d",
                                 "return_5d", "return_3d", "above_sma20", "bb_squeeze"]
        }
        llm_result["stock_of_the_day"]["fundamental_data"] = {
            "revenue_growth": fd.get("revenue_growth"), "net_margin": fd.get("net_margin"),
            "eps_growth": fd.get("eps_growth"), "roa": fd.get("roa"), "roe": fd.get("roe"),
            "pe_ttm": fd.get("pe_ttm"), "fund_score": fd.get("total", 0),
            "has_data": fd.get("has_data", False), "source": fd.get("source", "none"),
        }

    sotd_data = llm_result.get("stock_of_the_day") or {}
    await _emit({"step": "llm", "status": "done",
                 "msg": f"{sotd_data.get('tier', 'Analysis')}: {ticker} (score {sotd_data.get('confidence_score', sc['total'])})"})

    all_candidates = [{
        "ticker": ticker, "company": info["company"], "sector": info["sector"],
        "score": sc["total"], "score_breakdown": sc, "tags": tags,
        "metrics": {k: ind[k] for k in ["rsi", "adx", "vol_ratio", "return_10d",
                                          "above_sma20", "bb_squeeze", "rsi_recovering"]},
        "fundamental": {"revenue_growth": fd.get("revenue_growth"), "net_margin": fd.get("net_margin"),
                        "fund_score": fd.get("total", 0), "has_data": fd.get("has_data", False)},
        "passed_filter": True,
    }]

    return {
        "generated_at":        generated_at,
        "pick_date":           today,
        "no_trade_day":        False,
        "market_context":      market_context,
        "stock_of_the_day":    llm_result.get("stock_of_the_day"),
        "other_considered":    llm_result.get("other_considered", []),
        "all_candidates":      all_candidates,
        "conviction_threshold": 65,
        "_ticker_review_mode": True,
        "_reviewed_ticker":    ticker,
    }


def _no_trade_result(pick_date: str, generated_at: str, reason: str,
                     market_context: dict | None = None) -> dict:
    return {
        "generated_at":     generated_at,
        "pick_date":        pick_date,
        "no_trade_day":     True,
        "no_trade_reason":  reason,
        "market_context":   market_context or {},
        "stock_of_the_day": None,
        "other_considered": [],
        "all_candidates":   [],
    }
