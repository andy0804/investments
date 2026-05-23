# MODEL: sonnet
import json
from app.config import INVESTOR_PROFILE


def build_ytd_coach_prompt(positions: list[dict], trade_log: list[dict],
                            macro: dict, signals_accuracy: dict = None) -> str:
    winners = sorted([p for p in positions if (p.get("total_gain_loss_percent") or 0) > 0],
                     key=lambda x: x.get("total_gain_loss_percent", 0), reverse=True)
    losers = sorted([p for p in positions if (p.get("total_gain_loss_percent") or 0) < 0],
                    key=lambda x: x.get("total_gain_loss_percent", 0))

    return f"""You are a personal investment coach delivering a weekly portfolio review.

INVESTOR PROFILE:
- Portfolio size: ${INVESTOR_PROFILE['portfolio_size']:,}, balanced risk
- Min hold: {INVESTOR_PROFILE['min_hold_days']} days
- Style: long-term, hands-off, US stocks only

TOP WINNERS:
{json.dumps([{{'symbol': p['symbol'], 'gain_pct': p.get('total_gain_loss_percent')}} for p in winners[:5]], indent=2)}

POSITIONS UNDER PRESSURE:
{json.dumps([{{'symbol': p['symbol'], 'loss_pct': p.get('total_gain_loss_percent')}} for p in losers[:5]], indent=2)}

RECENT TRADES:
{json.dumps([{{'symbol': t.get('symbol'), 'action': t.get('action'), 'price': t.get('price')}} for t in trade_log[:10]], indent=2)}

MACRO CONTEXT:
{json.dumps(macro, indent=2)}

Provide weekly coaching on:
1. Portfolio performance highlights
2. What the investor is doing well
3. Areas for improvement
4. Positions that need attention before next week
5. Strategic advice for the coming week given macro conditions

Use plain English. Be encouraging but honest. This investor is building wealth for the long term.

Respond with valid JSON only:
{{
  "week_summary": "1-2 sentence headline",
  "portfolio_grade": "A|B|C|D",
  "wins_this_week": ["win 1", "win 2"],
  "areas_to_improve": ["improvement 1", "improvement 2"],
  "positions_to_review": [{{"symbol": "X", "reason": "..."}}],
  "coaching_message": "personalized advice paragraph (4-6 sentences)",
  "next_week_focus": ["focus 1", "focus 2", "focus 3"]
}}"""
