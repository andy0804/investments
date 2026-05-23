# MODEL: haiku
import json
from app.config import INVESTOR_PROFILE


def build_signal_prompt(symbol: str, technicals: dict, fundamentals: dict, macro: dict,
                        news_headlines: list[str]) -> str:
    return f"""You are a personal investment analyst evaluating a trade signal.

INVESTOR PROFILE:
- Portfolio: ${INVESTOR_PROFILE['portfolio_size']:,}, balanced risk
- Min hold: {INVESTOR_PROFILE['min_hold_days']} days
- Max single position: {INVESTOR_PROFILE['max_single_position_pct']}%

STOCK: {symbol}

TECHNICAL DATA:
{json.dumps(technicals, indent=2)}

FUNDAMENTAL DATA:
{json.dumps(fundamentals, indent=2)}

MACRO CONTEXT:
VIX: {macro.get('vix', 'N/A')} — {macro.get('vix_level', 'unknown')}

RECENT NEWS:
{json.dumps(news_headlines[:5], indent=2)}

Evaluate whether this is a buy, sell, hold, or watch signal.
Score from 1-10 (10 = strongest buy, 1 = strongest sell, 5 = neutral).
Explain in plain English what the technicals and fundamentals mean for a new investor.

Respond with valid JSON only:
{{
  "signal": "buy|sell|hold|watch",
  "score": 1-10,
  "confidence": "low|medium|high",
  "reasoning": "plain English explanation (3-4 sentences)",
  "key_factors": ["factor 1", "factor 2", "factor 3"],
  "risks": ["risk 1", "risk 2"],
  "suggested_action": "specific action for investor"
}}"""
