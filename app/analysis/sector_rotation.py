import logging
import yfinance as yf
from datetime import date, timedelta

logger = logging.getLogger(__name__)

SECTOR_ETFS = {
    "Technology": "XLK",
    "Financials": "XLF",
    "Healthcare": "XLV",
    "Consumer Discretionary": "XLY",
    "Communication Services": "XLC",
    "Industrials": "XLI",
    "Consumer Staples": "XLP",
    "Energy": "XLE",
    "Utilities": "XLU",
    "Real Estate": "XLRE",
    "Materials": "XLB",
}


async def get_sector_performance(days_back: int = 30) -> list[dict]:
    results = []
    for sector, etf in SECTOR_ETFS.items():
        try:
            ticker = yf.Ticker(etf)
            hist = ticker.history(period="3mo")
            if hist.empty or len(hist) < 5:
                continue
            latest = hist["Close"].iloc[-1]
            month_ago = hist["Close"].iloc[-min(days_back, len(hist))]
            week_ago = hist["Close"].iloc[-min(5, len(hist))]
            perf_1m = ((latest - month_ago) / month_ago) * 100
            perf_1w = ((latest - week_ago) / week_ago) * 100
            results.append({
                "sector": sector,
                "etf": etf,
                "price": round(latest, 2),
                "perf_1w_pct": round(perf_1w, 2),
                "perf_1m_pct": round(perf_1m, 2),
                "momentum": "leading" if perf_1m > 2 else "lagging" if perf_1m < -2 else "neutral",
            })
        except Exception as e:
            logger.error("sector_rotation failed for %s: %s", etf, e)

    return sorted(results, key=lambda x: x["perf_1m_pct"], reverse=True)
