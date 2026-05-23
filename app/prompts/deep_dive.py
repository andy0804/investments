# MODEL: sonnet
import json
from app.config import INVESTOR_PROFILE


def build_deep_dive_prompt(symbol: str, technicals: dict, fundamentals: dict,
                            macro: dict, news: list[dict], position: dict = None) -> str:
    return f"""You are a personal investment analyst providing a comprehensive stock analysis.

INVESTOR PROFILE:
- Portfolio: ${INVESTOR_PROFILE['portfolio_size']:,}, balanced risk
- Min hold: {INVESTOR_PROFILE['min_hold_days']} days
- The investor is new to technical analysis — explain everything in plain English

STOCK: {symbol}
{f"CURRENT POSITION: {json.dumps(position, indent=2)}" if position else "NOT CURRENTLY HELD"}

TECHNICAL ANALYSIS:
{json.dumps(technicals, indent=2) if technicals else "Not available"}

FUNDAMENTAL DATA:
{json.dumps(fundamentals, indent=2) if fundamentals else "Not available"}

MACRO CONTEXT:
{json.dumps(macro, indent=2)}

RECENT NEWS (last 7 days):
{json.dumps([n.get('headline', n.get('title', '')) for n in news[:5]], indent=2)}

Provide a thorough analysis with:
1. Plain English explanation of each technical indicator and what it means
2. Fundamental assessment (is it cheap, expensive, growing?)
3. Whether macro conditions support this trade
4. Specific buy/sell/hold recommendation with reasoning
5. Price levels to watch (support, resistance, stop, target)

Respond with valid JSON only:
{{
  "verdict": "strong_buy|buy|hold|sell|strong_sell",
  "confidence": "low|medium|high",
  "score": 1-10,
  "technical_summary": "plain English (3-4 sentences)",
  "fundamental_summary": "plain English (2-3 sentences)",
  "macro_impact": "1-2 sentences",
  "key_levels": {{
    "support": price,
    "resistance": price,
    "stop_loss": price,
    "target_1": price,
    "target_2": price
  }},
  "reasoning": "comprehensive explanation (5-7 sentences)",
  "risks": ["risk 1", "risk 2", "risk 3"],
  "catalysts": ["catalyst 1", "catalyst 2"]
}}"""
