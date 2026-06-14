"""
Counterfactual Engine — runs after a paper trade closes.
Asks: what was the best alternative? what did we get right/wrong? what should change?
Generates a PENDING lesson for user approval.
"""

import json
import logging
import os
from datetime import datetime, UTC, date

import aiosqlite
from anthropic import AsyncAnthropic

from app.config import DB_PATH
from app.analysis.alpha_agent import cost_tracker, lessons

log = logging.getLogger(__name__)

_client = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
_HAIKU = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")


async def run_counterfactual(position_id: int) -> dict | None:
    """
    Load a closed position and generate a counterfactual lesson.
    Returns the created lesson dict or None on failure.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_positions WHERE id = ?", (position_id,)
        ) as cur:
            pos = await cur.fetchone()

    if not pos:
        log.warning("Counterfactual: position %d not found", position_id)
        return None

    pos = dict(pos)
    if pos.get("status") != "CLOSED":
        log.info("Counterfactual skipped — position %d not closed", position_id)
        return None

    entry_price = pos.get("entry_price") or 0
    close_price = pos.get("close_price") or 0
    realized_pnl = pos.get("realized_pnl") or 0
    pnl_pct = round((close_price / entry_price - 1) * 100, 2) if entry_price else 0
    outcome = "winner" if pnl_pct > 0 else "loser"

    # Compute hold days from open_date / close_date
    open_date_str = pos.get("open_date") or pos.get("created_at", "")[:10]
    close_date_str = pos.get("close_date") or datetime.now(UTC).date().isoformat()
    try:
        hold_days = (
            date.fromisoformat(close_date_str[:10]) - date.fromisoformat(open_date_str[:10])
        ).days
    except Exception:
        hold_days = 0

    # Pull the original committee run for this position
    run_summary = ""
    if pos.get("run_id"):
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM alpha_agent_runs WHERE id = ?", (pos["run_id"],)
            ) as cur:
                run = await cur.fetchone()
        if run:
            run = dict(run)
            bull = json.loads(run.get("bull_json") or "{}")
            bear = json.loads(run.get("bear_json") or "{}")
            risk = json.loads(run.get("risk_json") or "{}")
            dec = json.loads(run.get("decision_json") or "{}")
            run_summary = (
                f"Bull: {str(bull.get('thesis', ''))[:300]}\n"
                f"Bear: {str(bear.get('thesis', ''))[:300]}\n"
                f"Risk: {str(risk.get('summary', ''))[:200]}\n"
                f"Decision: {str(dec.get('rationale', ''))[:300]}"
            )

    prompt = f"""You are a post-trade analyst reviewing a closed paper trade.

Trade summary:
- Ticker: {pos['ticker']}
- Direction: {pos.get('direction', 'LONG')}
- Entry: ${entry_price:.2f}  Exit: ${close_price:.2f}
- P&L: {pnl_pct:.1f}%  Realized: ${realized_pnl:.2f}
- Hold days: {hold_days}
- Original conviction: {pos.get('conviction', 0)}%

Original committee analysis:
{run_summary or 'Not available'}

Answer these four questions concisely:
1. WHAT WE GOT RIGHT: One thing the committee called correctly.
2. WHAT WE MISSED: The single most important thing the committee got wrong or overlooked.
3. LESSON: One concrete, actionable rule we should apply to future trades (start with an action verb).
4. CATEGORY: Which area does this lesson belong to? (entry/exit/sizing/thesis/timing)

Format as JSON:
{{"got_right": "...", "missed": "...", "lesson": "...", "category": "entry|exit|sizing|thesis|timing"}}"""

    try:
        resp = await _client.messages.create(
            model=_HAIKU,
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        await cost_tracker.log_call(
            stage="counterfactual",
            model=_HAIKU,
            tokens_in=resp.usage.input_tokens,
            tokens_out=resp.usage.output_tokens,
        )

        text = resp.content[0].text.strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        data = json.loads(text)

    except Exception as e:
        log.error("Counterfactual generation failed for position %d: %s", position_id, e)
        return None

    # Store in trade_memory using correct schema columns
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO alpha_agent_trade_memory
               (position_id, ticker, direction, entry_date, close_date,
                entry_price, close_price, realized_pnl, pnl_pct, holding_days,
                what_went_right, what_went_wrong, counterfactual_lesson, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                position_id,
                pos["ticker"],
                pos.get("direction", "LONG"),
                open_date_str,
                close_date_str,
                entry_price,
                close_price,
                realized_pnl,
                pnl_pct,
                hold_days,
                data.get("got_right", ""),
                data.get("missed", ""),
                data.get("lesson", ""),
                datetime.now(UTC).isoformat(),
            ),
        )
        await db.commit()

    # Propose as a PENDING lesson
    lesson_id = await lessons.create_lesson(
        lesson_text=data.get("lesson", ""),
        category=data.get("category", "thesis"),
        evidence=(
            f"Position {pos['ticker']} ({outcome}, {pnl_pct:.1f}%). "
            f"Missed: {data.get('missed', '')}"
        ),
        source_position_id=position_id,
    )

    log.info(
        "Counterfactual complete for %s: lesson='%s'",
        pos["ticker"],
        data.get("lesson", "")[:80],
    )
    return {"lesson_id": lesson_id, "ticker": pos["ticker"], "outcome": outcome, "pnl_pct": pnl_pct}
