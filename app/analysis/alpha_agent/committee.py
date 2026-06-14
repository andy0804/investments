"""
Committee runner — orchestrates Research → Bull → Bear → Risk → Portfolio Manager.
Persists every stage to the DB and emits SSE events throughout.
"""

import json
import logging
import aiosqlite
from datetime import datetime, UTC

from app.config import DB_PATH
from app.analysis.alpha_agent import (
    research_agent, bull_agent, bear_agent, risk_agent, portfolio_manager,
    activity_log as alog,
)

log = logging.getLogger(__name__)


async def _save_timeline_event(db, run_id: int, stage: str, status: str,
                                message: str, confidence: int | None, data: dict):
    await db.execute(
        """INSERT INTO alpha_agent_timeline_events
           (run_id, stage, status, message, confidence, data_json, event_time)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (run_id, stage, status, message, confidence,
         json.dumps(data) if data else None,
         datetime.now(UTC).isoformat()),
    )
    await db.commit()


async def run_committee(
    ticker: str,
    trigger_event_id: int | None = None,
    emit=None,
) -> dict:
    """
    Run the full 5-agent committee for a ticker.
    Returns the final decision dict with run_id attached.
    emit: async callable(event_dict) for SSE streaming.
    """
    now = datetime.now(UTC).isoformat()

    async def _emit(event: dict):
        # Log to DB
        async with aiosqlite.connect(DB_PATH) as db:
            await _save_timeline_event(
                db, run_id,
                event.get("stage", ""),
                event.get("status", ""),
                event.get("message", ""),
                event.get("confidence"),
                {k: v for k, v in event.items()
                 if k not in {"stage", "status", "message", "confidence"}},
            )
        # Forward to SSE caller
        if emit:
            try:
                await emit(event)
            except Exception:
                pass

    # ── Create run record ────────────────────────────────────────────────────
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """INSERT INTO alpha_agent_runs
               (ticker, trigger_event_id, status, started_at)
               VALUES (?, ?, 'RUNNING', ?)""",
            (ticker.upper(), trigger_event_id, now),
        ) as cur:
            run_id = cur.lastrowid
        await db.commit()

    try:
        # ── Fetch portfolio state ────────────────────────────────────────────
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT cash, total_value FROM alpha_agent_portfolio WHERE id=1"
            ) as cur:
                portfolio = dict(await cur.fetchone() or {"cash": 10000.0, "total_value": 10000.0})
            async with db.execute(
                "SELECT * FROM alpha_agent_positions WHERE status='OPEN'"
            ) as cur:
                open_positions = [dict(r) for r in await cur.fetchall()]
            async with db.execute(
                "SELECT * FROM alpha_agent_trade_memory ORDER BY created_at DESC LIMIT 10"
            ) as cur:
                trade_memory = [dict(r) for r in await cur.fetchall()]

        # ── Get market regime from existing SOTD system ──────────────────────
        regime = "UNKNOWN"
        try:
            async with aiosqlite.connect(DB_PATH) as db:
                async with db.execute(
                    "SELECT regime FROM stock_picks WHERE regime IS NOT NULL ORDER BY pick_date DESC LIMIT 1"
                ) as cur:
                    row = await cur.fetchone()
                    if row:
                        regime = row[0] or "UNKNOWN"
        except Exception:
            pass

        # ── Stage 1: Research ────────────────────────────────────────────────
        research = await research_agent.run(ticker, run_id, _emit)

        # ── Stage 2: Bull ────────────────────────────────────────────────────
        bull = await bull_agent.run(ticker, research, run_id, _emit)

        # ── Stage 3: Bear ────────────────────────────────────────────────────
        bear = await bear_agent.run(ticker, research, bull, run_id, _emit)

        # ── Stage 4: Risk ────────────────────────────────────────────────────
        risk = await risk_agent.run(
            ticker, research, bull, bear,
            portfolio_value=portfolio["total_value"],
            current_cash=portfolio["cash"],
            open_positions=open_positions,
            run_id=run_id, emit=_emit,
        )

        # ── Stage 5: Portfolio Manager ───────────────────────────────────────
        decision = await portfolio_manager.run(
            ticker, research, bull, bear, risk,
            regime=regime, trade_memory=trade_memory,
            run_id=run_id, emit=_emit,
        )

        # ── Persist results ──────────────────────────────────────────────────
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """UPDATE alpha_agent_runs SET
                   status='COMPLETE', research_json=?, bull_json=?, bear_json=?,
                   risk_json=?, decision_json=?, final_action=?, final_confidence=?,
                   approval_status=?, completed_at=?
                   WHERE id=?""",
                (
                    json.dumps({k: v for k, v in research.items() if k != "_raw"}),
                    json.dumps(bull), json.dumps(bear), json.dumps(risk),
                    json.dumps(decision),
                    decision.get("action", "PASS"),
                    decision.get("confidence", 0),
                    "PENDING" if decision.get("action") not in {"PASS", "WATCHLIST"} else "N/A",
                    datetime.now(UTC).isoformat(),
                    run_id,
                ),
            )
            await db.commit()

        decision["run_id"] = run_id

        # Log committee outcome to activity feed
        action = decision.get("action", "PASS")
        conf   = decision.get("confidence", 0)
        if action not in {"PASS", "WATCHLIST"}:
            await alog.write(
                "committee_complete",
                f"Committee decision — {action} {ticker} @ {conf}% confidence → pending your approval",
                ticker=ticker, level="alert",
                metadata={"action": action, "confidence": conf, "run_id": run_id},
            )
        else:
            await alog.write(
                "committee_complete",
                f"Committee decision — {action} {ticker} ({conf}% confidence)",
                ticker=ticker, level="info",
                metadata={"action": action, "confidence": conf, "run_id": run_id},
            )

        return decision

    except Exception as e:
        log.error("committee.run_committee failed for %s: %s", ticker, e)
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "UPDATE alpha_agent_runs SET status='FAILED', completed_at=? WHERE id=?",
                (datetime.now(UTC).isoformat(), run_id),
            )
            await db.commit()
        if emit:
            await emit({"stage": "error", "status": "error",
                        "message": f"Committee failed: {e}"})
        raise
