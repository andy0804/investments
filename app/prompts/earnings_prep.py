# MODEL: sonnet
import json
from app.config import INVESTOR_PROFILE


def build_earnings_prep_prompt(symbol: str, earnings_date: str, technicals: dict,
                                fundamentals: dict, historical_moves: list[dict] = None) -> str:
    return f"""You are a personal investment analyst preparing an investor for an upcoming earnings report.

INVESTOR PROFILE:
- Portfolio: ${INVESTOR_PROFILE['portfolio_size']:,}, balanced risk
- Min hold: {INVESTOR_PROFILE['min_hold_days']} days
- New to earnings analysis — explain everything clearly

STOCK: {symbol}
EARNINGS DATE: {earnings_date}

CURRENT TECHNICAL POSITION:
{json.dumps(technicals, indent=2) if technicals else "Not available"}

FUNDAMENTALS:
{json.dumps(fundamentals, indent=2) if fundamentals else "Not available"}

HISTORICAL POST-EARNINGS MOVES:
{json.dumps(historical_moves, indent=2) if historical_moves else "No historical data available"}

Prepare the investor for earnings with:
1. What to expect and watch for
2. Key metrics analysts are focused on
3. Historical context (how has this stock reacted to earnings before?)
4. Pre-earnings positioning advice
5. What to do if earnings beat / miss

Respond with valid JSON only:
{{
  "earnings_date": "{earnings_date}",
  "symbol": "{symbol}",
  "risk_level": "low|medium|high",
  "key_metrics_to_watch": ["metric 1", "metric 2", "metric 3"],
  "historical_context": "1-2 sentences on past earnings reactions",
  "pre_earnings_advice": "specific positioning advice",
  "if_beat": "what to do if earnings beat expectations",
  "if_miss": "what to do if earnings miss expectations",
  "summary": "3-4 sentence earnings prep summary"
}}"""
