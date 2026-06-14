"""
Portfolio Manager Agent — makes the final decision after hearing all agents.
BUY / SELL / HOLD / SHORT / REDUCE / WATCHLIST / PASS
"""

import os, json, logging
import anthropic
from app.analysis.alpha_agent import cost_tracker, lessons as lessons_mod

log = logging.getLogger(__name__)
MODEL = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")

VALID_ACTIONS = {"BUY", "SELL", "HOLD", "SHORT", "REDUCE", "ADD", "WATCHLIST", "PASS"}


async def run(
    ticker: str,
    research: dict,
    bull: dict,
    bear: dict,
    risk: dict,
    regime: str = "UNKNOWN",
    trade_memory: list[dict] = [],
    run_id: int | None = None,
    emit=None,
) -> dict:
    async def _emit(msg, confidence=None, status="running"):
        if emit:
            try:
                await emit({"stage": "decision", "status": status,
                            "message": msg, "confidence": confidence})
            except Exception:
                pass

    await _emit(f"Portfolio Manager deliberating on {ticker}…")

    active_lessons = await lessons_mod.get_active_lessons()
    lessons_block  = await lessons_mod.format_for_prompt(active_lessons)

    # Summarise recent similar trades from memory
    memory_block = ""
    if trade_memory:
        recent = trade_memory[:5]
        memory_block = "RECENT SIMILAR TRADES:\n" + "\n".join(
            f"- {t['ticker']}: {t['direction']} → P&L {t.get('pnl_pct', '?')}% | {t.get('counterfactual_lesson', '')}"
            for t in recent
        )

    prompt = f"""You are the Portfolio Manager Agent for Alpha Agent, an AI portfolio manager.

You have heard from three advisors. Make the FINAL decision.

MARKET REGIME: {regime}

RESEARCH SUMMARY:
{json.dumps({k: v for k, v in research.items() if k != '_raw'}, indent=2)[:1000]}

BULL AGENT VERDICT ({bull.get('verdict', '?')}, confidence {bull.get('confidence', '?')}%):
{bull.get('thesis', '')}
Top reasons: {json.dumps(bull.get('top_reasons', []))}

BEAR AGENT VERDICT ({bear.get('verdict', '?')}, confidence {bear.get('confidence', '?')}%):
{bear.get('counter_thesis', '')}
Top concerns: {json.dumps(bear.get('top_concerns', []))}

RISK AGENT PLAN:
- Action: {risk.get('recommended_action', 'PASS')}
- Size: {risk.get('position_size_pct', 0)}% (${risk.get('position_size_usd', 0):,.0f})
- Stop: {risk.get('stop_pct', -10)}% | Target: {risk.get('target_pct', 15)}%
- Risk/Reward: {risk.get('risk_reward_ratio', 0)}:1

{memory_block}

{lessons_block}

DECISION RULES:
- If risk/reward < 1.5, default to PASS
- If bear confidence > bull confidence by >20 points, lean toward PASS/WATCHLIST
- If regime is BEAR and action is BUY, require exceptionally strong evidence
- Doing nothing (PASS) is always valid — only trade high-conviction setups
- Explain why you sided with Bull or Bear

Return JSON:
{{
  "ticker": "{ticker}",
  "action": "BUY|SELL|HOLD|SHORT|REDUCE|ADD|WATCHLIST|PASS",
  "confidence": 0-100,
  "expected_alpha_pct": estimated % above SPY,
  "time_horizon": "2-4 weeks|4-8 weeks|8-12 weeks",
  "position_size_pct": from risk agent (0 if PASS/WATCHLIST),
  "entry_strategy": "market|pullback to X|breakout above X",
  "stop_price": from risk agent,
  "target_price": from risk agent,
  "time_stop_days": from risk agent,
  "why_bull_won": "if BUY — why bull prevailed",
  "why_bear_won": "if PASS/WATCHLIST — why bear prevailed",
  "lessons_applied": ["lesson text that influenced this decision"],
  "decision_summary": "2-3 sentence explanation of the final call",
  "invalidation": "what would make me reverse this decision"
}}

Return ONLY valid JSON."""

    client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
    try:
        response = await client.messages.create(
            model=MODEL, max_tokens=900,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text.strip()
        await cost_tracker.log_call("portfolio_manager", MODEL,
                                    response.usage.input_tokens,
                                    response.usage.output_tokens, run_id)
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        result = json.loads(text)
        if result.get("action") not in VALID_ACTIONS:
            result["action"] = "PASS"
    except Exception as e:
        log.warning("portfolio_manager LLM failed: %s", e)
        result = {
            "ticker": ticker, "action": "PASS", "confidence": 0,
            "expected_alpha_pct": 0, "time_horizon": "4-8 weeks",
            "position_size_pct": 0, "entry_strategy": "N/A",
            "stop_price": 0, "target_price": 0, "time_stop_days": 0,
            "why_bull_won": "", "why_bear_won": "LLM failure — defaulting to PASS",
            "lessons_applied": [], "decision_summary": "Portfolio Manager unavailable.",
            "invalidation": "N/A",
        }

    # Mark active lessons as applied
    for lesson in active_lessons:
        lesson_text = lesson["lesson_text"]
        if any(lesson_text in applied for applied in result.get("lessons_applied", [])):
            await lessons_mod.increment_applied(lesson["id"])

    status = "pending_approval" if result["action"] not in {"PASS", "WATCHLIST"} else "complete"
    await _emit(
        f"Decision: {result['action']} {ticker} — {result.get('decision_summary', '')}",
        confidence=result.get("confidence"),
        status=status,
    )
    return result
