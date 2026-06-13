"""
Options Scanner — daily blue-chip options intelligence.

For each ticker in the blue-chip universe:
  1. Skip if earnings within 14 days or no clear trend (ADX < 15)
  2. Compute direction signal from technicals
  3. Compute IV regime (cheap / normal / rich) vs realized vol
  4. Compute volatility skew (25-delta risk reversal)
  5. Compute OI landscape (max pain, call wall, put wall)
  6. Select optimal strategy and strikes
  7. Score and rank; return top setups

Runs once at market open, results cached in DB for the day.
"""

import asyncio
import json
import logging
from datetime import date, datetime, UTC
from concurrent.futures import ThreadPoolExecutor, as_completed

import aiosqlite
import yfinance as yf
import pandas as pd

from app.config import DB_PATH
from app.analysis.options_engine import (
    fetch_options_chain, get_expirations, get_underlying_price,
    _dte, bs_greeks, RISK_FREE_RATE,
)
from app.analysis.technicals import compute_technicals

log = logging.getLogger(__name__)

# ── Universe ──────────────────────────────────────────────────────────────────

BLUE_CHIP_UNIVERSE = [
    # Technology
    "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "AVGO", "ORCL", "ADBE", "CRM",
    # Finance
    "JPM", "BAC", "WFC", "GS", "MS", "V", "MA", "AXP", "BLK", "C",
    # Healthcare
    "JNJ", "UNH", "LLY", "PFE", "MRK", "ABT", "TMO", "AMGN",
    # Energy
    "XOM", "CVX", "COP", "SLB",
    # Consumer
    "WMT", "COST", "PG", "KO", "PEP", "MCD", "HD", "SBUX",
    # Industrial / Defense
    "CAT", "HON", "GE", "BA", "RTX", "LMT",
    # Communication / Media
    "DIS", "NFLX", "CMCSA",
]

# Strategy selection thresholds
IV_REGIME_LOW    = 0.85   # IV/HV < 0.85 → options cheap → buy premium
IV_REGIME_HIGH   = 1.25   # IV/HV > 1.25 → options rich → sell premium
SCAN_MIN_DTE     = 21
SCAN_MAX_DTE     = 45
MIN_CONVICTION   = 45     # discard setups below this
EARNINGS_BUFFER  = 14     # skip tickers with earnings within N days


# ── Entry point ───────────────────────────────────────────────────────────────

async def run_options_scan(db: aiosqlite.Connection, force: bool = False) -> list[dict]:
    """Run (or return cached) today's options scan. Returns setups sorted by conviction."""
    today = date.today().isoformat()

    if not force:
        async with db.execute(
            "SELECT full_context_json FROM options_scanner_cache "
            "WHERE scan_date = ? ORDER BY conviction_score DESC", (today,)
        ) as cur:
            rows = await cur.fetchall()
        if rows:
            return [json.loads(r[0]) for r in rows if r[0]]

    log.info("options_scanner: starting scan of %d tickers", len(BLUE_CHIP_UNIVERSE))
    sem = asyncio.Semaphore(6)

    async def _safe(ticker):
        async with sem:
            try:
                return await asyncio.to_thread(_analyze_ticker, ticker)
            except Exception as e:
                log.debug("scanner: %s skipped — %s", ticker, e)
                return None

    results = await asyncio.gather(*[_safe(t) for t in BLUE_CHIP_UNIVERSE])
    valid = sorted(
        [r for r in results if r and r["conviction_score"] >= MIN_CONVICTION],
        key=lambda x: -x["conviction_score"],
    )

    now = datetime.now(UTC).isoformat()
    for setup in valid:
        await db.execute(
            """INSERT INTO options_scanner_cache
               (scan_date, ticker, direction, conviction_score, strategy_label,
                iv_regime, risk_reversal, adx, rsi, rec_expiry, full_context_json, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(scan_date, ticker) DO UPDATE SET
                 conviction_score = excluded.conviction_score,
                 full_context_json = excluded.full_context_json""",
            (
                today, setup["ticker"], setup["direction"], setup["conviction_score"],
                setup["strategy_label"], setup["iv_regime"],
                setup.get("risk_reversal"), setup.get("adx"), setup.get("rsi"),
                setup.get("rec_expiry"), json.dumps(setup), now,
            ),
        )
    await db.commit()
    log.info("options_scanner: %d setups found (≥%d conviction)", len(valid), MIN_CONVICTION)
    return valid


# ── Per-ticker analysis (synchronous — runs in thread) ───────────────────────

def _analyze_ticker(ticker: str) -> dict | None:
    """Full synchronous analysis of one blue-chip ticker."""
    # 1. Price history + HV
    t = yf.Ticker(ticker)
    hist = t.history(period="3mo")
    if hist.empty or len(hist) < 35:
        return None

    close = hist["Close"]
    S = float(close.iloc[-1])
    hv_30 = _compute_hv(close, 30)

    # 2. ADX (gatekeeper — skip flat / directionless stocks)
    adx_val = _compute_adx(hist, 14)
    if adx_val < 15:
        return None  # no meaningful trend

    # 3. Earnings proximity check via yfinance calendar
    earnings_dte = _days_to_earnings(t)
    if earnings_dte is not None and earnings_dte < EARNINGS_BUFFER:
        log.debug("scanner: %s skipped — earnings in %d days", ticker, earnings_dte)
        return None

    # 4. Pick expiry (SCAN_MIN_DTE–SCAN_MAX_DTE window)
    expiry = _pick_scan_expiry(ticker, SCAN_MIN_DTE, SCAN_MAX_DTE)
    if not expiry:
        return None

    # 5. Fetch options chain (has BS-Greeks, IV per strike)
    chain = fetch_options_chain(ticker, expiry)
    calls = chain["calls"]
    puts  = chain["puts"]
    dte   = chain["dte"]
    exp_move = chain["expected_move"]

    if not calls or not puts:
        return None

    # 6. IV metrics
    atm_iv = _compute_atm_iv(calls, puts, S)
    # Sanity check: equity IV below 5% is impossible — options chain had no live quotes
    # (e.g. scanner ran at market open before MM quotes populated). Fall back to HV.
    if atm_iv < 5.0:
        log.warning("scanner: %s ATM IV %.1f%% implausibly low — using HV %.1f%% as proxy", ticker, atm_iv, hv_30)
        atm_iv = hv_30
    iv_vs_rv   = atm_iv / hv_30 if hv_30 > 0 else 1.0
    iv_regime  = _classify_iv_regime(iv_vs_rv)
    iv_rank_approx = _approx_iv_rank(atm_iv, hv_30)

    # 7. Skew (25-delta risk reversal)
    skew = _compute_skew(calls, puts)

    # 8. OI landscape (max pain, call wall, put wall)
    oi = _compute_oi_levels(calls, puts, S)

    # 9. Technicals (we already have close/volume from hist)
    tech = _compute_technicals_sync(hist, S, close)

    # 10. Direction signal
    direction, tech_score = _compute_direction(tech, adx_val)
    if direction == "NEUTRAL":
        return None  # need a clear lean

    # 11. Advanced strategy recommendation
    adv_strategy = _recommend_advanced_strategy(direction, iv_regime, skew["direction"], earnings_dte)
    rec_legs = _find_strategy_legs(adv_strategy, calls, puts, S)
    if not rec_legs:
        # fallback to simple directional if advanced legs not found
        adv_strategy = "Long Call" if direction == "BULLISH" else "Long Put"
        rec_legs = _find_strategy_legs(adv_strategy, calls, puts, S)
    if not rec_legs:
        return None
    strategy = adv_strategy  # keep for top-level field (ARIA compatibility)

    # 13. Trade metrics
    metrics = _compute_trade_metrics(strategy, rec_legs)

    # 14. Conviction score
    conviction = _compute_conviction(
        tech_score, adx_val, skew, oi, iv_regime, direction,
    )
    if conviction < MIN_CONVICTION:
        return None

    # 15. Plain-English signal summary (for ARIA prompt + UI)
    summary = _build_summary(ticker, S, direction, tech, adx_val, skew, oi, iv_regime, atm_iv, hv_30, exp_move)

    # 15b. Build advanced rec (with reasoning)
    adv_reasoning = _strategy_reasoning(
        strategy, direction, iv_regime, atm_iv, hv_30, tech, S, rec_legs, metrics, earnings_dte,
    )
    advanced_rec = {"strategy_label": strategy, "legs": rec_legs, "reasoning": adv_reasoning, **metrics}

    # 15c. Build basic rec (simple long call/put, always)
    basic_rec = _build_basic_rec(direction, calls, puts, S, iv_regime, atm_iv, hv_30, tech, earnings_dte)

    # 16. Surface caution flags
    warnings: list[str] = []
    rsi_val = tech.get("rsi", 50) if tech else 50
    if rsi_val > 78 and direction == "BULLISH":
        warnings.append(f"RSI {rsi_val:.0f} — overbought. Elevated mean-reversion risk; consider waiting for a pullback before entering.")
    if rsi_val < 22 and direction == "BEARISH":
        warnings.append(f"RSI {rsi_val:.0f} — oversold. Elevated bounce risk; aggressive bearish entry here.")
    if tech and tech.get("volume_ratio", 1.0) < 0.5:
        warnings.append(f"Volume only {tech.get('volume_ratio', 0):.0%} of 20-day average — low conviction move.")
    if oi.get("call_wall") and direction == "BULLISH":
        call_wall = oi["call_wall"]
        if rec_legs and any(l["strike"] >= call_wall for l in rec_legs if l["action"] == "BUY"):
            warnings.append(f"Long strike at or above call wall ${call_wall:.0f} — strong dealer resistance at this level.")
    if earnings_dte is not None and earnings_dte < 35:
        warnings.append(f"Earnings in {earnings_dte} days — IV may spike into event and crush after.")

    return {
        "ticker":        ticker,
        "scan_date":     date.today().isoformat(),
        "current_price": round(S, 2),
        "direction":     direction,
        "conviction_score": conviction,
        "strategy_label":   strategy,
        # IV
        "iv_current":    round(atm_iv, 1),
        "iv_30d_hv":     round(hv_30, 1),
        "iv_vs_rv":      round(iv_vs_rv, 2),
        "iv_regime":     iv_regime,
        "iv_rank_approx": iv_rank_approx,
        # Skew
        "risk_reversal": skew["risk_reversal"],
        "skew_direction": skew["direction"],
        "call_25d_iv":   skew["call_25d_iv"],
        "put_25d_iv":    skew["put_25d_iv"],
        # OI
        "max_pain":      oi["max_pain"],
        "call_wall":     oi["call_wall"],
        "put_wall":      oi["put_wall"],
        # Technicals
        "rsi":           tech.get("rsi"),
        "macd_crossover": tech.get("macd_crossover"),
        "above_sma50":   tech.get("above_sma50"),
        "volume_ratio":  tech.get("volume_ratio"),
        "adx":           round(adx_val, 1),
        # Trade
        "rec_expiry":    expiry,
        "rec_dte":       dte,
        "rec_legs":      rec_legs,
        "expected_move": round(exp_move, 2),
        **metrics,
        # Context
        "days_to_earnings": earnings_dte,
        "signal_summary":   summary,
        "warnings":         warnings,
        # Two-recommendation system
        "advanced_rec":     advanced_rec,
        "basic_rec":        basic_rec,
    }


# ── Technical helpers ─────────────────────────────────────────────────────────

def _compute_technicals_sync(hist: pd.DataFrame, S: float, close: pd.Series) -> dict:
    """Compute core technical signals from price history."""
    try:
        import ta
        rsi = float(ta.momentum.RSIIndicator(close=close, window=14).rsi().iloc[-1])
        macd_ind  = ta.trend.MACD(close=close)
        macd_val  = float(macd_ind.macd().iloc[-1])
        macd_sig  = float(macd_ind.macd_signal().iloc[-1])
        sma_20    = float(close.rolling(20).mean().iloc[-1])
        sma_50    = float(close.rolling(50).mean().iloc[-1])
        vol       = hist["Volume"]
        # Always compare against the last *complete* trading day to avoid
        # partial-day distortion when the scanner runs during market hours.
        prev_vol  = float(vol.iloc[-2]) if len(vol) >= 2 else float(vol.iloc[-1])
        avg_vol   = float(vol.iloc[-21:-1].mean()) if len(vol) >= 21 else float(vol.mean())
        vol_ratio = prev_vol / avg_vol if avg_vol > 0 else 1.0

        return {
            "rsi":          round(rsi, 1),
            "macd_crossover": "bullish" if macd_val > macd_sig else "bearish",
            "above_sma20":  S > sma_20,
            "above_sma50":  S > sma_50,
            "volume_ratio": round(vol_ratio, 2),
        }
    except Exception as e:
        log.debug("_compute_technicals_sync failed: %s", e)
        return {}


def _compute_hv(close: pd.Series, window: int = 30) -> float:
    """Annualized historical volatility (%)."""
    if len(close) < window + 1:
        return 25.0
    returns = close.pct_change().dropna().tail(window)
    return float(returns.std() * (252 ** 0.5) * 100)


def _compute_adx(hist: pd.DataFrame, window: int = 14) -> float:
    """Compute ADX from OHLC data."""
    try:
        import ta
        adx = ta.trend.ADXIndicator(
            hist["High"], hist["Low"], hist["Close"], window=window
        ).adx().iloc[-1]
        return float(adx) if pd.notna(adx) else 15.0
    except Exception:
        return 15.0


def _days_to_earnings(ticker_obj) -> int | None:
    """Return DTE to next earnings or None if unknown."""
    try:
        cal = ticker_obj.calendar
        if cal is None or cal.empty:
            return None
        from datetime import date as _date
        today = _date.today()
        if "Earnings Date" in cal.index:
            raw = cal.loc["Earnings Date"]
            earnings_date = pd.Timestamp(raw.iloc[0] if hasattr(raw, "iloc") else raw).date()
            return (earnings_date - today).days
    except Exception:
        pass
    return None


def _pick_scan_expiry(ticker: str, min_dte: int, max_dte: int) -> str | None:
    """Return nearest expiry within [min_dte, max_dte]."""
    today = date.today()
    for exp_str in get_expirations(ticker):
        dte_val = _dte(exp_str)
        if min_dte <= dte_val <= max_dte:
            return exp_str
    return None


# ── IV helpers ────────────────────────────────────────────────────────────────

def _compute_atm_iv(calls: list, puts: list, S: float) -> float:
    """Return ATM implied volatility (%) as average of ATM call and put IV."""
    atm_call = min(calls, key=lambda c: abs(c["strike"] - S), default=None)
    atm_put  = min(puts,  key=lambda c: abs(c["strike"] - S), default=None)
    ivs = [c["iv"] for c in [atm_call, atm_put] if c and c.get("iv") and c["iv"] > 0]
    return float(sum(ivs) / len(ivs)) if ivs else 25.0


def _classify_iv_regime(iv_vs_rv: float) -> str:
    if iv_vs_rv < IV_REGIME_LOW:
        return "LOW"
    if iv_vs_rv > IV_REGIME_HIGH:
        return "HIGH"
    return "MEDIUM"


def _approx_iv_rank(atm_iv: float, hv_30: float) -> int:
    """Rough IV rank 0-100 based on IV vs short-term and long-term HV."""
    ratio = atm_iv / hv_30 if hv_30 > 0 else 1.0
    # Calibrate: ratio 0.7 ≈ rank 10, ratio 1.0 ≈ rank 40, ratio 1.5 ≈ rank 80
    rank = min(100, max(0, int((ratio - 0.6) / 0.9 * 100)))
    return rank


# ── Skew ──────────────────────────────────────────────────────────────────────

def _compute_skew(calls: list, puts: list) -> dict:
    """Compute 25-delta risk reversal from chain deltas."""
    call_25 = min(calls, key=lambda c: abs((c.get("delta") or 0) - 0.25), default=None)
    put_25  = min(puts,  key=lambda c: abs(abs(c.get("delta") or 0) - 0.25), default=None)

    call_iv = float(call_25["iv"]) if call_25 and call_25.get("iv") else None
    put_iv  = float(put_25["iv"])  if put_25  and put_25.get("iv")  else None

    if call_iv and put_iv:
        rr = round(call_iv - put_iv, 2)  # positive = calls pricier (bullish bias)
        if rr > 3:
            direction = "BULLISH"
        elif rr < -8:
            direction = "BEARISH"
        elif rr < -3:
            direction = "SLIGHTLY_BEARISH"
        else:
            direction = "NEUTRAL"
    else:
        rr, direction = None, "NEUTRAL"

    return {
        "risk_reversal": rr,
        "direction":     direction,
        "call_25d_iv":   round(call_iv, 1) if call_iv else None,
        "put_25d_iv":    round(put_iv, 1)  if put_iv  else None,
    }


# ── OI landscape ─────────────────────────────────────────────────────────────

def _compute_oi_levels(calls: list, puts: list, S: float) -> dict:
    call_oi = {c["strike"]: c.get("openInterest") or 0 for c in calls}
    put_oi  = {c["strike"]: c.get("openInterest") or 0 for c in puts}
    all_strikes = sorted(set(list(call_oi) + list(put_oi)))

    max_pain = _compute_max_pain(all_strikes, call_oi, put_oi)

    otm_calls = [(s, call_oi.get(s, 0)) for s in all_strikes if s > S]
    otm_puts  = [(s, put_oi.get(s,  0)) for s in all_strikes if s < S]
    call_wall = max(otm_calls, key=lambda x: x[1])[0] if otm_calls else None
    put_wall  = max(otm_puts,  key=lambda x: x[1])[0] if otm_puts  else None

    return {"max_pain": max_pain, "call_wall": call_wall, "put_wall": put_wall}


def _compute_max_pain(strikes: list, call_oi: dict, put_oi: dict) -> float | None:
    if not strikes:
        return None
    best, best_pain = strikes[0], float("inf")
    for pin in strikes:
        pain = (
            sum(max(0, pin - s) * call_oi.get(s, 0) for s in strikes) +
            sum(max(0, s - pin) * put_oi.get(s, 0)  for s in strikes)
        )
        if pain < best_pain:
            best_pain, best = pain, pin
    return best


# ── Direction signal ─────────────────────────────────────────────────────────

def _compute_direction(tech: dict, adx: float) -> tuple[str, int]:
    """Return (direction, confidence 0-10) from technicals."""
    if not tech:
        return "NEUTRAL", 3

    score = 0
    rsi = tech.get("rsi", 50)

    # RSI — extreme readings are mean-reversion signals, not continuation
    if 55 <= rsi <= 72:
        score += 3   # healthy uptrend momentum
    elif 73 <= rsi <= 78:
        score += 1   # extended but still trending
    elif rsi > 78:
        score -= 2   # overbought — expect pullback, penalise bullish direction
    elif 28 <= rsi <= 30:
        score += 2   # oversold — expect bounce, penalise bearish direction
    elif 22 <= rsi <= 27:
        score -= 1   # extended oversold
    elif rsi < 22:
        score -= 2   # extreme oversold — mean reversion risk, penalise bearish
    elif 30 <= rsi <= 45:
        score -= 3   # weak / bearish momentum
    # 45–55: neutral, no contribution

    # MACD
    if tech.get("macd_crossover") == "bullish":
        score += 3
    else:
        score -= 3

    # SMA trend
    if tech.get("above_sma50"):
        score += 2
    else:
        score -= 2

    if tech.get("above_sma20"):
        score += 1
    else:
        score -= 1

    # Volume confirms existing direction
    vol = tech.get("volume_ratio", 1.0)
    if vol > 1.5 and score > 0:
        score += 1
    elif vol > 1.5 and score < 0:
        score -= 1

    # ADX amplifies confidence but doesn't change direction
    adx_boost = 2 if adx > 30 else (1 if adx > 20 else 0)
    confidence = min(10, abs(score) + adx_boost)

    if score >= 4:
        return "BULLISH", confidence
    if score <= -4:
        return "BEARISH", confidence
    return "NEUTRAL", confidence


# ── Strategy selection ────────────────────────────────────────────────────────

def _recommend_strategy(direction: str, iv_regime: str, skew_dir: str) -> str | None:
    """Advanced strategy: direction × IV × skew matrix."""
    if direction == "BULLISH":
        if iv_regime == "LOW":
            return "Long Call"
        if iv_regime == "MEDIUM":
            return "Bull Call Spread"
        return "Short Put"            # HIGH IV — sell premium, still bullish
    if direction == "BEARISH":
        if iv_regime == "LOW":
            return "Long Put"
        if iv_regime == "MEDIUM":
            return "Bear Put Spread"
        return "Bear Call Spread"     # HIGH IV — sell premium, still bearish
    return None                       # NEUTRAL → no single-direction options trade


def _recommend_advanced_strategy(
    direction: str, iv_regime: str, skew_dir: str, earnings_dte: int | None,
) -> str:
    """
    Full strategy matrix including vol plays.
    Priority: earnings plays > premium-selling > directional > vol neutral.
    """
    # Straddle/Strangle near earnings regardless of direction
    if earnings_dte is not None and earnings_dte <= 14:
        return "Straddle" if iv_regime == "LOW" else "Strangle"

    if direction == "BULLISH":
        if iv_regime == "LOW":   return "Long Call"
        if iv_regime == "MEDIUM": return "Bull Call Spread"
        return "Short Put"

    if direction == "BEARISH":
        if iv_regime == "LOW":   return "Long Put"
        if iv_regime == "MEDIUM": return "Bear Put Spread"
        return "Bear Call Spread"

    # NEUTRAL direction with no earnings catalyst → vol play
    return "Straddle" if iv_regime == "LOW" else "Strangle"


def _build_basic_rec(
    direction: str, calls: list, puts: list, S: float,
    iv_regime: str, atm_iv: float, hv_30: float,
    tech: dict, earnings_dte: int | None,
) -> dict | None:
    """Always a simple Long Call or Long Put, but picks the right strike for the IV environment."""
    # Strike target by IV regime:
    #   HIGH IV → ITM (Δ0.65): less extrinsic value, lower breakeven, less hurt by IV crush
    #   MED IV  → ATM (Δ0.50): balanced cost/upside
    #   LOW IV  → OTM (Δ0.35): cheap premium, IV is attractive for buyers
    if iv_regime == "HIGH":
        primary_delta, label = 0.65, "ITM"
    elif iv_regime == "LOW":
        primary_delta, label = 0.35, "OTM"
    else:
        primary_delta, label = 0.50, "ATM"

    pool = calls if direction == "BULLISH" else puts
    strategy = "Long Call" if direction == "BULLISH" else "Long Put"

    chosen = _find_nearest_delta(pool, primary_delta)
    if not chosen:
        return None

    def _leg_from(opt: dict) -> dict:
        return {
            "action": "BUY",
            "option_type": "call" if direction == "BULLISH" else "put",
            "strike": opt["strike"],
            "delta": round(opt.get("delta") or 0, 3),
            "gamma": round(opt.get("gamma") or 0, 4),
            "theta": round(opt.get("theta") or 0, 4),
            "vega":  round(opt.get("vega")  or 0, 4),
            "iv":    opt.get("iv"),
            "fill_price": round(_mid(opt), 3),
        }

    def _comparison_row(label: str, target_delta: float) -> dict | None:
        opt = _find_nearest_delta(pool, target_delta)
        if not opt:
            return None
        mid = round(_mid(opt), 2)
        strike = opt["strike"]
        delta  = round(opt.get("delta") or 0, 3)
        be = round(strike + mid, 2) if direction == "BULLISH" else round(strike - mid, 2)
        be_pct = round((be - S) / S * 100, 1) if direction == "BULLISH" else round((S - be) / S * 100, 1)
        return {
            "label":       label,
            "strike":      strike,
            "delta":       delta,
            "gamma":       round(opt.get("gamma") or 0, 4),
            "theta":       round(opt.get("theta") or 0, 4),
            "vega":        round(opt.get("vega")  or 0, 4),
            "iv":          opt.get("iv"),
            "premium":     mid,
            "cost":        round(mid * 100, 2),
            "breakeven":   be,
            "breakeven_pct": be_pct,
            "recommended": False,
        }

    otm_row  = _comparison_row("OTM (Δ≈0.35)", 0.35)
    atm_row  = _comparison_row("ATM (Δ≈0.50)", 0.50)
    itm_row  = _comparison_row("ITM (Δ≈0.65)", 0.65)

    strike_comparison = [r for r in [otm_row, atm_row, itm_row] if r]

    # Mark the recommended row
    for row in strike_comparison:
        if row["label"] == f"{label} (Δ≈{primary_delta:.2f})":
            row["recommended"] = True
    # fallback: mark by closest delta match
    if not any(r["recommended"] for r in strike_comparison):
        chosen_strike = chosen["strike"]
        for row in strike_comparison:
            if row["strike"] == chosen_strike:
                row["recommended"] = True
                break
        else:
            if strike_comparison:
                strike_comparison[{"HIGH": 2, "MED": 1, "LOW": 0}.get(iv_regime, 1)]["recommended"] = True

    legs = [_leg_from(chosen)]
    metrics = _compute_trade_metrics(strategy, legs)
    reasoning = _strategy_reasoning(
        strategy, direction, iv_regime, atm_iv, hv_30, tech, S, legs, metrics, earnings_dte,
        strike_label=label, primary_delta=primary_delta,
    )
    return {
        "strategy_label":    strategy,
        "legs":              legs,
        "reasoning":         reasoning,
        "strike_comparison": strike_comparison,
        **metrics,
    }


def _strategy_reasoning(
    strategy: str, direction: str, iv_regime: str,
    atm_iv: float, hv_30: float, tech: dict, S: float,
    legs: list, metrics: dict, earnings_dte: int | None,
    strike_label: str = "ATM", primary_delta: float = 0.50,
) -> str:
    """Generate 2-3 sentence plain-English reasoning for a strategy pick."""
    rsi  = (tech or {}).get("rsi", 50)
    macd = (tech or {}).get("macd_crossover", "")
    sma  = "above SMA50" if (tech or {}).get("above_sma50") else "below SMA50"
    vol_lbl = f"IV {atm_iv:.0f}% vs {hv_30:.0f}% historical"
    iv_edge = "elevated — premium sellers have a statistical edge" if atm_iv > hv_30 * 1.15 else \
              "cheap relative to historical — premium buyers pay less than average" if atm_iv < hv_30 * 0.9 else \
              "near fair value relative to historical vol"
    trend = "bullish" if direction == "BULLISH" else "bearish"
    dir_lbl = "upside" if direction == "BULLISH" else "downside"

    if strategy == "Long Call":
        be = metrics.get("breakeven") or 0
        pct = round((be - S) / S * 100, 1) if S else 0
        iv_elevated = atm_iv > hv_30 * 1.15
        iv_cheap    = atm_iv < hv_30 * 0.90
        # Strike selection rationale
        if iv_elevated:
            strike_why = (
                f"With IV elevated ({atm_iv:.0f}% vs {hv_30:.0f}% historical), an {strike_label} strike (Δ≈{primary_delta:.2f}) "
                f"was chosen over OTM to minimise extrinsic (time) value — ITM options have more intrinsic value, "
                f"a lower breakeven, and are less hurt by IV crush if volatility falls after entry."
            )
        elif iv_cheap:
            strike_why = (
                f"With IV cheap ({atm_iv:.0f}% vs {hv_30:.0f}% historical), an {strike_label} strike (Δ≈{primary_delta:.2f}) "
                f"was chosen — when options are inexpensive, paying for an OTM call gives maximum leverage "
                f"at low dollar cost."
            )
        else:
            strike_why = (
                f"IV is near fair value ({atm_iv:.0f}% vs {hv_30:.0f}% historical), so an {strike_label} strike "
                f"(Δ≈{primary_delta:.2f}) gives a balanced mix of cost, breakeven, and upside leverage."
            )
        iv_warn = (
            f" ⚠ IV is still elevated — the Advanced strategy (Short Put) exploits this more efficiently."
        ) if iv_elevated else ""
        return (
            f"Breakeven is ${be:.2f} (+{pct}%) — the stock must rise that far by expiry.{iv_warn} "
            f"{strike_why} "
            f"Compare the three strikes in the table below to see the full Greeks trade-off."
        )

    if strategy == "Long Put":
        be = metrics.get("breakeven") or 0
        pct = round((S - be) / S * 100, 1) if S else 0
        iv_elevated = atm_iv > hv_30 * 1.15
        iv_cheap    = atm_iv < hv_30 * 0.90
        if iv_elevated:
            strike_why = (
                f"With IV elevated ({atm_iv:.0f}% vs {hv_30:.0f}% historical), an {strike_label} strike (Δ≈{primary_delta:.2f}) "
                f"was chosen to minimise extrinsic value — ITM puts have lower breakeven and less vega exposure."
            )
        elif iv_cheap:
            strike_why = (
                f"With IV cheap ({atm_iv:.0f}% vs {hv_30:.0f}% historical), an {strike_label} strike (Δ≈{primary_delta:.2f}) "
                f"gives maximum downside leverage at low cost."
            )
        else:
            strike_why = (
                f"IV near fair value ({atm_iv:.0f}% vs {hv_30:.0f}% historical) — an {strike_label} strike (Δ≈{primary_delta:.2f}) "
                f"balances cost and downside capture."
            )
        iv_warn = (
            f" ⚠ IV is still elevated — the Advanced strategy exploits this more efficiently."
        ) if iv_elevated else ""
        return (
            f"Breakeven is ${be:.2f} (-{pct}%) — the stock must fall that far by expiry.{iv_warn} "
            f"{strike_why} "
            f"Compare the three strikes in the table below to see the full Greeks trade-off."
        )

    if strategy == "Bull Call Spread":
        buy_k  = legs[0]["strike"]
        sell_k = legs[1]["strike"] if len(legs) > 1 else buy_k + 5
        rr = metrics.get("risk_reward") or 0
        cost = metrics.get("entry_cost") or 0
        return (
            f"{vol_lbl}: a spread is more capital-efficient than a naked long call in this IV environment. "
            f"Buying the ${buy_k:.0f} call and selling the ${sell_k:.0f} call costs ${cost:.0f} and profits fully if the stock clears ${sell_k:.0f}. "
            f"Risk-reward is {rr:.1f}× — you risk ${cost:.0f} to make up to ${metrics.get('max_profit', 0):.0f}."
        )

    if strategy == "Bear Put Spread":
        buy_k  = legs[0]["strike"]
        sell_k = legs[1]["strike"] if len(legs) > 1 else buy_k - 5
        cost = metrics.get("entry_cost") or 0
        return (
            f"{vol_lbl}: a spread lowers cost vs a naked long put in this IV environment. "
            f"Buying the ${buy_k:.0f} put and selling the ${sell_k:.0f} put costs ${cost:.0f} and profits fully if the stock falls below ${sell_k:.0f}. "
            f"Defined risk: max loss is ${cost:.0f}, max profit ${metrics.get('max_profit', 0):.0f}."
        )

    if strategy == "Short Put":
        sell_leg = next((l for l in legs if l["action"] == "SELL"), legs[0])
        strike = sell_leg["strike"]
        credit = metrics.get("max_profit") or 0
        be = metrics.get("breakeven") or 0
        buf = round((S - strike) / S * 100, 1) if S else 0
        pop = metrics.get("prob_profit") or 0
        return (
            f"{vol_lbl} is {iv_edge} — selling premium here captures that edge. "
            f"The ${strike:.0f} put collects ${credit:.0f} in premium; you keep it all if the stock stays above ${strike:.0f} (+{buf}% OTM buffer). "
            f"Breakeven at expiry is ${be:.2f} and estimated probability of profit is ~{pop}%."
        )

    if strategy == "Bear Call Spread":
        sell_leg = next((l for l in legs if l["action"] == "SELL"), legs[0])
        sell_k = sell_leg["strike"]
        credit = metrics.get("max_profit") or 0
        be = metrics.get("breakeven") or 0
        return (
            f"{vol_lbl} is {iv_edge} — selling calls against a hedge captures the premium edge on the {trend} thesis. "
            f"Selling the ${sell_k:.0f} call and buying a higher-strike hedge collects ${credit:.0f} in premium. "
            f"Breakeven is ${be:.2f} — the stock must stay below that to keep the full credit."
        )

    if strategy == "Straddle":
        cost = metrics.get("entry_cost") or 0
        be_up = metrics.get("breakeven_up") or 0
        be_dn = metrics.get("breakeven_down") or 0
        if earnings_dte:
            return (
                f"With earnings ~{earnings_dte} days away, the stock could gap sharply in either direction. "
                f"A straddle buys both the ATM call and put, costing ${cost:.0f} total. "
                f"You profit if the stock moves beyond ${be_up:.2f} (up) or ${be_dn:.2f} (down) — this is a bet on volatility, not direction."
            )
        return (
            f"Direction signals are mixed but a significant move is possible given {vol_lbl}. "
            f"A straddle buys both the ATM call and put for ${cost:.0f}, profiting if the stock moves beyond ${be_up:.2f} or below ${be_dn:.2f}. "
            f"Best outcome: large move in either direction before expiry."
        )

    if strategy == "Strangle":
        cost = metrics.get("entry_cost") or 0
        be_up = metrics.get("breakeven_up") or 0
        be_dn = metrics.get("breakeven_down") or 0
        return (
            f"A strangle buys OTM call and put options — cheaper than a straddle but requires a larger move to profit. "
            f"Total cost is ${cost:.0f}; you profit if the stock surpasses ${be_up:.2f} or drops below ${be_dn:.2f}. "
            f"Suits environments where a big catalyst is expected but direction is uncertain."
        )

    return f"{strategy} selected based on {direction} direction with {iv_regime} IV regime."


# ── Strike selection ──────────────────────────────────────────────────────────

def _find_nearest_delta(contracts: list, target_delta: float) -> dict | None:
    valid = [c for c in contracts if c.get("delta") is not None and c.get("bid") is not None and (c.get("bid") or 0) > 0]
    if not valid:
        valid = [c for c in contracts if c.get("delta") is not None]
    if not valid:
        return None
    return min(valid, key=lambda c: abs(abs(c["delta"]) - target_delta))


def _mid(c: dict) -> float:
    if c.get("bid") and c.get("ask"):
        return (c["bid"] + c["ask"]) / 2
    return c.get("lastPrice") or c.get("mid") or 0.0


def _find_strategy_legs(strategy: str, calls: list, puts: list, S: float) -> list[dict] | None:
    def _leg(c, action):
        return {
            "action":      action,
            "option_type": "call" if c in calls else "put",
            "strike":      c["strike"],
            "delta":       round(c.get("delta") or 0, 3),
            "iv":          c.get("iv"),
            "fill_price":  round(_mid(c), 3),
        }

    if strategy == "Long Call":
        c = _find_nearest_delta(calls, 0.45)
        return [_leg(c, "BUY")] if c else None

    if strategy == "Bull Call Spread":
        buy  = _find_nearest_delta(calls, 0.40)
        if not buy:
            return None
        sell_candidates = [c for c in calls if c["strike"] > buy["strike"]]
        sell = _find_nearest_delta(sell_candidates, 0.25)
        return [_leg(buy, "BUY"), _leg(sell, "SELL")] if sell else None

    if strategy == "Short Put":
        p = _find_nearest_delta(puts, 0.28)
        return [_leg(p, "SELL")] if p else None

    if strategy == "Long Put":
        p = _find_nearest_delta(puts, 0.45)
        return [_leg(p, "BUY")] if p else None

    if strategy == "Bear Put Spread":
        buy  = _find_nearest_delta(puts, 0.40)
        if not buy:
            return None
        sell_candidates = [p for p in puts if p["strike"] < buy["strike"]]
        sell = _find_nearest_delta(sell_candidates, 0.25)
        return [_leg(buy, "BUY"), _leg(sell, "SELL")] if sell else None

    if strategy == "Bear Call Spread":
        sell = _find_nearest_delta(calls, 0.28)
        if not sell:
            return None
        buy_candidates = [c for c in calls if c["strike"] > sell["strike"]]
        buy = _find_nearest_delta(buy_candidates, 0.10)
        return [_leg(sell, "SELL"), _leg(buy, "BUY")] if buy else None

    if strategy == "Straddle":
        # ATM call and ATM put — same or adjacent strike, both BUY
        c = _find_nearest_delta(calls, 0.50)
        p = _find_nearest_delta(puts, 0.50)
        return [_leg(c, "BUY"), _leg(p, "BUY")] if c and p else None

    if strategy == "Strangle":
        # OTM call + OTM put, both BUY
        c = _find_nearest_delta(calls, 0.25)
        p = _find_nearest_delta(puts, 0.25)
        return [_leg(c, "BUY"), _leg(p, "BUY")] if c and p else None

    return None


# ── Trade metrics ─────────────────────────────────────────────────────────────

def _compute_trade_metrics(strategy: str, legs: list) -> dict:
    fills    = {l["action"]: l["fill_price"] for l in legs}
    strikes  = [l["strike"] for l in legs]
    buy_legs = [l for l in legs if l["action"] == "BUY"]
    sell_legs = [l for l in legs if l["action"] == "SELL"]
    straddle_be_up = straddle_be_dn = None  # set for Straddle/Strangle below

    debit  = sum(l["fill_price"] for l in buy_legs)  - sum(l["fill_price"] for l in sell_legs)
    credit = -debit  # positive when net credit

    if strategy in ("Long Call", "Long Put"):
        entry_cost = round(debit * 100, 2)
        max_loss   = entry_cost
        max_profit = None  # unlimited for long call/put
        breakeven  = round(strikes[0] + debit if strategy == "Long Call" else strikes[0] - debit, 2)
        rr         = None

    elif strategy == "Bull Call Spread":
        width      = legs[1]["strike"] - legs[0]["strike"]
        max_profit = round((width - debit) * 100, 2)
        max_loss   = round(debit * 100, 2)
        entry_cost = max_loss
        breakeven  = round(legs[0]["strike"] + debit, 2)
        rr         = round(max_profit / max_loss, 2) if max_loss > 0 else None

    elif strategy == "Bear Put Spread":
        width      = legs[0]["strike"] - legs[1]["strike"]
        max_profit = round((width - debit) * 100, 2)
        max_loss   = round(debit * 100, 2)
        entry_cost = max_loss
        breakeven  = round(legs[0]["strike"] - debit, 2)
        rr         = round(max_profit / max_loss, 2) if max_loss > 0 else None

    elif strategy == "Short Put":
        entry_cost = round(-credit * 100, 2)   # negative = you receive cash
        max_profit = round(credit * 100, 2)
        max_loss   = round((strikes[0] - credit) * 100, 2)
        breakeven  = round(strikes[0] - credit, 2)
        rr         = None

    elif strategy == "Bear Call Spread":
        sell_strike = legs[0]["strike"]
        buy_strike  = legs[1]["strike"]
        width       = buy_strike - sell_strike
        max_profit  = round(credit * 100, 2)
        max_loss    = round((width - credit) * 100, 2)
        entry_cost  = round(-credit * 100, 2)   # credit received
        breakeven   = round(sell_strike + credit, 2)
        rr          = round(max_profit / max_loss, 2) if max_loss > 0 else None

    elif strategy in ("Straddle", "Strangle"):
        # Both legs are BUY — total debit = call premium + put premium
        call_leg   = next((l for l in legs if l["option_type"] == "call"), None)
        put_leg    = next((l for l in legs if l["option_type"] == "put"), None)
        straddle_be_up = straddle_be_dn = None
        if call_leg and put_leg:
            total_debit    = call_leg["fill_price"] + put_leg["fill_price"]
            entry_cost     = round(total_debit * 100, 2)
            max_loss       = entry_cost
            max_profit     = None
            straddle_be_up = round(call_leg["strike"] + total_debit, 2)
            straddle_be_dn = round(put_leg["strike"]  - total_debit, 2)
            breakeven      = straddle_be_up
        else:
            entry_cost = max_profit = max_loss = breakeven = None
        rr = None

    else:
        entry_cost = max_profit = max_loss = breakeven = rr = None

    # Probability-of-profit approximation from buy-leg delta.
    # For both calls and puts, |delta| ≈ probability of expiring ITM = PoP for a long.
    # A 25Δ call or put has ~25% chance of being profitable at expiry.
    pop = None
    if buy_legs:
        d = abs(buy_legs[0].get("delta") or 0)
        if d > 0:  # skip if delta is 0 (bad IV data produced invalid greeks)
            if strategy in ("Long Call", "Bull Call Spread", "Long Put", "Bear Put Spread"):
                pop = round(d * 100)
    if sell_legs and strategy == "Short Put":
        d = abs(sell_legs[0].get("delta") or 0)
        pop = round((1 - d) * 100)

    return {
        "entry_cost":       entry_cost,
        "max_profit":       max_profit,
        "max_loss":         max_loss,
        "breakeven":        breakeven,
        "breakeven_up":     straddle_be_up,
        "breakeven_down":   straddle_be_dn,
        "risk_reward":      rr,
        "prob_profit":      pop,
    }


# ── Conviction scoring ────────────────────────────────────────────────────────

def _compute_conviction(tech_score: int, adx: float, skew: dict,
                         oi: dict, iv_regime: str, direction: str) -> int:
    score = 0

    # Technical base (0–35)
    score += min(35, tech_score * 4)

    # ADX trend strength bonus (0–15)
    if adx > 35:
        score += 15
    elif adx > 25:
        score += 10
    elif adx > 20:
        score += 5

    # Skew alignment with direction (0–20)
    skew_dir = skew.get("direction", "NEUTRAL")
    if (direction == "BULLISH" and skew_dir == "BULLISH") or \
       (direction == "BEARISH" and skew_dir in ("BEARISH", "SLIGHTLY_BEARISH")):
        score += 20
    elif skew_dir == "NEUTRAL":
        score += 8
    elif (direction == "BULLISH" and skew_dir in ("BEARISH", "SLIGHTLY_BEARISH")) or \
         (direction == "BEARISH" and skew_dir == "BULLISH"):
        score -= 10  # skew contradicts direction

    # IV regime clarity (0–15)
    if iv_regime in ("LOW", "HIGH"):
        score += 15
    else:
        score += 8

    # OI landscape (0–15)
    if oi.get("call_wall") and oi.get("put_wall"):
        score += 10
    if oi.get("max_pain"):
        score += 5

    return min(100, max(0, score))


# ── Signal summary (plain English) ───────────────────────────────────────────

def _build_summary(ticker, S, direction, tech, adx, skew, oi, iv_regime, atm_iv, hv_30, exp_move) -> str:
    parts = []

    # Direction
    dir_word = "bullish" if direction == "BULLISH" else "bearish"
    parts.append(f"{ticker} is technically {dir_word}")

    rsi = tech.get("rsi")
    if rsi:
        parts.append(f"RSI {rsi:.0f}")
    if tech.get("macd_crossover") == "bullish":
        parts.append("MACD bullish crossover")
    elif tech.get("macd_crossover") == "bearish":
        parts.append("MACD bearish")
    if tech.get("above_sma50"):
        parts.append("above SMA50")
    else:
        parts.append("below SMA50")

    parts.append(f"ADX {adx:.0f} ({'strong trend' if adx > 25 else 'moderate trend'})")

    # IV
    if iv_regime == "LOW":
        parts.append(f"IV is cheap vs realized ({atm_iv:.0f}% ATM vs {hv_30:.0f}% HV) — good to buy premium")
    elif iv_regime == "HIGH":
        parts.append(f"IV is elevated vs realized ({atm_iv:.0f}% ATM vs {hv_30:.0f}% HV) — selling premium has edge")
    else:
        parts.append(f"IV is fair ({atm_iv:.0f}% ATM vs {hv_30:.0f}% HV)")

    # Skew
    rr = skew.get("risk_reversal")
    if rr is not None:
        if rr > 2:
            parts.append(f"call skew elevated (RR +{rr:.1f}) — market bidding up calls")
        elif rr < -5:
            parts.append(f"put skew heavy (RR {rr:.1f}) — market hedging downside")
        else:
            parts.append(f"skew neutral (RR {rr:.1f})")

    # OI levels
    if oi.get("call_wall"):
        parts.append(f"call wall at ${oi['call_wall']:.0f}")
    if oi.get("put_wall"):
        parts.append(f"put wall at ${oi['put_wall']:.0f}")
    if oi.get("max_pain"):
        parts.append(f"max pain ${oi['max_pain']:.0f}")

    parts.append(f"expected move ±${exp_move:.2f}")

    return ". ".join(parts) + "."
