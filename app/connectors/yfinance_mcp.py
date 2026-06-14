"""
yfinance MCP connector — wraps yfinance calls as structured tool functions
the agent pipeline uses for price history, technicals, and sector context.
"""

import logging
import asyncio
from datetime import date, timedelta

import yfinance as yf
import pandas as pd

log = logging.getLogger(__name__)


def _run(fn, *args, **kwargs):
    """Run a sync yfinance call in a thread."""
    return asyncio.to_thread(fn, *args, **kwargs)


def _price_history_sync(ticker: str, period: str = "6mo") -> dict:
    try:
        t = yf.Ticker(ticker)
        hist = t.history(period=period)
        if hist.empty:
            return {}
        close = hist["Close"]
        volume = hist["Volume"]
        now = close.iloc[-1]
        return {
            "current_price":  round(float(now), 4),
            "return_1d":  round((now / close.iloc[-2] - 1) * 100, 2) if len(close) > 1 else 0,
            "return_5d":  round((now / close.iloc[-6] - 1) * 100, 2) if len(close) > 5 else 0,
            "return_10d": round((now / close.iloc[-11] - 1) * 100, 2) if len(close) > 10 else 0,
            "return_30d": round((now / close.iloc[-31] - 1) * 100, 2) if len(close) > 30 else 0,
            "return_90d": round((now / close.iloc[-91] - 1) * 100, 2) if len(close) > 90 else 0,
            "high_52w":   round(float(close.tail(252).max()), 4),
            "low_52w":    round(float(close.tail(252).min()), 4),
            "vol_ratio":  round(float(volume.iloc[-1]) / float(volume.iloc[-21:-1].mean()), 2) if len(volume) > 20 else 1.0,
            "history_dates":  [str(d.date()) for d in hist.index[-30:]],
            "history_closes": [round(float(v), 2) for v in close.tail(30)],
        }
    except Exception as e:
        log.warning("yfinance price history failed %s: %s", ticker, e)
        return {}


def _technicals_sync(ticker: str) -> dict:
    try:
        import ta
        t = yf.Ticker(ticker)
        hist = t.history(period="3mo")
        if hist.empty or len(hist) < 20:
            return {}
        close = hist["Close"]
        rsi = float(ta.momentum.RSIIndicator(close=close, window=14).rsi().iloc[-1])
        macd_ind = ta.trend.MACD(close=close)
        macd_val = float(macd_ind.macd().iloc[-1])
        macd_sig = float(macd_ind.macd_signal().iloc[-1])
        sma20 = float(close.rolling(20).mean().iloc[-1])
        sma50 = float(close.rolling(50).mean().iloc[-1]) if len(close) >= 50 else None
        curr = float(close.iloc[-1])
        return {
            "rsi":        round(rsi, 1),
            "macd":       "bullish" if macd_val > macd_sig else "bearish",
            "above_sma20": curr > sma20,
            "above_sma50": curr > sma50 if sma50 else None,
            "sma20":      round(sma20, 2),
            "sma50":      round(sma50, 2) if sma50 else None,
        }
    except Exception as e:
        log.warning("yfinance technicals failed %s: %s", ticker, e)
        return {}


def _spy_context_sync() -> dict:
    try:
        spy = yf.Ticker("SPY")
        hist = spy.history(period="1mo")
        if hist.empty:
            return {}
        close = hist["Close"]
        now = close.iloc[-1]
        return {
            "spy_price":    round(float(now), 2),
            "spy_return_5d":  round((now / close.iloc[-6] - 1) * 100, 2) if len(close) > 5 else 0,
            "spy_return_10d": round((now / close.iloc[-11] - 1) * 100, 2) if len(close) > 10 else 0,
        }
    except Exception as e:
        log.warning("yfinance SPY context failed: %s", e)
        return {}


async def get_price_history(ticker: str, period: str = "6mo") -> dict:
    return await _run(_price_history_sync, ticker, period)


async def get_technicals(ticker: str) -> dict:
    return await _run(_technicals_sync, ticker)


async def get_spy_context() -> dict:
    return await _run(_spy_context_sync)


async def build_research_brief(ticker: str) -> dict:
    """Aggregate yfinance data for the Research Agent."""
    prices, technicals, spy = await asyncio.gather(
        get_price_history(ticker),
        get_technicals(ticker),
        get_spy_context(),
        return_exceptions=True,
    )

    def _safe(v, default):
        return v if isinstance(v, dict) else default

    return {
        "ticker":      ticker.upper(),
        "source":      "yfinance",
        "prices":      _safe(prices, {}),
        "technicals":  _safe(technicals, {}),
        "spy_context": _safe(spy, {}),
    }
