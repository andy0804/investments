"""
Alpha Agent Engine — ON/OFF control, position monitoring, trade execution.
Called by the scheduler every 30 min during market hours.
"""

import json, logging, aiosqlite
from datetime import datetime, UTC

from app.config import DB_PATH
from app.analysis.alpha_agent import event_detector, committee, self_corrector, activity_log as alog

log = logging.getLogger(__name__)


async def is_on() -> bool:
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT value FROM alpha_agent_config WHERE key='is_on'"
            ) as cur:
                row = await cur.fetchone()
            return row and row[0] == "1"
    except Exception:
        return False


async def set_on_off(state: bool) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO alpha_agent_config (key, value, updated_at) VALUES ('is_on', ?, ?)",
            ("1" if state else "0", datetime.now(UTC).isoformat()),
        )
        # Also update portfolio table flag
        await db.execute(
            "UPDATE alpha_agent_portfolio SET is_on=?, updated_at=? WHERE id=1",
            (int(state), datetime.now(UTC).isoformat()),
        )
        await db.commit()
    log.info("Alpha Agent: %s", "ON" if state else "OFF")
    msg = "Agent turned ON — scanning every 5 min during market hours" if state else "Agent turned OFF"
    await alog.write("agent_toggle", msg, level="success" if state else "warning")


async def get_portfolio_state() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM alpha_agent_portfolio WHERE id=1") as cur:
            row = await cur.fetchone()
            if not row:
                return {"cash": 10000.0, "total_value": 10000.0, "is_on": 0}
            portfolio = dict(row)

        async with db.execute(
            "SELECT * FROM alpha_agent_positions WHERE status='OPEN'"
        ) as cur:
            open_positions = [dict(r) for r in await cur.fetchall()]

        portfolio["positions"] = open_positions
        portfolio["invested_value"] = sum(
            p.get("shares", 0) * (p.get("current_price") or p.get("entry_price", 0))
            for p in open_positions
        )
        portfolio["total_value"] = portfolio["cash"] + portfolio["invested_value"]
    return portfolio


async def open_paper_position(run_id: int, decision: dict) -> int:
    """Record a paper trade from an approved committee decision."""
    now = datetime.now(UTC).isoformat()
    risk = {}
    # Re-read risk from the run
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT risk_json, ticker FROM alpha_agent_runs WHERE id=?", (run_id,)
        ) as cur:
            row = await cur.fetchone()
            if row:
                risk = json.loads(row["risk_json"] or "{}")
                ticker = row["ticker"]

    entry_price = risk.get("entry_price", 0) or decision.get("entry_price", 0)
    size_pct    = decision.get("position_size_pct", 5)
    stop_price  = risk.get("stop_price", 0)
    target_price= risk.get("target_price", 0)
    time_stop   = risk.get("time_stop_days", 90)

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        # Read current cash
        async with db.execute("SELECT cash, total_value FROM alpha_agent_portfolio WHERE id=1") as cur:
            port = dict(await cur.fetchone())
        position_usd = port["total_value"] * size_pct / 100
        shares = position_usd / entry_price if entry_price > 0 else 0

        async with db.execute(
            """INSERT INTO alpha_agent_positions
               (ticker, direction, size_pct, shares, entry_price, stop_price,
                target_price, time_stop_days, status, open_date,
                conviction, run_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)""",
            (ticker, decision.get("action", "BUY"),
             size_pct, round(shares, 4), entry_price, stop_price,
             target_price, time_stop, now[:10],
             decision.get("confidence", 70), run_id, now),
        ) as cur:
            position_id = cur.lastrowid

        # Deduct cash
        await db.execute(
            "UPDATE alpha_agent_portfolio SET cash=cash-?, updated_at=? WHERE id=1",
            (position_usd, now),
        )
        await db.execute(
            "UPDATE alpha_agent_runs SET position_id=? WHERE id=?",
            (position_id, run_id),
        )
        await db.commit()

    log.info("Alpha Agent: opened paper position %s %s @$%.2f (%d%%)",
             decision.get("action"), ticker, entry_price, size_pct)
    await alog.write(
        "position_opened",
        f"Position opened — {decision.get('action')} {ticker} @ ${entry_price:.2f} ({size_pct:.0f}% of portfolio)",
        ticker=ticker, level="success",
        metadata={"action": decision.get("action"), "entry_price": entry_price, "size_pct": size_pct},
    )
    return position_id


async def approve_decision(run_id: int) -> dict:
    """User approved a committee decision — open the paper position."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_runs WHERE id=? AND approval_status='PENDING'",
            (run_id,)
        ) as cur:
            run = await cur.fetchone()
        if not run:
            return {"error": "Run not found or not pending approval"}
        decision = json.loads(run["decision_json"] or "{}")

    position_id = await open_paper_position(run_id, decision)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE alpha_agent_runs SET approval_status='APPROVED', approved_at=? WHERE id=?",
            (datetime.now(UTC).isoformat(), run_id),
        )
        await db.commit()

    return {"position_id": position_id, "run_id": run_id, "status": "approved"}


async def reject_decision(run_id: int, reason: str = "") -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE alpha_agent_runs SET approval_status='REJECTED', rejected_at=?, rejection_reason=? WHERE id=?",
            (datetime.now(UTC).isoformat(), reason, run_id),
        )
        await db.commit()
    return {"run_id": run_id, "status": "rejected"}


async def close_paper_position(position_id: int, reason: str = "manual") -> dict:
    """Close an open paper position at current market price."""
    import yfinance as yf
    import asyncio as _asyncio

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_positions WHERE id=? AND status='OPEN'",
            (position_id,)
        ) as cur:
            pos = dict(await cur.fetchone() or {})
        if not pos:
            return {"error": "Position not found or already closed"}

    ticker = pos["ticker"]
    shares = pos["shares"]

    # Get current price
    try:
        t = yf.Ticker(ticker)
        close_price = float(await _asyncio.to_thread(
            lambda: t.fast_info.last_price or pos["entry_price"]
        ))
    except Exception:
        close_price = pos["entry_price"]

    proceeds = shares * close_price
    pnl = (close_price - pos["entry_price"]) * shares
    if pos["direction"] in ("SHORT", "SELL"):
        pnl = -pnl
    pnl_pct = (pnl / (pos["entry_price"] * shares)) * 100 if pos["entry_price"] else 0
    now = datetime.now(UTC).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """UPDATE alpha_agent_positions SET
               status='CLOSED', close_date=?, close_price=?, realized_pnl=?, unrealized_pnl=0
               WHERE id=?""",
            (now[:10], close_price, round(pnl, 2), position_id),
        )
        await db.execute(
            "UPDATE alpha_agent_portfolio SET cash=cash+?, updated_at=? WHERE id=1",
            (proceeds, now),
        )
        # Write to trade memory for counterfactual
        await db.execute(
            """INSERT INTO alpha_agent_trade_memory
               (position_id, ticker, direction, entry_date, close_date,
                entry_price, close_price, realized_pnl, pnl_pct,
                holding_days, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (position_id, ticker, pos["direction"],
             pos["open_date"], now[:10],
             pos["entry_price"], close_price, round(pnl, 2), round(pnl_pct, 2),
             (datetime.now(UTC).date() - datetime.fromisoformat(pos["open_date"]).date()).days,
             now),
        )
        await db.commit()

    log.info("Alpha Agent: closed %s @$%.2f | P&L $%.2f (%.1f%%)",
             ticker, close_price, pnl, pnl_pct)
    pnl_sign = "+" if pnl_pct >= 0 else ""
    await alog.write(
        "position_closed",
        f"Position closed — {ticker} @ ${close_price:.2f} | P&L {pnl_sign}{pnl_pct:.1f}% (${pnl:+.2f})",
        ticker=ticker,
        level="success" if pnl >= 0 else "danger",
        metadata={"close_price": close_price, "pnl": round(pnl, 2), "pnl_pct": round(pnl_pct, 2)},
    )

    # Run self-corrector after every close — may generate PENDING proposals
    try:
        proposals = await self_corrector.run_after_trade_close()
        if proposals:
            log.info("Self-corrector: created %d proposal(s): %s", len(proposals), proposals)
    except Exception as e:
        log.warning("Self-corrector failed: %s", e)

    return {"position_id": position_id, "close_price": close_price,
            "pnl": round(pnl, 2), "pnl_pct": round(pnl_pct, 2)}


async def monitor_open_positions() -> list[dict]:
    """Check stop-loss and target hits for all open positions."""
    import yfinance as yf
    import asyncio as _asyncio

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_positions WHERE status='OPEN'"
        ) as cur:
            positions = [dict(r) for r in await cur.fetchall()]

    alerts = []
    for pos in positions:
        try:
            t = yf.Ticker(pos["ticker"])
            curr = float(await _asyncio.to_thread(lambda: t.fast_info.last_price or 0))
            if curr <= 0:
                continue

            entry = pos["entry_price"]
            move_pct = (curr - entry) / entry * 100

            alert = None
            if pos["stop_price"] and curr <= pos["stop_price"]:
                alert = {"type": "STOP_HIT", "position_id": pos["id"],
                         "ticker": pos["ticker"], "pct": round(move_pct, 1)}
            elif pos["target_price"] and curr >= pos["target_price"]:
                alert = {"type": "TARGET_HIT", "position_id": pos["id"],
                         "ticker": pos["ticker"], "pct": round(move_pct, 1)}

            # Update current price in DB
            async with aiosqlite.connect(DB_PATH) as db:
                unrealized = (curr - entry) * pos["shares"]
                await db.execute(
                    "UPDATE alpha_agent_positions SET current_price=?, unrealized_pnl=? WHERE id=?",
                    (curr, round(unrealized, 2), pos["id"]),
                )
                await db.commit()

            if alert:
                alerts.append(alert)
        except Exception as e:
            log.warning("monitor: failed for %s: %s", pos["ticker"], e)

    return alerts


async def run_cycle() -> dict:
    """
    Main cycle — called by scheduler every 30 min.
    1. Check if ON.
    2. Monitor open positions.
    3. Scan watchlist for events.
    4. Trigger committee for high-significance events.
    """
    if not await is_on():
        return {"status": "off"}

    # Monitor positions
    alerts = await monitor_open_positions()

    # Scan for events
    triggered = await event_detector.scan_watchlist()

    # Run committee for each triggered event (max 1 per cycle)
    committees_run = []
    for event in triggered[:1]:
        try:
            decision = await committee.run_committee(
                ticker=event["ticker"],
                trigger_event_id=event.get("event_id"),
            )
            committees_run.append(decision)
        except Exception as e:
            log.error("run_cycle: committee failed: %s", e)

    return {
        "status": "ok",
        "position_alerts": alerts,
        "events_detected": len(triggered),
        "committees_run": len(committees_run),
        "decisions": committees_run,
    }
