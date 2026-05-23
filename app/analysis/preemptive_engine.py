# MODEL: sonnet
import logging
import json
from app.analysis.sector_rotation import get_sector_performance
from app.analysis.macro import get_macro_snapshot
from app.connectors.fmp import get_earnings_calendar
from app.connectors.portfolio_csv import get_portfolio_symbols
from app.analysis.claude_engine import call_claude
from app.config import INVESTOR_PROFILE

logger = logging.getLogger(__name__)

MACRO_EVENTS = [
    {"name": "FOMC Meeting", "impact": "Major — affects interest rates and growth stocks"},
    {"name": "CPI Release", "impact": "Major — affects Fed policy expectations"},
    {"name": "Non-Farm Payrolls", "impact": "High — signals economic health"},
    {"name": "GDP Release", "impact": "High — broad economic health indicator"},
    {"name": "PCE Inflation", "impact": "High — Fed's preferred inflation measure"},
]


async def generate_foresight_report() -> dict:
    symbols = await get_portfolio_symbols()
    macro = await get_macro_snapshot()
    sectors = await get_sector_performance(days_back=30)
    earnings = await get_earnings_calendar(days_ahead=28)

    portfolio_earnings = [e for e in earnings if e.get("symbol") in symbols]
    top_sectors = sectors[:3]
    lagging_sectors = [s for s in sectors if s["momentum"] == "lagging"][:2]

    prompt = f"""You are a personal investment analyst providing a 28-day forward-looking foresight report.

INVESTOR PROFILE:
- Portfolio: ${INVESTOR_PROFILE['portfolio_size']:,}, balanced risk
- Holdings: {symbols[:15]}
- Min hold: {INVESTOR_PROFILE['min_hold_days']} days

CURRENT MACRO:
VIX: {macro.get('vix', 'N/A')} — {macro.get('vix_signal', '')}
Regime: {macro.get('market_regime', 'unknown')}

SECTOR MOMENTUM (top performers):
{json.dumps(top_sectors, indent=2)}

LAGGING SECTORS:
{json.dumps(lagging_sectors, indent=2)}

UPCOMING EARNINGS (portfolio holdings, 28 days):
{json.dumps(portfolio_earnings[:10], indent=2)}

MACRO CALENDAR EVENTS TO WATCH:
{json.dumps(MACRO_EVENTS[:3], indent=2)}

Generate a 28-day forward-looking foresight report covering:
1. Key risks to this portfolio in the next 4 weeks
2. Opportunities based on sector rotation
3. Earnings to prepare for
4. Macro events to watch
5. Specific positioning recommendations

Plain English, actionable, new-investor friendly.

Respond with valid JSON only:
{{
  "foresight_headline": "one sentence outlook",
  "outlook": "positive|neutral|cautious|negative",
  "key_risks": ["risk 1", "risk 2", "risk 3"],
  "opportunities": ["opportunity 1", "opportunity 2"],
  "earnings_radar": [{{"symbol": "X", "date": "...", "prep": "..."}}],
  "macro_watches": ["event 1", "event 2"],
  "positioning_advice": "2-3 sentences of specific advice",
  "full_report": "complete foresight text for display"
}}"""

    result = await call_claude(prompt, model="sonnet", job_name="foresight_report")
    return result


async def job_foresight():
    from app.notifications.telegram_bot import send_message
    report = await generate_foresight_report()
    if not report.get("error"):
        msg = (
            f"*Weekly Foresight — 28-Day Outlook*\n"
            f"_{report.get('foresight_headline', '')}_\n\n"
            f"{report.get('positioning_advice', '')[:300]}\n\n"
            f"Reply /brief for today's analysis"
        )[:4096]
        await send_message(msg)
    logger.info("foresight report sent")
