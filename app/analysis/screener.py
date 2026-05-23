import logging
from finvizfinance.screener.overview import Overview

logger = logging.getLogger(__name__)


def screen_stocks(filters: dict = None) -> list[dict]:
    default_filters = {
        "Market Cap.": "+Mid (over $2bln)",
        "Country": "USA",
        "Average Volume": "Over 500K",
    }
    active_filters = {**default_filters, **(filters or {})}

    try:
        fov = Overview()
        fov.set_filter(filters_dict=active_filters)
        df = fov.screener_view()
        if df is None or df.empty:
            return []
        return df.to_dict(orient="records")
    except Exception as e:
        logger.error("screener failed: %s", e)
        return []


def screen_momentum() -> list[dict]:
    return screen_stocks({
        "Performance": "Week +10%",
        "RSI (14)": "Not Overbought (<60)",
        "Average Volume": "Over 1M",
    })


def screen_oversold() -> list[dict]:
    return screen_stocks({
        "RSI (14)": "Oversold (30)",
        "Market Cap.": "+Large (over $10bln)",
    })


def screen_earnings_movers() -> list[dict]:
    return screen_stocks({
        "EPS growththis year": "Positive (>0%)",
        "EPS growthnext year": "Positive (>0%)",
        "Market Cap.": "+Mid (over $2bln)",
    })
