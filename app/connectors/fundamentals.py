"""
app/connectors/fundamentals.py

Fetches fundamental financial data from Alpha Vantage and Finnhub.
Returns normalized quarterly data + a list of any fetch errors.
"""
import asyncio
import logging
import os
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

AV_KEY      = os.getenv("ALPHA_VANTAGE_KEY", "")
FINNHUB_KEY = os.getenv("FINNHUB_API_KEY", "")
AV_BASE     = "https://www.alphavantage.co/query"
FH_BASE     = "https://finnhub.io/api/v1"

_TIMEOUT = 12.0


def _safe_float(val, default=None):
    try:
        f = float(val)
        return f if f != 0.0 else default
    except (TypeError, ValueError):
        return default


async def _av_get(func: str, symbol: str) -> tuple[Optional[dict], Optional[str]]:
    """Single Alpha Vantage call. Returns (data, error_str)."""
    if not AV_KEY:
        return None, "ALPHA_VANTAGE_KEY not set"
    url = f"{AV_BASE}?function={func}&symbol={symbol}&apikey={AV_KEY}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(url)
            r.raise_for_status()
            data = r.json()
            if "Note" in data:
                return None, f"AV rate limit ({func})"
            if "Information" in data:
                return None, f"AV rate limit — 25 req/day exceeded ({func})"
            if "Error Message" in data:
                return None, f"AV no data for {symbol} ({func})"
            return data, None
    except httpx.TimeoutException:
        return None, f"AV timeout ({func})"
    except Exception as e:
        return None, f"AV error ({func}): {str(e)[:60]}"


async def _fh_get(path: str, params: dict) -> tuple[Optional[dict], Optional[str]]:
    """Single Finnhub call. Returns (data, error_str)."""
    if not FINNHUB_KEY:
        return None, "FINNHUB_API_KEY not set"
    params["token"] = FINNHUB_KEY
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(f"{FH_BASE}{path}", params=params)
            r.raise_for_status()
            data = r.json()
            return data, None
    except httpx.TimeoutException:
        return None, f"Finnhub timeout ({path})"
    except Exception as e:
        return None, f"Finnhub error ({path}): {str(e)[:60]}"


def _parse_income(data: dict, n: int) -> list[dict]:
    """Extract n most-recent quarterly income statement rows."""
    rows = []
    for q in (data.get("quarterlyReports") or [])[:n]:
        rows.append({
            "period":            q.get("fiscalDateEnding", ""),
            "revenue":           _safe_float(q.get("totalRevenue")),
            "gross_profit":      _safe_float(q.get("grossProfit")),
            "net_income":        _safe_float(q.get("netIncome")),
            "operating_income":  _safe_float(q.get("operatingIncome")),
            "ebitda":            _safe_float(q.get("ebitda")),
        })
    return rows


def _parse_earnings(data: dict, n: int) -> list[dict]:
    """Extract n most-recent quarterly earnings rows (EPS + beat/miss)."""
    rows = []
    for q in (data.get("quarterlyEarnings") or [])[:n]:
        reported  = _safe_float(q.get("reportedEPS"))
        estimated = _safe_float(q.get("estimatedEPS"))
        surprise_pct = _safe_float(q.get("surprisePercentage"))
        rows.append({
            "period":        q.get("fiscalDateEnding", ""),
            "eps_reported":  reported,
            "eps_estimated": estimated,
            "surprise_pct":  surprise_pct,
            "beat":          (surprise_pct or 0) > 0,
        })
    return rows


def _parse_balance(data: dict) -> Optional[dict]:
    """Extract latest quarterly balance sheet row."""
    q = (data.get("quarterlyReports") or [{}])[0]
    debt   = _safe_float(q.get("totalDebt")) or _safe_float(q.get("longTermDebtNoncurrent"))
    equity = _safe_float(q.get("totalShareholderEquity"))
    return {
        "period":               q.get("fiscalDateEnding", ""),
        "total_debt":           debt,
        "total_equity":         equity,
        "de_ratio":             round(debt / equity, 2) if debt and equity else None,
    }


def _parse_cashflow(data: dict, n: int) -> list[dict]:
    """Extract n most-recent quarterly cash flow rows."""
    rows = []
    for q in (data.get("quarterlyReports") or [])[:n]:
        ocf  = _safe_float(q.get("operatingCashflow"))
        capex = _safe_float(q.get("capitalExpenditures"))
        fcf  = None
        if ocf is not None and capex is not None:
            fcf = ocf + capex  # capex is already negative in AV data
        elif ocf is not None:
            fcf = ocf
        rows.append({
            "period": q.get("fiscalDateEnding", ""),
            "ocf":    ocf,
            "capex":  capex,
            "fcf":    fcf,
        })
    return rows


def _yf_get_financials(symbol: str) -> tuple[list, list, list, Optional[dict], list]:
    """
    yfinance fallback for quarterly income, earnings, cashflow, balance.
    Returns (income_rows, earnings_rows, cf_rows, balance, errors).
    """
    import yfinance as yf
    import warnings, pandas as pd
    warnings.filterwarnings("ignore")
    errors = []

    try:
        ticker = yf.Ticker(symbol)

        income_rows   = []
        earnings_rows = []
        cf_rows       = []
        balance       = None

        # Income statement
        try:
            inc = ticker.quarterly_income_stmt
            if inc is not None and not inc.empty:
                for col in inc.columns[:12]:
                    period = str(col.date()) if hasattr(col, 'date') else str(col)[:10]
                    income_rows.append({
                        "period":           period,
                        "revenue":          _safe_float(inc.get("Total Revenue", {}).get(col)),
                        "gross_profit":     _safe_float(inc.get("Gross Profit", {}).get(col)),
                        "net_income":       _safe_float(inc.get("Net Income", {}).get(col)),
                        "operating_income": _safe_float(inc.get("Operating Income", {}).get(col)),
                        "ebitda":           _safe_float(inc.get("EBITDA", {}).get(col)),
                    })
        except Exception as e:
            errors.append(f"yfinance income_stmt: {str(e)[:60]}")

        # Cash flow
        try:
            cf = ticker.quarterly_cashflow
            if cf is not None and not cf.empty:
                for col in cf.columns[:12]:
                    period = str(col.date()) if hasattr(col, 'date') else str(col)[:10]
                    ocf   = _safe_float(cf.get("Operating Cash Flow", {}).get(col)
                                        or cf.get("Cash From Operations", {}).get(col))
                    capex = _safe_float(cf.get("Capital Expenditure", {}).get(col))
                    fcf   = ocf + capex if ocf is not None and capex is not None else ocf
                    cf_rows.append({"period": period, "ocf": ocf, "capex": capex, "fcf": fcf})
        except Exception as e:
            errors.append(f"yfinance cashflow: {str(e)[:60]}")

        # Balance sheet
        try:
            bs = ticker.quarterly_balance_sheet
            if bs is not None and not bs.empty:
                col    = bs.columns[0]
                period = str(col.date()) if hasattr(col, 'date') else str(col)[:10]
                debt   = _safe_float(bs.get("Total Debt", {}).get(col)
                                     or bs.get("Long Term Debt", {}).get(col))
                equity = _safe_float(bs.get("Stockholders Equity", {}).get(col)
                                     or bs.get("Common Stock Equity", {}).get(col))
                balance = {
                    "period":       period,
                    "total_debt":   debt,
                    "total_equity": equity,
                    "de_ratio":     round(debt / equity, 2) if debt and equity else None,
                }
        except Exception as e:
            errors.append(f"yfinance balance_sheet: {str(e)[:60]}")

        # EPS from earnings history
        try:
            eh = ticker.earnings_history
            if eh is not None and not eh.empty:
                for _, row in eh.head(12).iterrows():
                    period = str(row.get("Date", ""))[:10] if "Date" in row else ""
                    reported  = _safe_float(row.get("epsActual"))
                    estimated = _safe_float(row.get("epsEstimate"))
                    sp        = round((reported - estimated) / abs(estimated) * 100, 2) if reported and estimated and estimated != 0 else None
                    earnings_rows.append({
                        "period":        period,
                        "eps_reported":  reported,
                        "eps_estimated": estimated,
                        "surprise_pct":  sp,
                        "beat":          (sp or 0) > 0,
                    })
        except Exception:
            pass  # Non-critical — will fall back to no EPS beat/miss data

        return income_rows, earnings_rows, cf_rows, balance, errors

    except Exception as e:
        return [], [], [], None, [f"yfinance fallback failed: {str(e)[:80]}"]


def _merge_quarters(income: list, earnings: list, cashflow: list, n: int) -> list[dict]:
    """Merge income + earnings + cashflow by period into unified quarter objects."""
    eps_by_period    = {r["period"]: r for r in earnings}
    cf_by_period     = {r["period"]: r for r in cashflow}

    merged = []
    for row in income[:n]:
        p = row["period"]
        eps_row = eps_by_period.get(p, {})
        cf_row  = cf_by_period.get(p, {})

        rev  = row["revenue"]
        gp   = row["gross_profit"]
        ni   = row["net_income"]
        oi   = row["operating_income"]

        gross_margin   = round(gp / rev * 100, 1) if gp and rev else None
        net_margin     = round(ni / rev * 100, 1) if ni and rev else None
        op_margin      = round(oi / rev * 100, 1) if oi and rev else None

        merged.append({
            "period":        p,
            "revenue":       rev,
            "gross_profit":  gp,
            "net_income":    ni,
            "operating_income": oi,
            "gross_margin":  gross_margin,
            "net_margin":    net_margin,
            "op_margin":     op_margin,
            "fcf":           cf_row.get("fcf"),
            "eps":           eps_row.get("eps_reported"),
            "eps_estimated": eps_row.get("eps_estimated"),
            "eps_beat":      eps_row.get("beat"),
            "eps_surprise_pct": eps_row.get("surprise_pct"),
        })

    # Compute YoY growth (current vs same quarter 4 periods ago)
    for i, q in enumerate(merged):
        yoy_idx = i + 4
        if yoy_idx < len(merged):
            prev = merged[yoy_idx]
            if q["revenue"] and prev["revenue"]:
                q["revenue_yoy_pct"] = round((q["revenue"] - prev["revenue"]) / abs(prev["revenue"]) * 100, 1)
            if q["net_income"] and prev["net_income"] and prev["net_income"] != 0:
                q["ni_yoy_pct"] = round((q["net_income"] - prev["net_income"]) / abs(prev["net_income"]) * 100, 1)
            if q["eps"] and prev["eps"] and prev["eps"] != 0:
                q["eps_yoy_pct"] = round((q["eps"] - prev["eps"]) / abs(prev["eps"]) * 100, 1)

    return merged[:n]


async def fetch_fundamentals(symbol: str, quarters: int = 8) -> dict:
    """
    Fetch all fundamental data for a symbol.
    Returns: { quarters: [...], balance: {...}, finnhub: {...}, errors: [...] }
    Fetches 8 quarters of data so both 4Q and 8Q views are served from one cache entry.
    """
    errors: list[str] = []

    # AV free tier: 1 req/sec burst limit — call sequentially with 1s gaps.
    # Finnhub has no such limit, so run it in parallel with the AV sequence.
    async def _av_sequential(sym: str):
        results = []
        for func in ["INCOME_STATEMENT", "EARNINGS", "BALANCE_SHEET", "CASH_FLOW"]:
            results.append(await _av_get(func, sym))
            await asyncio.sleep(1.1)
        return results

    (av_results, fh_results) = await asyncio.gather(
        _av_sequential(symbol),
        asyncio.gather(
            _fh_get("/stock/metric",   {"symbol": symbol, "metric": "all"}),
            _fh_get("/stock/earnings", {"symbol": symbol}),
        ),
    )
    (income_data, inc_err), (earn_data, earn_err), (bal_data, bal_err), (cf_data, cf_err) = av_results
    (fh_metric, fh_metric_err), (fh_earn, fh_earn_err) = fh_results

    for e in [inc_err, earn_err, bal_err, cf_err, fh_metric_err, fh_earn_err]:
        if e:
            errors.append(e)

    # Parse what we have from AV
    income_rows   = _parse_income(income_data, 12)   if income_data else []
    earnings_rows = _parse_earnings(earn_data, 12)   if earn_data  else []
    cf_rows       = _parse_cashflow(cf_data, 12)     if cf_data    else []
    balance       = _parse_balance(bal_data)          if bal_data   else None

    # yfinance fallback when AV is rate-limited or missing data
    av_missing = not income_rows or not cf_rows or balance is None
    if av_missing:
        logger.info("fundamentals[%s]: AV incomplete — trying yfinance fallback", symbol)
        yf_income, yf_earnings, yf_cf, yf_balance, yf_errors = \
            await asyncio.get_event_loop().run_in_executor(None, _yf_get_financials, symbol)
        errors.extend(yf_errors)
        if not income_rows and yf_income:
            income_rows = yf_income
            logger.info("fundamentals[%s]: yfinance supplied %d income rows", symbol, len(income_rows))
        if not cf_rows and yf_cf:
            cf_rows = yf_cf
        if balance is None and yf_balance:
            balance = yf_balance
        if not earnings_rows and yf_earnings:
            earnings_rows = yf_earnings

    # Try Finnhub earnings as fallback for EPS if still missing
    # Finnhub earnings may return a list directly or {"data": [...]}
    fh_earn_list = fh_earn if isinstance(fh_earn, list) else (fh_earn or {}).get("data") or []
    if not earnings_rows and fh_earn_list:
        for q in fh_earn_list[:12]:
            earnings_rows.append({
                "period":        q.get("period", ""),
                "eps_reported":  _safe_float(q.get("actual")),
                "eps_estimated": _safe_float(q.get("estimate")),
                "surprise_pct":  _safe_float(q.get("surprisePercent")),
                "beat":          (_safe_float(q.get("surprisePercent")) or 0) > 0,
            })

    quarterly = _merge_quarters(income_rows, earnings_rows, cf_rows, 8)

    # Finnhub metric fields
    fh = {}
    if fh_metric:
        m = fh_metric.get("metric", {})
        def _pct(v):
            """Finnhub returns some metrics as whole % (10.07 = 10.07%), others as decimals."""
            f = _safe_float(v)
            if f is None: return None
            # If value looks like it's already a whole %, keep it; otherwise scale
            # Finnhub growth metrics are already whole percentages
            return round(f, 2)

        fh = {
            "pe_ttm":             _safe_float(m.get("peExclExtraTTM") or m.get("peTTM")),
            "market_cap_usd":     _safe_float(m.get("marketCapitalization")),
            "revenue_growth_yoy": _pct(m.get("revenueGrowthTTMYoy")),
            "eps_growth_yoy":     _pct(m.get("epsGrowthTTMYoy")),
            "net_margin_ttm":     _pct(m.get("netMarginTTM")),
            "52w_high":           _safe_float(m.get("52WeekHigh")),
            "52w_low":            _safe_float(m.get("52WeekLow")),
            "roa_ttm":            _pct(m.get("roaTTM")),
            "roe_ttm":            _pct(m.get("roeTTM")),
        }

    logger.info("fundamentals[%s]: %d quarters, %d errors", symbol, len(quarterly), len(errors))

    return {
        "symbol":    symbol,
        "quarterly": quarterly,
        "balance":   balance,
        "finnhub":   fh,
        "errors":    errors,
    }
