"""
Light Review — runs when opportunity score is 50-79.
Bull Agent + Portfolio Manager Judge only (2 Haiku calls).
Cost: ~$0.002 vs ~$0.02 for full committee.
"""

import os, json, logging
import aiosqlite
import anthropic
from datetime import datetime, UTC

from app.config import DB_PATH
from app.analysis.alpha_agent import cost_tracker, activity_log as alog

log = logging.getLogger(__name__)
MODEL = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")


async def run_light_review(
    ticker: str,
    event_data: dict,
    opportunity: dict,
    narrative: dict,
    trigger_event_id: int | None = None,
) -> dict:
    """
    Light review: Bull hypothesis + quick Judge decision.
    Creates run record in alpha_agent_runs (status=LIGHT_REVIEW initially).
    Returns decision dict with run_id.
    """
    now = datetime.now(UTC).isoformat()
    client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))

    # Create lightweight run record
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """INSERT INTO alpha_agent_runs
               (ticker, trigger_event_id, status, started_at)
               VALUES (?, ?, 'LIGHT_REVIEW', ?)""",
            (ticker.upper(), trigger_event_id, now),
        ) as cur:
            run_id = cur.lastrowid
        await db.commit()

    try:
        regime = narrative.get("regime", "NORMAL")
        theme = narrative.get("primary_theme", "")
        expected_alpha = opportunity.get("expected_alpha_20d", 2.0)
        meets_hurdle = opportunity.get("meets_hurdle", False)

        # ── Call 1: Bull hypothesis ───────────────────────────────────────────
        bull_prompt = f"""You are a bull case analyst. Build a concise investment thesis.

TICKER: {ticker}
PRICE MOVE: {event_data.get("price_move", 0):+.1f}% today | VOLUME: {event_data.get("vol_ratio", 1.0):.1f}x average
MARKET REGIME: {regime} | THEME: {theme}
MARKET STORY: {narrative.get("narrative", "")}
EXPECTED ALPHA VS SPY: +{expected_alpha}% over 20 days

Build a concise bull case. Focus specifically on why {ticker} should outperform SPY, not just "it's a good company."

Return ONLY valid JSON:
{{"thesis": "2-3 sentence bull case", "key_points": ["specific reason 1", "specific reason 2", "specific reason 3"], "confidence": 0-100, "alpha_source": "Sector Momentum|Event Catalyst|Mean Reversion|Macro Theme", "falsification": "what specific event would prove this wrong"}}"""

        bull_resp = await client.messages.create(
            model=MODEL, max_tokens=400,
            messages=[{"role": "user", "content": bull_prompt}],
        )
        bull_text = bull_resp.content[0].text.strip()
        if bull_text.startswith("```"):
            bull_text = bull_text.split("```")[1]
            if bull_text.startswith("json"):
                bull_text = bull_text[4:]
        await cost_tracker.log_call(
            "light_review_bull", MODEL,
            bull_resp.usage.input_tokens, bull_resp.usage.output_tokens, run_id,
        )
        try:
            bull = json.loads(bull_text.strip())
        except Exception:
            bull = {"thesis": bull_text[:200], "confidence": 50,
                    "alpha_source": "Unknown", "falsification": ""}

        # ── Call 2: Quick Judge ───────────────────────────────────────────────
        judge_prompt = f"""You are a portfolio manager. Make a quick BUY or PASS decision.

TICKER: {ticker}
MOVE: {event_data.get("price_move", 0):+.1f}% | VOL: {event_data.get("vol_ratio", 1.0):.1f}x
REGIME: {regime} | THEME: {theme}
EXPECTED ALPHA: +{expected_alpha}% / 20d (meets 3% hurdle: {meets_hurdle})

BULL THESIS: {bull.get("thesis", "")}
BULL CONFIDENCE: {bull.get("confidence", 50)}%
ALPHA SOURCE: {bull.get("alpha_source", "Unknown")}
FALSIFICATION: {bull.get("falsification", "")}

Rules:
- If expected alpha < 3% vs SPY → PASS (below minimum hurdle)
- If bull confidence < 60% → PASS (insufficient conviction)
- If thesis is macro-driven and ticker is sector leader → favour BUY
- Position sizes: 3% (low conviction 55-65%), 7% (medium 65-75%), 12% (high 75%+)

Return ONLY valid JSON:
{{"action": "BUY|PASS", "confidence": 0-100, "rationale": "one sentence", "position_size_pct": 3-12}}"""

        judge_resp = await client.messages.create(
            model=MODEL, max_tokens=200,
            messages=[{"role": "user", "content": judge_prompt}],
        )
        judge_text = judge_resp.content[0].text.strip()
        if judge_text.startswith("```"):
            judge_text = judge_text.split("```")[1]
            if judge_text.startswith("json"):
                judge_text = judge_text[4:]
        await cost_tracker.log_call(
            "light_review_judge", MODEL,
            judge_resp.usage.input_tokens, judge_resp.usage.output_tokens, run_id,
        )
        try:
            decision = json.loads(judge_text.strip())
        except Exception:
            decision = {"action": "PASS", "confidence": 0,
                        "rationale": "Parse error in judge response", "position_size_pct": 3}

        decision["run_id"] = run_id
        decision["review_type"] = "LIGHT"
        decision["alpha_source"] = bull.get("alpha_source", "Unknown")
        decision["falsification"] = bull.get("falsification", "")
        decision["expected_alpha"] = expected_alpha
        decision["regime"] = regime

        action = decision.get("action", "PASS")
        approval = "PENDING" if action == "BUY" else "N/A"

        # Persist
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """UPDATE alpha_agent_runs SET
                   status='COMPLETE', bull_json=?, decision_json=?,
                   final_action=?, final_confidence=?,
                   approval_status=?, completed_at=?
                   WHERE id=?""",
                (
                    json.dumps(bull), json.dumps(decision),
                    action, decision.get("confidence", 0),
                    approval, datetime.now(UTC).isoformat(), run_id,
                ),
            )
            await db.commit()

        conf = decision.get("confidence", 0)
        await alog.write(
            "light_review_complete",
            f"Light review — {action} {ticker} @ {conf}% conf | expected alpha {expected_alpha:+.1f}% vs SPY",
            ticker=ticker,
            level="alert" if action == "BUY" else "info",
            metadata={"action": action, "run_id": run_id, "review_type": "LIGHT",
                      "expected_alpha": expected_alpha},
        )

        return decision

    except Exception as e:
        log.error("light_review failed for %s: %s", ticker, e)
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "UPDATE alpha_agent_runs SET status='FAILED', completed_at=? WHERE id=?",
                (datetime.now(UTC).isoformat(), run_id),
            )
            await db.commit()
        return {"action": "PASS", "confidence": 0,
                "rationale": f"Light review failed: {e}", "run_id": run_id}
