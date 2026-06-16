"""
Portfolio Manager Agent — makes the final decision after hearing all agents.
BUY / SELL / HOLD / SHORT / REDUCE / WATCHLIST / PASS

Phase 2 additions:
- Four-question gate: every BUY must answer alpha_source, spy_outperformance_argument,
  historical_evidence, and falsification_condition with specifics.
- Opportunity cost gate: expected_alpha_pct must be >= 3.0% for any BUY.
- Historical evidence from alpha_research injected into prompt before call.
"""

import os, json, logging
import anthropic
from app.analysis.alpha_agent import cost_tracker, lessons as lessons_mod, alpha_research

log = logging.getLogger(__name__)
MODEL = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")

VALID_ACTIONS = {"BUY", "SELL", "HOLD", "SHORT", "REDUCE", "ADD", "WATCHLIST", "PASS"}
ALPHA_SOURCES = {"Sector Momentum", "Event Catalyst", "Mean Reversion", "Earnings Re-rate", "Macro Theme"}
MIN_ALPHA_HURDLE = 3.0  # % expected alpha vs SPY — below this → PASS regardless

# Thresholds for four-question validation
_MIN_CHARS = {"spy_outperformance_argument": 50, "falsification_condition": 30}


def _validate_four_questions(result: dict) -> tuple[bool, str]:
    """
    Returns (passes, reason_if_failed).
    Forces PASS if any of the four questions is missing, generic, or below standards.
    """
    action = result.get("action", "PASS")
    if action not in {"BUY", "SELL", "SHORT", "ADD"}:
        return True, ""  # Only gate buy-side actions

    # 1. Alpha source must be a valid category
    src = result.get("alpha_source", "")
    if not src or src not in ALPHA_SOURCES:
        return False, f"Alpha source '{src}' is not a valid category ({', '.join(sorted(ALPHA_SOURCES))})"

    # 2. SPY outperformance argument must be specific
    spy_arg = result.get("spy_outperformance_argument", "")
    if len(spy_arg) < _MIN_CHARS["spy_outperformance_argument"]:
        return False, f"SPY outperformance argument too generic (< {_MIN_CHARS['spy_outperformance_argument']} chars): '{spy_arg[:60]}'"
    generic_phrases = ["good company", "strong fundamentals", "strong growth", "solid earnings"]
    if any(p in spy_arg.lower() for p in generic_phrases):
        return False, f"SPY outperformance argument is generic — must explain specific edge vs SPY index"

    # 3. Historical evidence must be populated
    hist_ev = result.get("historical_evidence", "")
    if not hist_ev or len(hist_ev) < 20:
        return False, "Historical evidence field not populated — committee must cite pattern memory"

    # 4. Falsification condition must be specific
    falsif = result.get("falsification_condition", "")
    if len(falsif) < _MIN_CHARS["falsification_condition"]:
        return False, f"Falsification condition too vague (< {_MIN_CHARS['falsification_condition']} chars): '{falsif[:60]}'"

    # 5. Opportunity cost gate
    exp_alpha = float(result.get("expected_alpha_pct", 0) or 0)
    if exp_alpha < MIN_ALPHA_HURDLE:
        return False, f"Expected alpha {exp_alpha:.1f}% vs SPY is below minimum hurdle ({MIN_ALPHA_HURDLE}%)"

    return True, ""


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

    memory_block = ""
    if trade_memory:
        recent = trade_memory[:5]
        memory_block = "RECENT SIMILAR TRADES:\n" + "\n".join(
            f"- {t['ticker']}: {t['direction']} → P&L {t.get('pnl_pct', '?')}% | {t.get('counterfactual_lesson', '')}"
            for t in recent
        )

    # Inject alpha research context (DB read, no API cost)
    bull_alpha_src = bull.get("alpha_source", "")
    research_data  = await alpha_research.get_research(regime, bull_alpha_src)
    research_block = alpha_research.format_for_prompt(research_data)

    prompt = f"""You are the Portfolio Manager Agent for Alpha Agent, an AI portfolio manager.

You have heard from three advisors. Make the FINAL decision with full accountability.

MARKET REGIME: {regime}

RESEARCH SUMMARY:
{json.dumps({k: v for k, v in research.items() if k != '_raw'}, indent=2)[:800]}

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
- Entry price: ${risk.get('entry_price', 0):.2f}

{research_block}

{memory_block}

{lessons_block}

DECISION RULES:
- If risk/reward < 1.5 → PASS
- If bear confidence > bull confidence by >20 points → lean PASS/WATCHLIST
- MINIMUM HURDLE: expected_alpha_pct must be >= 3.0% vs SPY for any BUY action
- If expected_alpha_pct < 3.0% → you MUST return PASS
- Doing nothing (PASS) is always valid — only trade high-conviction setups where you can clearly explain why this beats SPY

MANDATORY FOUR-QUESTION GATE (all four required for BUY — be specific, not generic):
1. alpha_source: Choose ONE — Sector Momentum / Event Catalyst / Mean Reversion / Earnings Re-rate / Macro Theme
2. spy_outperformance_argument: Specifically WHY does {ticker} beat the SPY index in this timeframe? Not "it's a good company." Give a specific structural or timing reason (minimum 50 characters).
3. historical_evidence: Cite the pattern memory data above — how many observations, what was the avg alpha?
4. falsification_condition: What SPECIFIC observable event would prove this thesis wrong? This becomes the automatic exit trigger. Be measurable (e.g., "If semiconductor index fails to hold +3% by day 5").

Return ONLY valid JSON:
{{
  "ticker": "{ticker}",
  "action": "BUY|SELL|HOLD|SHORT|REDUCE|ADD|WATCHLIST|PASS",
  "confidence": 0-100,
  "expected_alpha_pct": estimated % above SPY over 20 days,
  "predicted_return_20d": estimated total % return over 20 days,
  "predicted_spy_return_20d": {research_data.get('avg_spy_return_20d', 1.4)},
  "time_horizon": "2-4 weeks|4-8 weeks|8-12 weeks",
  "position_size_pct": from risk agent (0 if PASS/WATCHLIST),
  "entry_strategy": "market|pullback to X|breakout above X",
  "stop_price": from risk agent,
  "target_price": from risk agent,
  "time_stop_days": from risk agent,
  "alpha_source": "Sector Momentum|Event Catalyst|Mean Reversion|Earnings Re-rate|Macro Theme",
  "spy_outperformance_argument": "Specific reason why {ticker} beats SPY — minimum 50 characters",
  "historical_evidence": "cite pattern memory: N obs, avg alpha X%, confidence Y%",
  "falsification_condition": "Specific measurable condition that would invalidate the thesis",
  "why_bull_won": "if BUY — why bull prevailed",
  "why_bear_won": "if PASS/WATCHLIST — why bear prevailed",
  "lessons_applied": ["lesson text that influenced this decision"],
  "decision_summary": "2-3 sentence explanation of the final call"
}}"""

    client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
    try:
        response = await client.messages.create(
            model=MODEL, max_tokens=1000,
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
        result = json.loads(text.strip())
        if result.get("action") not in VALID_ACTIONS:
            result["action"] = "PASS"
    except Exception as e:
        log.warning("portfolio_manager LLM failed: %s", e)
        result = {
            "ticker": ticker, "action": "PASS", "confidence": 0,
            "expected_alpha_pct": 0, "predicted_return_20d": 0,
            "predicted_spy_return_20d": 1.4, "time_horizon": "4-8 weeks",
            "position_size_pct": 0, "entry_strategy": "N/A",
            "stop_price": 0, "target_price": 0, "time_stop_days": 0,
            "alpha_source": "", "spy_outperformance_argument": "",
            "historical_evidence": "", "falsification_condition": "",
            "why_bull_won": "", "why_bear_won": "LLM failure — defaulting to PASS",
            "lessons_applied": [], "decision_summary": "Portfolio Manager unavailable.",
        }

    # ── Four-question gate + opportunity cost check ───────────────────────────
    passes, fail_reason = _validate_four_questions(result)
    if not passes:
        original_action = result.get("action", "PASS")
        result["action"] = "PASS"
        result["gate_blocked"] = True
        result["gate_reason"] = fail_reason
        result["decision_summary"] = (
            f"[FOUR-QUESTION GATE BLOCKED {original_action}] {fail_reason}. "
            f"Original summary: {result.get('decision_summary', '')}"
        )
        log.info("portfolio_manager: gate blocked %s for %s — %s", original_action, ticker, fail_reason)
        await _emit(
            f"Gate blocked {original_action} on {ticker}: {fail_reason}",
            status="complete",
        )

    # Attach pattern research to result for persistence
    result["_pattern_research"] = research_data

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
