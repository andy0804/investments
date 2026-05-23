"""
app/analysis/portfolio_intelligence.py

Portfolio Intelligence Engine.

Answers: "What is my capital doing in this market today?"

Computes per-holding:
  - efficiency score (return / volatility proxy)
  - regime alignment (beta in context of BULL/BEAR/CHOP)
  - concentration flag

Computes portfolio-level:
  - sector exposure vs concentration limits
  - performance attribution (top contributors / detractors)
  - opportunity cost (idle or losing capital)

Then calls Haiku for structured action suggestions.
"""

import asyncio
import json
import logging
import os
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, UTC

import aiosqlite
import pandas as pd
import yfinance as yf

from app.config import DB_PATH

warnings.filterwarnings("ignore")
logger = logging.getLogger(__name__)

HAIKU_MODEL = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")

# Sector map for common tickers — avoids per-symbol yfinance .info calls
_KNOWN_SECTORS: dict[str, str] = {
    "AAPL": "Technology", "MSFT": "Technology", "NVDA": "Technology",
    "GOOGL": "Communication Services", "META": "Communication Services",
    "AMZN": "Consumer Cyclical", "TSLA": "Consumer Cyclical",
    "NFLX": "Communication Services", "PLTR": "Technology",
    "APP": "Technology", "AXON": "Technology", "APLD": "Technology",
    "NBIS": "Technology", "CRWV": "Technology", "VRT": "Technology",
    "WMT": "Consumer Defensive", "COST": "Consumer Defensive",
    "ORLY": "Consumer Cyclical", "CMG": "Consumer Cyclical",
    "CAVA": "Consumer Cyclical", "HIMS": "Healthcare",
    "SOFI": "Financial Services", "WDC": "Technology",
    "LLY": "Healthcare", "BRKB": "Financial Services",
    "SPY": "ETF", "QQQ": "ETF", "FNILX": "ETF", "FSPSX": "ETF",
}


# ── DB helpers ────────────────────────────────────────────────────────────────

async def _get_positions() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT symbol, account_name, current_value, cost_basis_total,
                      avg_cost_basis, quantity, total_gain_loss_percent,
                      total_gain_loss_dollar, percent_of_account, position_type
               FROM positions
               WHERE position_type NOT IN ('Cash_MM')
               ORDER BY current_value DESC"""
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def _get_config() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT key, value FROM agent_config") as cur:
            rows = await cur.fetchall()
    return {r[0]: r[1] for r in rows}


async def _get_last_regime() -> str:
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT regime FROM stock_picks ORDER BY pick_date DESC LIMIT 1"
            ) as cur:
                row = await cur.fetchone()
        return row[0] if row and row[0] else "CHOP"
    except Exception:
        return "CHOP"


# ── Market data ───────────────────────────────────────────────────────────────

def _fetch_price_history(symbols: list[str]) -> dict[str, pd.DataFrame]:
    """Download 30d OHLCV for all symbols + SPY in one call."""
    unique = list(dict.fromkeys(symbols + ["SPY"]))
    raw = yf.download(unique, period="30d", auto_adjust=True, progress=False)
    out: dict[str, pd.DataFrame] = {}
    for sym in unique:
        try:
            if isinstance(raw.columns, pd.MultiIndex):
                df = pd.DataFrame({
                    "Close":  raw["Close"][sym],
                    "Volume": raw["Volume"][sym] if sym != "SPY" else raw["Volume"][sym],
                }).dropna()
            else:
                df = raw[["Close", "Volume"]].dropna()
            if len(df) >= 10:
                out[sym] = df
        except Exception:
            pass
    return out


def _fetch_sectors(symbols: list[str]) -> dict[str, str]:
    """Resolve sector for each symbol. Uses known map first, yfinance for unknowns."""
    result = {}
    unknowns = []
    for sym in symbols:
        if sym in _KNOWN_SECTORS:
            result[sym] = _KNOWN_SECTORS[sym]
        else:
            unknowns.append(sym)

    if unknowns:
        def _lookup(sym):
            try:
                info = yf.Ticker(sym).info
                return sym, info.get("sector", "Unknown")
            except Exception:
                return sym, "Unknown"

        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = {pool.submit(_lookup, s): s for s in unknowns}
            for fut in as_completed(futures, timeout=15):
                try:
                    sym, sector = fut.result()
                    result[sym] = sector
                except Exception:
                    result[futures[fut]] = "Unknown"

    return result


# ── Per-holding metrics ───────────────────────────────────────────────────────

def _compute_volatility(df: pd.DataFrame) -> float:
    """Annualized volatility from 30d daily returns (%)."""
    if len(df) < 5:
        return 0.0
    returns = df["Close"].pct_change().dropna()
    return round(float(returns.std() * (252 ** 0.5) * 100), 1)


def _efficiency_score(gain_pct: float, vol: float, regime_aligned: bool) -> float:
    """
    Composite 0–10 score.
    High = strong return with low volatility in an aligned regime.
    """
    score = 5.0
    if gain_pct >= 20:   score += 2.5
    elif gain_pct >= 10: score += 1.5
    elif gain_pct >= 2:  score += 0.5
    elif gain_pct < -5:  score -= 2.0
    elif gain_pct < 0:   score -= 1.0

    if vol < 20:   score += 1.0
    elif vol > 50: score -= 1.5
    elif vol > 35: score -= 0.5

    if regime_aligned: score += 0.5
    else:              score -= 0.5

    return round(max(0.0, min(10.0, score)), 1)


def _regime_alignment(symbol: str, gain_pct: float, vol: float, regime: str) -> str:
    """
    Simple alignment check:
    - BULL: favour growth (high gain% = aligned)
    - BEAR: favour defensives / low-vol (high vol momentum stocks = misaligned)
    - CHOP: everything neutral
    """
    if regime == "BULL":
        return "aligned" if gain_pct > 0 else "lagging"
    if regime == "BEAR":
        return "misaligned" if vol > 40 and gain_pct < 0 else "aligned"
    return "neutral"


# ── Portfolio-level metrics ───────────────────────────────────────────────────

def _sector_exposure(positions: list[dict], sector_map: dict[str, str],
                     total_value: float, max_sector_pct: float) -> list[dict]:
    by_sector: dict[str, float] = {}
    for p in positions:
        sec = sector_map.get(p["symbol"], "Unknown")
        by_sector[sec] = by_sector.get(sec, 0.0) + (p["current_value"] or 0.0)

    result = []
    for sector, value in sorted(by_sector.items(), key=lambda x: -x[1]):
        pct = round(value / total_value * 100, 1) if total_value > 0 else 0.0
        result.append({
            "sector":       sector,
            "value":        round(value, 0),
            "pct":          pct,
            "over_limit":   pct > max_sector_pct,
        })
    return result


def _concentration_risks(positions: list[dict], total_value: float,
                         max_pos_pct: float) -> list[dict]:
    risks = []
    for p in positions:
        pct = round((p["current_value"] or 0) / total_value * 100, 1) if total_value > 0 else 0.0
        if pct > max_pos_pct:
            excess_value = round((pct - max_pos_pct) / 100 * total_value, 0)
            risks.append({
                "symbol":       p["symbol"],
                "pct":          pct,
                "limit":        max_pos_pct,
                "excess_value": excess_value,
            })
    return sorted(risks, key=lambda x: -x["pct"])


# ── LLM Intelligence Agent ────────────────────────────────────────────────────

async def _call_intelligence_agent(payload: dict) -> dict:
    import anthropic
    key = os.getenv("ANTHROPIC_API_KEY", "")
    client = anthropic.AsyncAnthropic(api_key=key)

    prompt = f"""You are a portfolio intelligence analyst. Analyze the portfolio data below.

STRICT RULES:
- Suggest ONLY: "trim", "hold", "review", "watch" — never execution prices or trade amounts
- Base every suggestion on data in the input — no invented signals
- Use only: "data shows", "metrics indicate", "analysis suggests"
- Maximum 4 action suggestions, ranked by priority
- Flag maximum 3 risk items

PORTFOLIO DATA:
{json.dumps(payload, indent=2)}

Return ONLY valid JSON:
{{
  "summary": "2-3 sentences on overall portfolio health vs current market regime",
  "action_suggestions": [
    {{
      "type": "trim | hold | review | watch",
      "symbol": "...",
      "reason": "one sentence citing specific metric values"
    }}
  ],
  "risk_flags": [
    "specific risk with data point"
  ],
  "opportunity_cost_note": "one sentence if capital is inefficiently allocated"
}}"""

    resp = await client.messages.create(
        model=HAIKU_MODEL,
        max_tokens=600,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = resp.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())


# ── Main entry point ──────────────────────────────────────────────────────────

async def generate_portfolio_intelligence() -> dict:
    generated_at = datetime.now(UTC).isoformat()

    positions, cfg, regime = await asyncio.gather(
        _get_positions(),
        _get_config(),
        _get_last_regime(),
    )

    if not positions:
        return {
            "generated_at": generated_at,
            "error": "No positions loaded",
            "regime": regime,
        }

    max_pos_pct    = float(cfg.get("max_single_position_pct", 8.0))
    max_sector_pct = float(cfg.get("max_sector_concentration_pct", 35.0))

    symbols     = [p["symbol"] for p in positions]
    total_value = sum(p["current_value"] or 0 for p in positions)

    # Fetch price history and sectors in parallel threads
    price_hist, sector_map = await asyncio.gather(
        asyncio.to_thread(_fetch_price_history, symbols),
        asyncio.to_thread(_fetch_sectors, symbols),
    )

    spy_df  = price_hist.get("SPY")
    spy_ret = 0.0
    if spy_df is not None and len(spy_df) >= 10:
        spy_ret = round(
            (float(spy_df["Close"].iloc[-1]) / float(spy_df["Close"].iloc[-11]) - 1) * 100, 2
        ) if len(spy_df) >= 11 else 0.0

    # Per-holding metrics
    holdings_detail = []
    for p in positions:
        sym      = p["symbol"]
        df       = price_hist.get(sym)
        vol      = _compute_volatility(df) if df is not None else 0.0
        gain_pct = float(p["total_gain_loss_percent"] or 0)
        sector   = sector_map.get(sym, "Unknown")
        alignment = _regime_alignment(sym, gain_pct, vol, regime)
        eff      = _efficiency_score(gain_pct, vol, alignment == "aligned")

        holdings_detail.append({
            "symbol":             sym,
            "sector":             sector,
            "current_value":      round(p["current_value"] or 0, 0),
            "pct_of_portfolio":   round((p["current_value"] or 0) / total_value * 100, 1) if total_value else 0,
            "total_gain_loss_pct": round(gain_pct, 1),
            "total_gain_loss_dollar": round(p["total_gain_loss_dollar"] or 0, 0),
            "volatility_30d":     vol,
            "efficiency_score":   eff,
            "regime_alignment":   alignment,
        })

    holdings_detail.sort(key=lambda x: -x["efficiency_score"])

    # Portfolio-level
    sector_exposure    = _sector_exposure(positions, sector_map, total_value, max_sector_pct)
    concentration_risks = _concentration_risks(positions, total_value, max_pos_pct)

    sorted_by_pnl = sorted(holdings_detail, key=lambda x: -x["total_gain_loss_dollar"])
    top_contributors = sorted_by_pnl[:3]
    top_detractors   = sorted(holdings_detail, key=lambda x: x["total_gain_loss_dollar"])[:3]

    # Opportunity cost: holdings with negative return while portfolio is in BULL regime
    opportunity_cost = [
        h for h in holdings_detail
        if h["total_gain_loss_pct"] < -2 and regime == "BULL"
    ]

    total_gain_loss = sum(p["total_gain_loss_dollar"] or 0 for p in positions)
    portfolio_return_pct = round(total_gain_loss / (total_value - total_gain_loss) * 100, 1) \
                           if (total_value - total_gain_loss) > 0 else 0.0

    # LLM payload — concise to control token cost
    llm_payload = {
        "regime":            regime,
        "portfolio_value":   round(total_value, 0),
        "portfolio_return_pct": portfolio_return_pct,
        "spy_10d_return":    spy_ret,
        "concentration_risks": [
            {"symbol": r["symbol"], "pct": r["pct"], "limit": r["limit"]}
            for r in concentration_risks
        ],
        "sector_overweights": [
            {"sector": s["sector"], "pct": s["pct"]}
            for s in sector_exposure if s["over_limit"]
        ],
        "low_efficiency_holdings": [
            {"symbol": h["symbol"], "efficiency": h["efficiency_score"],
             "gain_pct": h["total_gain_loss_pct"], "vol": h["volatility_30d"],
             "alignment": h["regime_alignment"]}
            for h in holdings_detail if h["efficiency_score"] < 4.0
        ][:5],
        "top_contributors": [
            {"symbol": h["symbol"], "gain_pct": h["total_gain_loss_pct"]}
            for h in top_contributors
        ],
        "top_detractors": [
            {"symbol": h["symbol"], "gain_pct": h["total_gain_loss_pct"]}
            for h in top_detractors
        ],
    }

    try:
        intelligence = await _call_intelligence_agent(llm_payload)
    except Exception as e:
        logger.error("portfolio intelligence LLM failed: %s", e)
        intelligence = {
            "summary": "Intelligence analysis unavailable.",
            "action_suggestions": [],
            "risk_flags": [],
            "opportunity_cost_note": "",
        }

    return {
        "generated_at":      generated_at,
        "regime":            regime,
        "portfolio_value":   round(total_value, 0),
        "portfolio_return_pct": portfolio_return_pct,
        "spy_10d_return":    spy_ret,
        "sector_exposure":   sector_exposure,
        "concentration_risks": concentration_risks,
        "holdings":          holdings_detail,
        "performance_attribution": {
            "top_contributors": top_contributors,
            "top_detractors":   top_detractors,
            "opportunity_cost": opportunity_cost,
        },
        "intelligence":      intelligence,
    }
