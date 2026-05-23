# MODEL: haiku
import json
from app.config import INVESTOR_PROFILE


def build_morning_brief_prompt(
    positions: list[dict],
    macro: dict,
    risk_alerts: list[dict],
    top_events: list[dict],
) -> str:
    pos_summary = []
    for p in positions[:15]:
        pos_summary.append({
            "symbol": p.get("symbol"),
            "value": p.get("current_value"),
            "gain_pct": p.get("total_gain_loss_percent"),
            "live_price": p.get("live_price"),
        })

    return f"""You are a personal investment analyst delivering a morning brief.

INVESTOR PROFILE:
- Portfolio: ${INVESTOR_PROFILE['portfolio_size']:,}, balanced risk
- Min hold: {INVESTOR_PROFILE['min_hold_days']} days
- Max single position: {INVESTOR_PROFILE['max_single_position_pct']}%

MARKET CONDITIONS:
VIX: {macro.get('vix', 'N/A')} — {macro.get('vix_signal', '')}
Market regime: {macro.get('market_regime', 'unknown')}

TOP POSITIONS (by value):
{json.dumps(pos_summary, indent=2)}

RISK ALERTS TODAY:
{json.dumps(risk_alerts, indent=2) if risk_alerts else "None"}

RECENT KEY EVENTS (top 5):
{json.dumps([e.get('title', '') for e in top_events[:5]], indent=2)}

Write a concise morning brief covering:
1. Overall portfolio health (1-2 sentences)
2. Key positions to watch today (max 3)
3. Market conditions and what they mean for this portfolio
4. Any immediate actions needed (stops, targets)

Keep it under 200 words. Plain English, no jargon.

Respond with valid JSON only:
{{
  "headline": "one sentence portfolio status",
  "portfolio_health": "good|caution|warning",
  "key_watches": ["SYMBOL: reason", ...],
  "market_context": "1-2 sentences",
  "immediate_actions": ["action if any"],
  "full_brief": "complete brief text for display"
}}"""
