# MODEL: haiku
import json
from app.config import INVESTOR_PROFILE


def build_event_alert_prompt(event: dict, affected_symbols: list[str], macro: dict) -> str:
    return f"""You are a personal investment analyst assessing the impact of a news event.

INVESTOR PROFILE:
- Portfolio: ${INVESTOR_PROFILE['portfolio_size']:,}, balanced risk
- Holdings potentially affected: {affected_symbols}

EVENT:
Title: {event.get('title', 'Unknown')}
Source: {event.get('source', 'Unknown')}
Sentiment tone: {event.get('tone', 0)} (positive = good news, negative = bad news)

MACRO CONTEXT:
VIX: {macro.get('vix', 'N/A')} — {macro.get('vix_level', 'unknown')}

Assess the impact of this event on the investor's portfolio.
Focus on what a new investor needs to know — no jargon.

Respond with valid JSON only:
{{
  "impact": "positive|negative|neutral|uncertain",
  "score": 1-10,
  "affected_holdings": ["SYMBOL: impact"],
  "explanation": "2-3 sentences in plain English",
  "recommended_action": "watch|hold|review|urgent_review"
}}"""
