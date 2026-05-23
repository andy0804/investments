import logging
import pandas as pd
import ta
import yfinance as yf
from app.connectors.fmp import get_historical_prices

logger = logging.getLogger(__name__)


async def compute_technicals(symbol: str) -> dict | None:
    try:
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period="6mo")
        if hist.empty or len(hist) < 30:
            return None

        close = hist["Close"]
        volume = hist["Volume"]

        rsi = ta.momentum.RSIIndicator(close=close, window=14).rsi().iloc[-1]
        macd_ind = ta.trend.MACD(close=close)
        macd = macd_ind.macd().iloc[-1]
        macd_signal = macd_ind.macd_signal().iloc[-1]
        macd_hist = macd_ind.macd_diff().iloc[-1]
        bb = ta.volatility.BollingerBands(close=close, window=20, window_dev=2)
        bb_upper = bb.bollinger_hband().iloc[-1]
        bb_lower = bb.bollinger_lband().iloc[-1]
        bb_mid = bb.bollinger_mavg().iloc[-1]
        sma_50 = close.rolling(50).mean().iloc[-1]
        sma_200 = close.rolling(200).mean().iloc[-1] if len(close) >= 200 else None
        avg_volume_20 = volume.rolling(20).mean().iloc[-1]
        current_volume = volume.iloc[-1]
        volume_ratio = current_volume / avg_volume_20 if avg_volume_20 > 0 else 1.0
        current_price = close.iloc[-1]

        return {
            "symbol": symbol,
            "price": round(current_price, 2),
            "rsi": round(rsi, 2),
            "rsi_signal": _rsi_signal(rsi),
            "macd": round(macd, 4),
            "macd_signal_line": round(macd_signal, 4),
            "macd_histogram": round(macd_hist, 4),
            "macd_crossover": "bullish" if macd > macd_signal else "bearish",
            "bb_upper": round(bb_upper, 2),
            "bb_lower": round(bb_lower, 2),
            "bb_mid": round(bb_mid, 2),
            "bb_position": _bb_position(current_price, bb_upper, bb_lower, bb_mid),
            "sma_50": round(sma_50, 2) if pd.notna(sma_50) else None,
            "sma_200": round(sma_200, 2) if sma_200 and pd.notna(sma_200) else None,
            "above_sma_50": current_price > sma_50,
            "volume_ratio": round(volume_ratio, 2),
            "volume_signal": _volume_signal(volume_ratio),
        }
    except Exception as e:
        logger.error("compute_technicals failed for %s: %s", symbol, e)
        return None


def _rsi_signal(rsi: float) -> str:
    if rsi < 30:
        return "Oversold — stock has been sold heavily, may bounce"
    if rsi < 45:
        return "Recovering — selling pressure easing"
    if rsi < 55:
        return "Neutral — no strong momentum either way"
    if rsi < 70:
        return "Bullish — buying momentum building"
    return "Overbought — strong run, watch for pullback"


def _bb_position(price: float, upper: float, lower: float, mid: float) -> str:
    if price >= upper:
        return "At upper band — trading at upper range, watch for reversal"
    if price <= lower:
        return "At lower band — potential bounce zone"
    if price > mid:
        return "Above midline — mild upward bias"
    return "Below midline — mild downward bias"


def _volume_signal(ratio: float) -> str:
    if ratio < 0.5:
        return "Very light trading — low conviction move"
    if ratio < 1.0:
        return "Normal volume"
    if ratio < 2.0:
        return "Above-average interest"
    return "High conviction move — institutional activity likely"
