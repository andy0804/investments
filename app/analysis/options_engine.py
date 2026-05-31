"""Black-Scholes pricer, Greeks computation, and yfinance options chain fetcher."""

import math
import logging
from datetime import datetime, UTC, date
from typing import Any

import yfinance as yf

log = logging.getLogger(__name__)

RISK_FREE_RATE = 0.05  # default; refreshed from DB if available


def _safe_float(v, default: float | None = None) -> float | None:
    """Convert to float, returning default if None / NaN / Inf."""
    try:
        f = float(v)
        return default if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return default


def _safe_int(v, default: int = 0) -> int:
    """Convert to int, returning default if None / NaN / Inf."""
    f = _safe_float(v)
    return default if f is None else int(f)
COMMISSION_PER_CONTRACT = 0.65
MULTIPLIER = 100  # standard US equity option


# ── Normal distribution helpers ──────────────────────────────────────────────

def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


# ── Black-Scholes pricer ──────────────────────────────────────────────────────

def bs_price(S: float, K: float, T: float, r: float, sigma: float, is_call: bool) -> float:
    """Black-Scholes theoretical price. T in years. Returns 0 if T ≤ 0."""
    if T <= 0 or sigma <= 0:
        intrinsic = max(S - K, 0) if is_call else max(K - S, 0)
        return intrinsic
    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    if is_call:
        return S * _norm_cdf(d1) - K * math.exp(-r * T) * _norm_cdf(d2)
    else:
        return K * math.exp(-r * T) * _norm_cdf(-d2) - S * _norm_cdf(-d1)


def bs_greeks(S: float, K: float, T: float, r: float, sigma: float, is_call: bool) -> dict:
    """
    Compute full Greek set from Black-Scholes.
    All values are per-share (multiply by 100 for per-contract).
    """
    if T <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        return {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "rho": 0.0}

    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    pdf_d1 = _norm_pdf(d1)
    sqrt_T = math.sqrt(T)

    delta = _norm_cdf(d1) if is_call else _norm_cdf(d1) - 1.0
    gamma = pdf_d1 / (S * sigma * sqrt_T)
    # theta per calendar day (Hull formula, divided by 365)
    base_theta = -(S * pdf_d1 * sigma) / (2.0 * sqrt_T)
    if is_call:
        theta_annual = base_theta - r * K * math.exp(-r * T) * _norm_cdf(d2)
    else:
        theta_annual = base_theta + r * K * math.exp(-r * T) * _norm_cdf(-d2)
    theta = theta_annual / 365.0
    vega = S * pdf_d1 * sqrt_T * 0.01  # per 1% IV move
    if is_call:
        rho = K * T * math.exp(-r * T) * _norm_cdf(d2) * 0.01
    else:
        rho = -K * T * math.exp(-r * T) * _norm_cdf(-d2) * 0.01

    return {
        "delta": round(delta, 4),
        "gamma": round(gamma, 4),
        "theta": round(theta, 4),
        "vega": round(vega, 4),
        "rho": round(rho, 4),
    }


# ── Days to expiry ────────────────────────────────────────────────────────────

def _dte(expiry_str: str) -> int:
    """Calendar days from today to expiry."""
    exp = datetime.strptime(expiry_str, "%Y-%m-%d").date()
    return max(0, (exp - date.today()).days)


def _dte_years(expiry_str: str) -> float:
    return _dte(expiry_str) / 365.0


# ── yfinance chain fetcher ─────────────────────────────────────────────────────

def get_expirations(ticker: str) -> list[str]:
    """Return sorted expiration date strings (YYYY-MM-DD)."""
    try:
        t = yf.Ticker(ticker)
        raw = t.options  # tuple of date strings
        return sorted(raw)
    except Exception as e:
        log.warning("get_expirations(%s): %s", ticker, e)
        return []


def get_underlying_price(ticker: str) -> float | None:
    """Latest close / pre-market price."""
    try:
        t = yf.Ticker(ticker)
        info = t.fast_info
        price = getattr(info, "last_price", None) or getattr(info, "regular_market_price", None)
        if price is None:
            hist = t.history(period="1d")
            price = float(hist["Close"].iloc[-1]) if not hist.empty else None
        return round(float(price), 4) if price else None
    except Exception as e:
        log.warning("get_underlying_price(%s): %s", ticker, e)
        return None


def fetch_options_chain(ticker: str, expiry: str) -> dict:
    """
    Fetch calls + puts for a given expiry, enrich each row with
    computed BS Greeks using the contract's impliedVolatility.

    Returns:
        {
          "underlying": float,
          "expiry": str,
          "dte": int,
          "expected_move": float,
          "calls": [row_dict, ...],
          "puts":  [row_dict, ...],
        }
    """
    S = get_underlying_price(ticker)
    if S is None:
        raise ValueError(f"Cannot fetch underlying price for {ticker}")

    try:
        t = yf.Ticker(ticker)
        chain = t.option_chain(expiry)
    except Exception as e:
        raise ValueError(f"yfinance option_chain({ticker}, {expiry}) failed: {e}") from e

    T = _dte_years(expiry)
    dte = _dte(expiry)
    r = RISK_FREE_RATE

    def _enrich(row: dict, is_call: bool) -> dict:
        iv_raw = _safe_float(row.get("impliedVolatility"), 0.0) or 0.0
        K      = _safe_float(row.get("strike"), 0.0) or 0.0
        greeks = bs_greeks(S, K, T, r, iv_raw, is_call) if iv_raw > 0 and K > 0 else {}
        bs_val = bs_price(S, K, T, r, iv_raw, is_call) if iv_raw > 0 and K > 0 else None
        bid = _safe_float(row.get("bid"))
        ask = _safe_float(row.get("ask"))
        mid = round((bid + ask) / 2.0, 3) if bid is not None and ask is not None else None
        return {
            "contractSymbol": str(row.get("contractSymbol", "")),
            "strike":         round(K, 4),
            "bid":            bid,
            "ask":            ask,
            "mid":            mid,
            "lastPrice":      _safe_float(row.get("lastPrice"), 0.0),
            "volume":         _safe_int(row.get("volume")),
            "openInterest":   _safe_int(row.get("openInterest")),
            "iv":             round(iv_raw * 100, 2),  # as %
            "inTheMoney":     bool(row.get("inTheMoney", False)),
            "delta":          greeks.get("delta"),
            "gamma":          greeks.get("gamma"),
            "theta":          greeks.get("theta"),
            "vega":           greeks.get("vega"),
            "rho":            greeks.get("rho"),
            "bs_price":       round(bs_val, 4) if bs_val is not None else None,
        }

    calls_df = chain.calls
    puts_df  = chain.puts

    calls = [_enrich(row, True)  for row in calls_df.to_dict("records")]
    puts  = [_enrich(row, False) for row in puts_df.to_dict("records")]

    expected_move = compute_expected_move(calls, puts, S)

    return {
        "underlying":    round(S, 4),
        "expiry":        expiry,
        "dte":           dte,
        "expected_move": round(expected_move, 4),
        "calls":         calls,
        "puts":          puts,
    }


# ── Expected move (ATM straddle) ─────────────────────────────────────────────

def compute_expected_move(calls: list[dict], puts: list[dict], S: float) -> float:
    """
    Approximate expected move = (ATM call mid + ATM put mid).
    ATM = strike closest to current underlying price.
    """
    if not calls or not puts:
        return 0.0

    def _atm(contracts: list[dict]) -> dict | None:
        return min(contracts, key=lambda c: abs(c["strike"] - S), default=None)

    atm_call = _atm(calls)
    atm_put  = _atm(puts)
    if not atm_call or not atm_put:
        return 0.0

    c_mid = atm_call.get("mid") or 0.0
    p_mid = atm_put.get("mid") or 0.0
    return c_mid + p_mid


# ── Execution fill simulator ─────────────────────────────────────────────────

def simulate_fill(bid: float | None, ask: float | None, action: str) -> float:
    """
    Simulate fill price:
    - BUY  → ask (paying the offer)
    - SELL → bid (hitting the bid)
    Falls back to mid if spread is unavailable.
    """
    if bid is None or ask is None or bid <= 0:
        if ask:
            return float(ask)
        return 0.0
    mid = (float(bid) + float(ask)) / 2.0
    if action.upper() == "BUY":
        return float(ask)
    elif action.upper() == "SELL":
        return float(bid)
    return mid


# ── Scenario P&L table ────────────────────────────────────────────────────────

def scenario_pnl(
    S0: float, K: float, T: float, r: float, sigma: float,
    is_call: bool, action: str, fill_price: float, quantity: int,
    price_range_pct: float = 0.20,
    steps: int = 11,
    days_forward: list[int] | None = None,
) -> list[dict]:
    """
    Build a P&L grid: rows = underlying price, cols = days forward.
    action = 'BUY' or 'SELL'.
    Returns list of {underlying_price, days_forward, option_price, pnl, pnl_pct}.
    """
    if days_forward is None:
        dte_now = T * 365
        days_forward = [0, max(1, int(dte_now * 0.25)), max(1, int(dte_now * 0.5)), max(1, int(dte_now * 0.75)), int(dte_now)]

    lo = S0 * (1 - price_range_pct)
    hi = S0 * (1 + price_range_pct)
    prices = [lo + i * (hi - lo) / (steps - 1) for i in range(steps)]
    sign = 1 if action.upper() == "BUY" else -1

    rows = []
    for df in days_forward:
        T_remaining = max(0.0, T - df / 365.0)
        for sp in prices:
            opt_price = bs_price(sp, K, T_remaining, r, sigma, is_call)
            pnl_per_share = sign * (opt_price - fill_price)
            pnl_total = pnl_per_share * MULTIPLIER * quantity
            rows.append({
                "underlying_price": round(sp, 2),
                "days_forward":     df,
                "option_price":     round(opt_price, 4),
                "pnl":              round(pnl_total, 2),
                "pnl_pct":          round(pnl_per_share / fill_price * 100, 2) if fill_price else 0.0,
            })
    return rows
