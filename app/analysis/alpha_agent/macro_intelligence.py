"""
Macro Intelligence Layer — runs between Pass 1 and Pass 2.

Groups promoted stocks by sector, detects coordinated moves,
generates market narrative + regime classification via 1 Haiku call.

Cost: ~$0.001 per scan cycle (1 Haiku call regardless of stock count).
"""

import os, json, logging
import aiosqlite
import anthropic
from datetime import datetime, UTC

from app.config import DB_PATH
from app.analysis.alpha_agent import cost_tracker

log = logging.getLogger(__name__)
MODEL = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")

# Static sector map — covers ~90% of S&P 500 universe without a yfinance call
_SECTOR_CACHE: dict[str, str] = {
    "LRCX": "Semiconductor Equipment", "AMAT": "Semiconductor Equipment",
    "KLAC": "Semiconductor Equipment", "ASML": "Semiconductor Equipment",
    "NVDA": "Semiconductors", "AMD": "Semiconductors", "INTC": "Semiconductors",
    "QCOM": "Semiconductors", "AVGO": "Semiconductors", "MU": "Semiconductors",
    "TXN": "Semiconductors", "ADI": "Semiconductors", "MRVL": "Semiconductors",
    "SMCI": "Semiconductors", "ON": "Semiconductors", "MPWR": "Semiconductors",
    "UAL": "Airlines", "DAL": "Airlines", "LUV": "Airlines", "AAL": "Airlines",
    "JBLU": "Airlines", "ALK": "Airlines",
    "BKNG": "Travel & Leisure", "EXPE": "Travel & Leisure", "ABNB": "Travel & Leisure",
    "MAR": "Hotels", "HLT": "Hotels", "H": "Hotels", "IHG": "Hotels",
    "ETN": "Industrials", "HON": "Industrials", "GE": "Industrials",
    "BA": "Aerospace & Defense", "LMT": "Aerospace & Defense", "RTX": "Aerospace & Defense",
    "CAT": "Industrials", "DE": "Industrials", "EMR": "Industrials",
    "PH": "Industrials", "ROK": "Industrials", "ITW": "Industrials",
    "NIO": "Chinese EV", "XPEV": "Chinese EV", "LI": "Chinese EV",
    "BIDU": "Chinese Tech", "JD": "Chinese Tech", "BABA": "Chinese Tech",
    "XOM": "Energy", "CVX": "Energy", "SLB": "Oil Services",
    "EOG": "Energy", "PXD": "Energy", "COP": "Energy", "OXY": "Energy",
    "GS": "Financials", "JPM": "Financials", "MS": "Financials",
    "AXP": "Financials", "BAC": "Financials", "C": "Financials", "WFC": "Financials",
    "V": "Payments", "MA": "Payments",
    "PYPL": "Fintech", "AFRM": "Fintech", "SQ": "Fintech",
    "GOOGL": "Mega-Cap Tech", "GOOG": "Mega-Cap Tech", "META": "Social Media",
    "AMZN": "E-Commerce", "AAPL": "Mega-Cap Tech", "MSFT": "Mega-Cap Tech",
    "NFLX": "Streaming", "DIS": "Media", "FOX": "Media", "PARA": "Media",
    "FSLR": "Clean Energy", "ENPH": "Clean Energy", "BE": "Clean Energy",
    "PLUG": "Clean Energy", "SEDG": "Clean Energy",
    "JNJ": "Healthcare", "PFE": "Pharma", "MRNA": "Biotech",
    "ABBV": "Pharma", "LLY": "Pharma", "BMY": "Pharma", "GILD": "Biotech",
    "TGT": "Retail", "WMT": "Retail", "COST": "Retail", "HD": "Retail",
    "SNAP": "Social Media", "PINS": "Social Media",
    "CME": "Exchanges", "ICE": "Exchanges", "CBOE": "Exchanges",
    "TSLA": "EV / Auto", "F": "Auto", "GM": "Auto",
    "CRM": "Enterprise Software", "ORCL": "Enterprise Software", "SAP": "Enterprise Software",
    "UBER": "Gig Economy", "LYFT": "Gig Economy", "DASH": "Gig Economy",
    "ZM": "SaaS / Remote Work", "DOCU": "SaaS", "TWLO": "SaaS",
}


def _get_sector(ticker: str) -> str:
    """Return sector for ticker from static map, yfinance fallback."""
    if ticker in _SECTOR_CACHE:
        return _SECTOR_CACHE[ticker]
    try:
        import yfinance as yf
        info = yf.Ticker(ticker).fast_info
        sector = getattr(info, "sector", None) or "Unknown"
        _SECTOR_CACHE[ticker] = sector
        return sector
    except Exception:
        return "Unknown"


def _group_by_sector(promoted: list[dict]) -> dict:
    """Groups promoted stocks by sector."""
    groups: dict[str, dict] = {}
    for stock in promoted:
        sector = stock.get("sector") or _get_sector(stock["ticker"])
        stock["sector"] = sector
        if sector not in groups:
            groups[sector] = {"up": [], "down": []}
        if stock.get("price_move", 0) > 0:
            groups[sector]["up"].append(stock)
        else:
            groups[sector]["down"].append(stock)
    return groups


def _build_themes(groups: dict) -> list[dict]:
    themes = []
    for sector, g in groups.items():
        if g["up"]:
            avg = sum(s["price_move"] for s in g["up"]) / len(g["up"])
            themes.append({
                "sector": sector, "direction": "UP",
                "stocks": [s["ticker"] for s in g["up"]],
                "avg_move": round(avg, 1),
            })
        if g["down"]:
            avg = sum(s["price_move"] for s in g["down"]) / len(g["down"])
            themes.append({
                "sector": sector, "direction": "DOWN",
                "stocks": [s["ticker"] for s in g["down"]],
                "avg_move": round(avg, 1),
            })
    themes.sort(key=lambda t: abs(t["avg_move"]), reverse=True)
    return themes


def _infer_regime_heuristic(up_sectors: list, down_sectors: list, promoted: list) -> dict:
    """Fallback when Haiku call fails."""
    if len(up_sectors) >= 3:
        return {
            "regime": "EVENT_DRIVEN",
            "narrative": f"{len(up_sectors)} sectors moving up together — possible macro catalyst.",
            "confidence": 60,
            "primary_theme": "Broad Sector Rally",
            "sectors_leading_up": up_sectors,
            "sectors_leading_down": down_sectors,
            "reasoning": "Heuristic: multiple sectors coordinated up",
        }
    if len(down_sectors) >= 3:
        return {
            "regime": "RISK_OFF",
            "narrative": f"{len(down_sectors)} sectors selling off — possible risk-off event.",
            "confidence": 60,
            "primary_theme": "Risk-Off Rotation",
            "sectors_leading_up": up_sectors,
            "sectors_leading_down": down_sectors,
            "reasoning": "Heuristic: multiple sectors coordinated down",
        }
    return {
        "regime": "NORMAL",
        "narrative": "Mixed moves, no clear macro theme detected.",
        "confidence": 50,
        "primary_theme": "Mixed Market",
        "sectors_leading_up": up_sectors,
        "sectors_leading_down": down_sectors,
        "reasoning": "Heuristic: no strong coordination detected",
    }


async def analyze_market_narrative(promoted_stocks: list[dict]) -> dict:
    """
    Analyzes promoted stocks to generate market narrative and regime.
    promoted_stocks: list of {ticker, price_move, vol_ratio, ...}
    Returns narrative dict. Always writes to DB.
    """
    if not promoted_stocks:
        result = {
            "regime": "NORMAL",
            "narrative": "No significant moves detected in universe scan.",
            "confidence": 50,
            "primary_theme": "No Activity",
            "sectors_leading_up": [],
            "sectors_leading_down": [],
            "reasoning": "No stocks promoted from universe.",
            "themes": [],
            "promoted_count": 0,
        }
        await _save_narrative(result)
        return result

    groups = _group_by_sector(promoted_stocks)
    up_sectors = [s for s, g in groups.items() if len(g["up"]) >= 2]
    down_sectors = [s for s, g in groups.items() if len(g["down"]) >= 2]
    coordinated = len(up_sectors) >= 3 or len(down_sectors) >= 3

    sector_lines = []
    for sector, g in groups.items():
        if g["up"]:
            avg = sum(s["price_move"] for s in g["up"]) / len(g["up"])
            sector_lines.append(f"  {sector}: {len(g['up'])} UP avg {avg:+.1f}%")
        if g["down"]:
            avg = sum(s["price_move"] for s in g["down"]) / len(g["down"])
            sector_lines.append(f"  {sector}: {len(g['down'])} DOWN avg {avg:+.1f}%")

    ticker_summary = [
        {"ticker": s["ticker"], "move": f"{s['price_move']:+.1f}%", "sector": s.get("sector", "?")}
        for s in promoted_stocks
    ]

    prompt = f"""You are a market intelligence analyst. Analyze sector moves and classify the market regime.

PROMOTED STOCKS (>3% move or >3x volume today):
{json.dumps(ticker_summary, indent=2)[:1000]}

SECTOR GROUPINGS:
{chr(10).join(sector_lines)}

Coordination: {coordinated} ({len(up_sectors)} sectors up together, {len(down_sectors)} sectors down together)

Choose ONE regime:
- RISK_ON: broad rally, cyclicals leading, calm conditions
- EVENT_DRIVEN: specific macro event driving coordinated sector moves (trade deal, Fed decision, geopolitical)
- NORMAL: mixed moves, individual stock stories, no clear theme
- RISK_OFF: defensive rotation, selling cyclicals
- CRISIS: panic conditions, broad selling

Return ONLY valid JSON (no markdown):
{{"regime": "EVENT_DRIVEN", "narrative": "One sentence market story", "confidence": 75, "primary_theme": "Short label like US-China Trade Optimism", "sectors_leading_up": ["Semiconductors", "Airlines"], "sectors_leading_down": ["Chinese EV"], "reasoning": "One sentence why"}}"""

    client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
    try:
        response = await client.messages.create(
            model=MODEL, max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text.strip()
        # Strip markdown code fences if present
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        await cost_tracker.log_call(
            "macro_intelligence", MODEL,
            response.usage.input_tokens, response.usage.output_tokens, None,
        )
        result = json.loads(text.strip())
    except Exception as e:
        log.warning("macro_intelligence: Haiku call failed: %s", e)
        result = _infer_regime_heuristic(up_sectors, down_sectors, promoted_stocks)

    result["themes"] = _build_themes(groups)
    result["promoted_count"] = len(promoted_stocks)
    result.setdefault("sectors_leading_up", up_sectors)
    result.setdefault("sectors_leading_down", down_sectors)

    await _save_narrative(result)
    log.info("macro_intelligence: regime=%s theme=%s confidence=%s",
             result.get("regime"), result.get("primary_theme"), result.get("confidence"))
    return result


async def _save_narrative(data: dict) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """INSERT INTO alpha_agent_market_narrative
               (scan_at, regime, theme, confidence, narrative, themes_json, promoted_count)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                datetime.now(UTC).isoformat(),
                data.get("regime"),
                data.get("primary_theme"),
                data.get("confidence"),
                data.get("narrative"),
                json.dumps(data.get("themes", [])),
                data.get("promoted_count", 0),
            ),
        ) as cur:
            row_id = cur.lastrowid
        await db.commit()
    return row_id


async def get_latest_narrative() -> dict | None:
    """Returns the most recent market narrative from DB."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_market_narrative ORDER BY scan_at DESC LIMIT 1"
        ) as cur:
            row = await cur.fetchone()
    if not row:
        return None
    data = dict(row)
    data["themes"] = json.loads(data.get("themes_json") or "[]")
    return data
