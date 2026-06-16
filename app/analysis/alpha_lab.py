"""Alpha Lab — Breakout Intelligence Engine (leaderboard, radar, DNA, thesis)."""
import asyncio
import json
import logging
import os
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, UTC
from typing import Optional

import aiosqlite
import pandas as pd
import yfinance as yf
from ta.momentum import RSIIndicator
from ta.volatility import BollingerBands
from ta.trend import SMAIndicator

from app.config import DB_PATH

logger = logging.getLogger(__name__)

# ── Universe ──────────────────────────────────────────────────────────────────

UNIVERSE = [
    # Technology / AI / Semiconductors
    "AAPL","MSFT","NVDA","GOOGL","META","AMZN","TSLA","AMD","INTC","QCOM",
    "AVGO","MU","AMAT","LRCX","KLAC","MRVL","TXN","ADI","SNPS","CDNS",
    "ORCL","CRM","NOW","ADBE","INTU","PANW","CRWD","ZS","FTNT",
    "SMCI","NET","DDOG","SNOW","PLTR","ANET","CSCO","DELL","HPE",
    # Optical / Networking
    "CIEN","LITE","IIVI","COHR","AAOI",
    # Semi Equipment
    "TER","ONTO","FORM","ACMR",
    # Storage
    "WDC","STX","NTAP","SNDK",
    # Healthcare / Biotech
    "MRNA","BNTX","PFE","JNJ","ABBV","LLY","MRK","BMY","GILD","AMGN",
    "REGN","VRTX","BIIB","ALNY",
    # Energy
    "XOM","CVX","COP","EOG","SLB","HAL","BKR","VLO","PSX","MPC",
    # Agriculture
    "CF","MOS","NTR",
    # Nuclear / Power
    "CEG","VST","NNE","SMR","OKLO","BWX",
    # Industrials / Infrastructure / Datacenter
    "FIX","PWR","MTZ","VRT","EMR","ROK","GE","HON","RTX","LMT","NOC","BA",
    # Materials
    "GLW","APD","LIN","SHW","FCX","NEM",
    # Financials
    "JPM","BAC","GS","MS","BLK","SCHW","V","MA",
    # Consumer
    "WMT","COST","HD","MCD","NKE",
    # Telecom / Media
    "T","VZ","CMCSA","DIS","NFLX","SPOT",
    # Utilities
    "NEE","DUK","SO","AEP","EXC",
    # Real Estate / Data Centers
    "AMT","PLD","EQIX",
]

SECTOR_THEME = {
    "Technology":             "Tech / AI",
    "Communication Services": "Tech / AI",
    "Health Care":            "Healthcare / Biotech",
    "Energy":                 "Energy",
    "Utilities":              "Power / Nuclear",
    "Industrials":            "Infrastructure",
    "Materials":              "Commodities",
    "Consumer Discretionary": "Consumer",
    "Consumer Staples":       "Consumer Staples",
    "Financials":             "Financials",
    "Real Estate":            "Real Estate",
}

PERIOD_LABELS = {
    "ytd": "YTD", "q1": "Q1", "q2": "Q2", "q3": "Q3", "q4": "Q4",
    "30d": "30 Days", "90d": "90 Days",
}

def _period_start(period: str) -> date:
    today = date.today()
    y = today.year
    return {
        "ytd": date(y, 1, 1), "q1": date(y, 1, 1),
        "q2":  date(y, 4, 1), "q3": date(y, 7, 1),
        "q4":  date(y, 10, 1),
        "30d": today - timedelta(days=30),
        "90d": today - timedelta(days=90),
    }.get(period, date(y, 1, 1))


# ── Indicators ────────────────────────────────────────────────────────────────

def _scalar(val) -> float:
    try:
        v = val.item() if hasattr(val, "item") else float(val)
        return 0.0 if v != v else v
    except Exception:
        return 0.0


def _lab_indicators(df: pd.DataFrame) -> dict | None:
    """Extended indicators for Alpha Lab radar matching."""
    if df is None or len(df) < 20:
        return None
    try:
        close  = df["Close"].squeeze()
        volume = df["Volume"].squeeze()

        p_now = _scalar(close.iloc[-1])
        p_10d = _scalar(close.iloc[-11]) if len(df) >= 11 else p_now
        p_20d = _scalar(close.iloc[-21]) if len(df) >= 21 else p_now
        if p_now <= 0:
            return None

        rsi   = _scalar(RSIIndicator(close, 14).rsi().iloc[-1])
        sma20 = SMAIndicator(close, 20).sma_indicator()
        bb    = BollingerBands(close, 20, 2)

        bb_h     = _scalar(bb.bollinger_hband().iloc[-1])
        bb_l     = _scalar(bb.bollinger_lband().iloc[-1])
        bb_width = (bb_h - bb_l) / p_now if p_now > 0 else 0.1

        vol_recent = _scalar(volume.iloc[-10:].mean()) if len(volume) >= 10 else 0
        vol_prior  = _scalar(volume.iloc[-30:-10].mean()) if len(volume) >= 30 else vol_recent
        vol_trend  = vol_recent / vol_prior if vol_prior > 0 else 1.0
        vol_ratio  = _scalar(volume.iloc[-1]) / (_scalar(volume.iloc[-21:-1].mean()) or 1)

        above_sma20 = p_now > _scalar(sma20.iloc[-1])
        ret_10d = (p_now / p_10d - 1) * 100 if p_10d > 0 else 0
        ret_20d = (p_now / p_20d - 1) * 100 if p_20d > 0 else 0

        p52h = _scalar(close.max())
        p52l = _scalar(close.min())
        range_pct = (p_now - p52l) / (p52h - p52l) if p52h > p52l else 0.5

        return {
            "price":       round(p_now, 2),
            "rsi":         round(rsi, 1),
            "bb_width":    round(bb_width, 4),
            "bb_squeeze":  bool(bb_width < 0.08),
            "vol_trend":   round(vol_trend, 2),
            "vol_ratio":   round(vol_ratio, 2),
            "above_sma20": bool(above_sma20),
            "return_10d":  round(ret_10d, 2),
            "return_20d":  round(ret_20d, 2),
            "range_pct":   round(range_pct, 2),
        }
    except Exception:
        return None


# ── In-memory cache ───────────────────────────────────────────────────────────

_cache: dict[str, tuple[float, dict]] = {}  # key → (timestamp, data)
_CACHE_TTL = 3600  # 1 hour

def _cache_get(key: str) -> dict | None:
    if key in _cache:
        ts, data = _cache[key]
        if time.time() - ts < _CACHE_TTL:
            return data
    return None

def _cache_set(key: str, data: dict):
    _cache[key] = (time.time(), data)


# ── Leaderboard ───────────────────────────────────────────────────────────────

async def compute_leaderboard(period: str = "ytd", limit: int = 20) -> dict:
    cache_key = f"leaderboard:{period}:{limit}"
    cached = _cache_get(cache_key)
    if cached:
        return {**cached, "_cached": True}

    start   = _period_start(period)
    today   = date.today()
    tickers = UNIVERSE

    def _download():
        warnings.filterwarnings("ignore")
        return yf.download(
            tickers,
            start=str(start - timedelta(days=5)),
            end=str(today + timedelta(days=1)),
            auto_adjust=True, progress=False,
        )

    raw = await asyncio.to_thread(_download)
    if raw.empty:
        return {"error": "Download failed", "gainers": [], "losers": []}

    if isinstance(raw.columns, pd.MultiIndex):
        closes = raw["Close"] if "Close" in raw.columns.get_level_values(0) \
                 else raw.xs("Close", axis=1, level=1)
    else:
        closes = raw

    results = []
    start_ts = pd.Timestamp(start)
    for ticker in closes.columns:
        s = closes[ticker].dropna()
        if len(s) < 3:
            continue
        after = s[s.index >= start_ts]
        if after.empty:
            continue
        p0, p1 = float(after.iloc[0]), float(s.iloc[-1])
        if p0 <= 0:
            continue
        results.append({
            "ticker": str(ticker),
            "gain_pct": round((p1 - p0) / p0 * 100, 2),
            "start_price": round(p0, 2),
            "current_price": round(p1, 2),
        })

    results.sort(key=lambda x: -x["gain_pct"])
    gainers = results[:limit]
    losers  = sorted(results, key=lambda x: x["gain_pct"])[:10]
    watch   = [r for r in results if -5 <= r["gain_pct"] <= 10][:15]

    top_tickers = list({x["ticker"] for x in gainers + losers + watch})

    def _get_info(t):
        try:
            info = yf.Ticker(t).info
            return t, {"company": info.get("longName", t), "sector": info.get("sector", "Unknown")}
        except Exception:
            return t, {"company": t, "sector": "Unknown"}

    with ThreadPoolExecutor(max_workers=8) as ex:
        infos = dict(ex.map(_get_info, top_tickers))

    for r in gainers + losers + watch:
        t = r["ticker"]
        inf = infos.get(t, {"company": t, "sector": "Unknown"})
        r["company"]   = inf["company"]
        r["sector"]    = inf["sector"]
        r["theme_tag"] = SECTOR_THEME.get(inf["sector"], "Other")
        r["radar_flag"] = None

    result = {
        "period": period,
        "period_label": PERIOD_LABELS.get(period, period.upper()),
        "start_date": str(start),
        "gainers": gainers,
        "losers":  losers,
        "watch":   watch,
        "total_computed": len(results),
    }
    _cache_set(cache_key, result)
    return result


# ── Radar ─────────────────────────────────────────────────────────────────────

def _radar_score(candidate: dict, reference: dict) -> tuple[int, list[dict]]:
    """Score how well candidate's current state matches reference's period-start state."""
    signals = []
    score = 0

    # RSI match (ideal: within ±8 of reference)
    rsi_diff = abs(candidate["rsi"] - reference["rsi"])
    if rsi_diff <= 5:
        score += 25
        signals.append({"key": "RSI", "match": True,
                         "label": f"RSI {candidate['rsi']:.0f} ≈ ref {reference['rsi']:.0f}"})
    elif rsi_diff <= 12:
        score += 12
        signals.append({"key": "RSI", "match": "partial",
                         "label": f"RSI {candidate['rsi']:.0f} near ref {reference['rsi']:.0f}"})
    else:
        signals.append({"key": "RSI", "match": False,
                         "label": f"RSI {candidate['rsi']:.0f} ≠ ref {reference['rsi']:.0f}"})

    # Bollinger Band compression (candidate at least as compressed as reference)
    ref_bb = reference["bb_width"]
    cnd_bb = candidate["bb_width"]
    if cnd_bb <= ref_bb * 1.2:
        score += 25
        signals.append({"key": "BB", "match": True,
                         "label": f"BB width {cnd_bb:.3f} ≤ ref {ref_bb:.3f} (compressed)"})
    elif cnd_bb <= ref_bb * 1.6:
        score += 10
        signals.append({"key": "BB", "match": "partial",
                         "label": f"BB width {cnd_bb:.3f} near ref {ref_bb:.3f}"})
    else:
        signals.append({"key": "BB", "match": False,
                         "label": f"BB width {cnd_bb:.3f} — not compressed"})

    # Volume accumulation (volume rising while price is flat = institutional accumulation)
    if candidate["vol_trend"] >= 1.15 and abs(candidate["return_20d"]) < 8:
        score += 20
        signals.append({"key": "Vol", "match": True,
                         "label": f"Vol +{(candidate['vol_trend']-1)*100:.0f}% while price flat — accumulation signal"})
    elif candidate["vol_trend"] >= 1.0:
        score += 8
        signals.append({"key": "Vol", "match": "partial",
                         "label": f"Vol trend flat"})
    else:
        signals.append({"key": "Vol", "match": False,
                         "label": f"Vol declining"})

    # SMA20 position matches reference
    if candidate["above_sma20"] == reference["above_sma20"]:
        score += 15
        pos = "above" if candidate["above_sma20"] else "below"
        signals.append({"key": "SMA", "match": True,
                         "label": f"Price {pos} SMA20 — matches ref"})
    else:
        signals.append({"key": "SMA", "match": False,
                         "label": "SMA20 position differs from ref"})

    # 52-week range position: early stage = lower 40% of range
    rp = candidate["range_pct"]
    ref_rp = reference.get("range_pct", 0.3)
    if rp <= 0.45 and ref_rp <= 0.45:
        score += 15
        signals.append({"key": "RS", "match": True,
                         "label": f"In lower {int(rp*100)}% of 52w range — early stage setup"})
    elif rp <= 0.65:
        score += 6
        signals.append({"key": "RS", "match": "partial",
                         "label": f"Mid-range ({int(rp*100)}% of 52w)"})
    else:
        signals.append({"key": "RS", "match": False,
                         "label": f"Near 52w high ({int(rp*100)}%) — late stage"})

    return min(score, 100), signals


async def compute_radar(
    reference_ticker: str,
    period: str = "ytd",
    limit: int = 10,
    sector_filter: str | None = None,
) -> dict:
    cache_key = f"radar:{reference_ticker}:{period}:{sector_filter}"
    cached = _cache_get(cache_key)
    if cached:
        return {**cached, "_cached": True}

    ref  = reference_ticker.upper().strip()
    start = _period_start(period)
    ind_start = start - timedelta(days=60)  # need prior data for indicators at period start

    # 1. Reference ticker state at period start
    def _dl_ref():
        warnings.filterwarnings("ignore")
        df = yf.download(ref, start=str(ind_start),
                          end=str(start + timedelta(days=5)),
                          auto_adjust=True, progress=False)
        return df

    ref_df = await asyncio.to_thread(_dl_ref)
    ref_ind = _lab_indicators(ref_df)
    if not ref_ind:
        return {"error": f"Insufficient history for {ref}", "candidates": [], "reference": {}}

    ref_state = {**ref_ind, "ticker": ref, "as_of": str(start)}

    # 2. Current state for universe
    scan_tickers = UNIVERSE

    def _dl_universe():
        warnings.filterwarnings("ignore")
        return yf.download(
            scan_tickers,
            start=str(date.today() - timedelta(days=100)),
            end=str(date.today() + timedelta(days=1)),
            auto_adjust=True, progress=False,
        )

    universe_raw = await asyncio.to_thread(_dl_universe)
    if universe_raw.empty:
        return {"error": "Universe download failed", "candidates": [], "reference": ref_state}

    if isinstance(universe_raw.columns, pd.MultiIndex):
        price_data = {}
        for t in scan_tickers:
            try:
                price_data[t] = universe_raw.xs(t, axis=1, level=1) \
                    if t in universe_raw.columns.get_level_values(1) else None
            except Exception:
                price_data[t] = None
    else:
        price_data = {scan_tickers[0]: universe_raw} if len(scan_tickers) == 1 else {}

    # Compute indicators and score
    candidates = []
    for ticker in scan_tickers:
        if ticker == ref:
            continue
        df = price_data.get(ticker)
        ind = _lab_indicators(df)
        if not ind:
            continue
        score, signals = _radar_score(ind, ref_ind)
        if score < 30:
            continue
        candidates.append({
            "ticker": ticker,
            "readiness": score,
            "signals": signals,
            "signals_matched": sum(1 for s in signals if s["match"] is True),
            "signals_total": len(signals),
            **{k: ind[k] for k in ["price", "rsi", "bb_width", "vol_trend", "above_sma20", "range_pct", "return_10d"]},
        })

    candidates.sort(key=lambda x: -x["readiness"])

    # Enrich with sector/company
    top = candidates[:limit + 5]
    def _get_info(t):
        try:
            info = yf.Ticker(t).info
            return t, {"company": info.get("longName", t), "sector": info.get("sector", "Unknown")}
        except Exception:
            return t, {"company": t, "sector": "Unknown"}

    with ThreadPoolExecutor(max_workers=6) as ex:
        infos = dict(ex.map(lambda c: _get_info(c["ticker"]), top))

    for c in top:
        inf = infos.get(c["ticker"], {"company": c["ticker"], "sector": "Unknown"})
        c["company"]   = inf["company"]
        c["sector"]    = inf["sector"]
        c["theme_tag"] = SECTOR_THEME.get(inf["sector"], "Other")

    if sector_filter:
        top = [c for c in top if sector_filter.lower() in (c.get("sector") or "").lower()
               or sector_filter.lower() in (c.get("theme_tag") or "").lower()]

    result = {
        "reference_ticker": ref,
        "reference_state":  ref_state,
        "period": period,
        "candidates": top[:limit],
        "total_above_threshold": len(candidates),
    }
    _cache_set(cache_key, result)
    return result


# ── Breakout DNA ──────────────────────────────────────────────────────────────

_CATALYST_RULES = [
    # (keyword_in_theme_or_sector, catalyst_tag)
    ("Optical",      "AI Infrastructure"),
    ("Networking",   "AI Infrastructure"),
    ("Semiconductor","AI Infrastructure"),
    ("Technology",   "Tech / AI Thematic"),
    ("Nuclear",      "Nuclear / Power"),
    ("Power",        "Datacenter Power"),
    ("Fertilizer",   "Commodity Cycle"),
    ("Agriculture",  "Commodity Cycle"),
    ("Biotech",      "Biotech / Drug Catalyst"),
    ("Health",       "Healthcare Re-rate"),
    ("Energy",       "Energy / Commodity"),
    ("Industrial",   "Infrastructure Build-out"),
    ("Infrastructure","Infrastructure Build-out"),
]

def _tag_catalyst(sector: str, gain_pct: float, return_profile: list[float]) -> list[str]:
    """Rule-based catalyst tagging from sector and gain profile."""
    tags = []
    for keyword, tag in _CATALYST_RULES:
        if keyword.lower() in sector.lower():
            tags.append(tag)
            break
    if not tags:
        tags.append("Sector / Macro")

    # Detect corporate event: sudden large jump in single period
    if return_profile and max(return_profile) > 25:
        tags.append("Corporate Event")

    return tags[:2]


async def compute_dna(ticker: str, period: str = "ytd") -> dict:
    cache_key = f"dna:{ticker}:{period}"
    cached = _cache_get(cache_key)
    if cached:
        return {**cached, "_cached": True}

    t = ticker.upper().strip()
    start = _period_start(period)
    ind_start = start - timedelta(days=60)

    def _download():
        warnings.filterwarnings("ignore")
        return yf.download(t, start=str(ind_start),
                            end=str(date.today() + timedelta(days=1)),
                            auto_adjust=True, progress=False)

    df = await asyncio.to_thread(_download)
    if df is None or df.empty or len(df) < 20:
        return {"error": f"Insufficient data for {t}", "ticker": t}

    # State at period start
    start_ts = pd.Timestamp(start)
    df_before = df[df.index <= start_ts]
    df_now    = df.copy()

    ind_start_state = _lab_indicators(df_before) if len(df_before) >= 20 else None
    ind_now         = _lab_indicators(df_now)

    # Compute period gain
    after = df[df.index >= start_ts]["Close"].dropna()
    p0 = float(after.iloc[0]) if not after.empty else None
    p1 = float(df["Close"].dropna().iloc[-1])
    gain_pct = round((p1 - p0) / p0 * 100, 2) if p0 else None

    # Build weekly return profile (to detect jump events)
    close = df["Close"].dropna()
    weekly = close.resample("W").last().pct_change() * 100
    weekly_after = weekly[weekly.index >= start_ts]
    return_profile = [round(float(v), 2) for v in weekly_after.dropna().tolist()]

    # Detect inflection point (week with highest volume * price change)
    vol = df["Volume"].resample("W").mean()
    price_chg = df["Close"].resample("W").last().pct_change().abs() * 100
    impact = (vol * price_chg).dropna()
    impact_after = impact[impact.index >= start_ts]
    inflection_date = None
    if not impact_after.empty:
        inflection_date = str(impact_after.idxmax().date())

    # Get company info
    def _get_info():
        try:
            info = yf.Ticker(t).info
            return {"company": info.get("longName", t), "sector": info.get("sector", "Unknown")}
        except Exception:
            return {"company": t, "sector": "Unknown"}

    info = await asyncio.to_thread(_get_info)
    catalysts = _tag_catalyst(info["sector"], gain_pct or 0, return_profile)

    result = {
        "ticker":           t,
        "company":          info["company"],
        "sector":           info["sector"],
        "theme_tag":        SECTOR_THEME.get(info["sector"], "Other"),
        "period":           period,
        "period_start":     str(start),
        "gain_pct":         gain_pct,
        "start_price":      p0,
        "current_price":    round(p1, 2),
        "state_at_start":   ind_start_state,
        "state_today":      ind_now,
        "weekly_returns":   return_profile[-16:],  # last 16 weeks
        "inflection_date":  inflection_date,
        "catalyst_tags":    catalysts,
        "analysis_text":    None,  # filled by on-demand Sonnet call
    }
    _cache_set(cache_key, result)
    return result


async def generate_dna_analysis(ticker: str, dna: dict) -> str:
    """On-demand Claude Sonnet analysis for breakout DNA. Returns analysis text."""
    from anthropic import AsyncAnthropic
    client = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))

    s0 = dna.get("state_at_start") or {}
    s1 = dna.get("state_today") or {}

    prompt = f"""You are a quantitative analyst. A stock called {ticker} ({dna.get('company', '')})
in the {dna.get('sector', '')} sector gained {dna.get('gain_pct', '?')}% since {dna.get('period_start', '')}.

Technical state at period start:
- RSI: {s0.get('rsi', '?')}
- Bollinger Band Width: {s0.get('bb_width', '?')} ({'compressed' if s0.get('bb_squeeze') else 'normal'})
- Volume trend: {s0.get('vol_trend', '?')}x (prior period)
- Position: {'above' if s0.get('above_sma20') else 'below'} SMA20
- 52-week range position: {int((s0.get('range_pct', 0.5))*100)}% from lows

Inflection point: {dna.get('inflection_date', 'unknown')}
Catalyst tags: {', '.join(dna.get('catalyst_tags', []))}
Weekly return profile: {dna.get('weekly_returns', [])[:8]}

Write a concise 3-4 sentence analysis covering:
1. The PRIMARY driver of the breakout (macro theme, corporate event, or technical catalyst)
2. What the technical setup looked like BEFORE the move (and why it was a pre-breakout signal)
3. The inflection moment — when did institutions appear to step in?
4. One key lesson for spotting a similar setup in the future

Write in plain, direct language. No bullet points. Under 120 words."""

    response = await client.messages.create(
        model=os.getenv("ANTHROPIC_MODEL_SONNET", "claude-sonnet-4-6"),
        max_tokens=300,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.content[0].text.strip()


# ── Thesis ────────────────────────────────────────────────────────────────────

async def compute_thesis() -> dict:
    cache_key = "thesis:v1"
    cached = _cache_get(cache_key)
    if cached:
        return {**cached, "_cached": True}

    # 1. Pull recent events from DB (GDELT + RSS)
    events_text = []
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cutoff = (datetime.now() - timedelta(days=45)).isoformat()
        async with db.execute(
            """SELECT source, title, event_type, tone, impact_score, related_symbols
               FROM events
               WHERE fetched_at >= ? AND title IS NOT NULL
               ORDER BY impact_score DESC, fetched_at DESC
               LIMIT 120""",
            (cutoff,),
        ) as cur:
            rows = await cur.fetchall()
        for r in rows:
            events_text.append(
                f"[{r['source']}] {r['title']} (tone:{r['tone']:.1f} impact:{r['impact_score']:.1f})"
            )

    # 2. Sector ETF performance as macro context
    sector_etfs = ["XLK","XLF","XLE","XLV","XLI","XLB","XLU","XLRE","XLY","XLP","XLC","SPY"]
    def _dl_etfs():
        warnings.filterwarnings("ignore")
        df = yf.download(sector_etfs, period="3mo", auto_adjust=True, progress=False)
        return df

    etf_raw = await asyncio.to_thread(_dl_etfs)
    sector_context = []
    if not etf_raw.empty:
        if isinstance(etf_raw.columns, pd.MultiIndex):
            closes_etf = etf_raw["Close"] if "Close" in etf_raw.columns.get_level_values(0) \
                         else etf_raw.xs("Close", axis=1, level=1)
        else:
            closes_etf = etf_raw
        for etf in sector_etfs:
            if etf in closes_etf.columns:
                s = closes_etf[etf].dropna()
                if len(s) >= 2:
                    ret = (float(s.iloc[-1]) / float(s.iloc[0]) - 1) * 100
                    sector_context.append(f"{etf}: {ret:+.1f}% (3mo)")

    # 3. Use Haiku to synthesize themes
    from anthropic import AsyncAnthropic
    client = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))

    events_block = "\n".join(events_text[:80]) if events_text else "No events in DB yet."
    sector_block = "\n".join(sector_context)

    prompt = f"""You are a macro-thematic analyst. Based on the following market signals, identify 3-5 emerging investment themes.

RECENT NEWS/EVENTS (last 45 days):
{events_block}

SECTOR ETF PERFORMANCE (3 months):
{sector_block}

For each theme, provide a JSON object with:
- name: short theme name (3-5 words)
- confidence: 0-100 (how much evidence supports this)
- status: "confirmed" | "forming" | "early"
- summary: 2-sentence explanation of the theme and why it matters now
- source_breakdown: {{ gdelt: N, rss: N, sector_etf: true/false }}
- sectors: list of affected sectors
- example_stocks: list of 3-5 ticker symbols exposed to this theme

Return ONLY a JSON array of theme objects. No other text."""

    try:
        resp = await client.messages.create(
            model=os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001"),
            max_tokens=1200,
            messages=[{"role": "user", "content": prompt}],
        )
        raw_json = resp.content[0].text.strip()
        if raw_json.startswith("```"):
            raw_json = "\n".join(raw_json.split("\n")[1:-1])
        themes = json.loads(raw_json)
    except Exception as e:
        logger.error("thesis Haiku call failed: %s", e)
        themes = []

    result = {
        "themes":           themes,
        "events_analyzed":  len(events_text),
        "sector_context":   sector_context,
        "generated_at":     datetime.now(UTC).isoformat(),
    }
    _cache_set(cache_key, result)
    return result
