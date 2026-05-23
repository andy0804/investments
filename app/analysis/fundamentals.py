import logging
from app.connectors.fmp import get_company_profile, get_income_statement

logger = logging.getLogger(__name__)


async def get_fundamentals(symbol: str) -> dict | None:
    try:
        profile = await get_company_profile(symbol)
        if not profile:
            return None

        try:
            income = await get_income_statement(symbol, limit=2)
        except Exception as ie:
            logger.warning("income statement unavailable for %s: %s", symbol, ie)
            income = None

        pe = profile.get("pe", None)
        eps = profile.get("eps", None)
        market_cap = profile.get("mktCap", None)
        sector = profile.get("sector", "Unknown")
        industry = profile.get("industry", "Unknown")
        beta = profile.get("beta", None)
        div_yield = profile.get("lastDiv", 0)

        eps_growth = None
        if income and len(income) >= 2:
            eps_curr = income[0].get("eps", None)
            eps_prev = income[1].get("eps", None)
            if eps_curr and eps_prev and eps_prev != 0:
                eps_growth = round(((eps_curr - eps_prev) / abs(eps_prev)) * 100, 2)

        return {
            "symbol": symbol,
            "sector": sector,
            "industry": industry,
            "pe_ratio": round(pe, 2) if pe else None,
            "pe_signal": _pe_signal(pe),
            "eps": eps,
            "eps_growth_pct": eps_growth,
            "market_cap": market_cap,
            "beta": round(beta, 2) if beta else None,
            "beta_signal": _beta_signal(beta),
            "dividend_yield": round(div_yield, 4) if div_yield else 0,
        }
    except Exception as e:
        logger.error("get_fundamentals failed for %s: %s", symbol, e)
        return None


def _pe_signal(pe) -> str:
    if not pe:
        return "P/E not available"
    if pe < 0:
        return "Negative earnings — company not yet profitable"
    if pe < 15:
        return "Potentially undervalued relative to market average"
    if pe < 25:
        return "Fairly valued — in line with market average"
    if pe < 40:
        return "Premium valuation — market expects strong growth"
    return "High valuation — growth expectations are very high"


def _beta_signal(beta) -> str:
    if not beta:
        return "Beta not available"
    if beta < 0.5:
        return "Low volatility — moves less than the market"
    if beta < 1.0:
        return "Below-average volatility"
    if beta < 1.5:
        return "Slightly more volatile than the market"
    return "High volatility — amplifies market moves significantly"
