"""
Alpha Agent router — all REST + SSE endpoints.
Prefix: /alpha-agent
"""

import asyncio
import json
import logging
from datetime import datetime, UTC

import aiosqlite
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.config import DB_PATH
from app.analysis.alpha_agent import (
    engine,
    watchlist,
    lessons,
    committee,
    event_detector,
    weekly_review,
    counterfactual,
    self_corrector,
    activity_log as alog,
)
from app.analysis.alpha_agent.cost_tracker import get_today_spend, get_monthly_spend

log = logging.getLogger(__name__)
router = APIRouter(prefix="/alpha-agent", tags=["alpha-agent"])


# ─── Status / Config ─────────────────────────────────────────────────────────

@router.get("/status")
async def get_status():
    on = await engine.is_on()
    portfolio = {}
    config = {}
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT cash, total_value, updated_at FROM alpha_agent_portfolio LIMIT 1"
        ) as cur:
            row = await cur.fetchone()
        if row:
            portfolio = dict(row)
        async with db.execute("SELECT key, value FROM alpha_agent_config") as cur:
            rows = await cur.fetchall()
        config = {r["key"]: r["value"] for r in rows}

    daily = await get_today_spend()
    monthly = await get_monthly_spend()

    return {
        "is_on": on,
        "portfolio": portfolio,
        "config": config,
        "daily_cost_usd": daily["cost_usd"],
        "monthly_cost_usd": monthly["cost_usd"],
    }


class OnOffBody(BaseModel):
    state: bool

@router.post("/on-off")
async def set_on_off(body: OnOffBody):
    await engine.set_on_off(body.state)
    return {"is_on": body.state}


class ConfigBody(BaseModel):
    key: str
    value: str

@router.post("/config")
async def set_config(body: ConfigBody):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO alpha_agent_config (key, value, updated_at) VALUES (?, ?, ?)",
            (body.key, body.value, datetime.now(UTC).isoformat()),
        )
        await db.commit()
    return {"key": body.key, "value": body.value}


# ─── Watchlist ───────────────────────────────────────────────────────────────

@router.get("/watchlist")
async def get_watchlist_endpoint(tier: str = ""):
    return await watchlist.get_watchlist(tier=tier)

@router.get("/watchlist/summary")
async def get_watchlist_summary():
    return await watchlist.get_watchlist_summary()

class WatchlistAdd(BaseModel):
    ticker: str
    source: str = "manual"
    notes: str = ""

@router.post("/watchlist")
async def add_ticker(body: WatchlistAdd):
    added = await watchlist.add_to_watchlist(body.ticker, body.source, body.notes)
    return {"added": added, "ticker": body.ticker.upper()}

@router.delete("/watchlist/{ticker}")
async def remove_ticker(ticker: str):
    removed = await watchlist.remove_from_watchlist(ticker)
    if not removed:
        raise HTTPException(404, f"{ticker.upper()} not on watchlist")
    return {"removed": ticker.upper()}

@router.post("/watchlist/seed")
async def seed_watchlist():
    count = await watchlist.seed_from_sotd_history()
    return {"seeded": count}

@router.post("/watchlist/screen-universe")
async def run_universe_screen():
    """Manually trigger the universe screener."""
    from app.analysis.alpha_agent.watchlist import screen_universe
    count = await screen_universe()
    return {"universe_count": count}

@router.post("/watchlist/auto-age")
async def run_auto_age():
    """Manually trigger watchlist auto-aging."""
    from app.analysis.alpha_agent.watchlist import auto_age_watchlist
    demoted = await auto_age_watchlist()
    return {"demoted": demoted}


# ─── Portfolio ───────────────────────────────────────────────────────────────

@router.get("/portfolio")
async def get_portfolio():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_portfolio LIMIT 1"
        ) as cur:
            port = await cur.fetchone()
        async with db.execute(
            "SELECT * FROM alpha_agent_positions WHERE status = 'OPEN' ORDER BY created_at DESC"
        ) as cur:
            positions = [dict(r) for r in await cur.fetchall()]
    return {
        "portfolio": dict(port) if port else {},
        "positions": positions,
    }


@router.get("/portfolio/history")
async def get_trade_history():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_positions ORDER BY created_at DESC"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


# ─── Trade Queue (completed runs awaiting approval) ──────────────────────────

@router.get("/queue")
async def get_trade_queue():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT * FROM alpha_agent_runs
               WHERE approval_status = 'PENDING' AND status = 'COMPLETE'
               ORDER BY completed_at DESC""",
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.get("/runs/{run_id}")
async def get_run(run_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_runs WHERE id = ?", (run_id,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Run not found")
        async with db.execute(
            "SELECT * FROM alpha_agent_timeline_events WHERE run_id = ? ORDER BY id",
            (run_id,),
        ) as cur:
            timeline = [dict(r) for r in await cur.fetchall()]
    return {"run": dict(row), "timeline": timeline}


class DecisionBody(BaseModel):
    action: str  # "approve" | "reject"
    notes: str = ""

@router.post("/runs/{run_id}/decision")
async def decide_on_run(run_id: int, body: DecisionBody):
    if body.action not in ("approve", "reject"):
        raise HTTPException(400, "action must be approve or reject")
    if body.action == "approve":
        result = await engine.approve_decision(run_id)
        if "error" in result:
            raise HTTPException(400, result["error"])
        return {"status": "approved", "position_id": result.get("position_id")}
    else:
        result = await engine.reject_decision(run_id, body.notes)
        return result


# ─── SSE Committee Stream ────────────────────────────────────────────────────

@router.get("/committee/stream/{run_id}")
async def stream_committee(run_id: int):
    """SSE: streams timeline events for a run as they are written to the DB."""

    async def event_generator():
        last_id = 0
        idle_ticks = 0

        while True:
            async with aiosqlite.connect(DB_PATH) as db:
                db.row_factory = aiosqlite.Row
                async with db.execute(
                    """SELECT * FROM alpha_agent_timeline_events
                       WHERE run_id = ? AND id > ? ORDER BY id""",
                    (run_id, last_id),
                ) as cur:
                    rows = await cur.fetchall()

            for row in rows:
                row = dict(row)
                last_id = row["id"]
                idle_ticks = 0
                yield f"data: {json.dumps(row)}\n\n"

            # Check if run has finished
            async with aiosqlite.connect(DB_PATH) as db:
                async with db.execute(
                    "SELECT status FROM alpha_agent_runs WHERE id = ?", (run_id,)
                ) as cur:
                    run_row = await cur.fetchone()

            if run_row and run_row[0] != "RUNNING":
                yield f"data: {json.dumps({'stage': 'done', 'status': run_row[0]})}\n\n"
                break

            idle_ticks += 1
            if idle_ticks > 120:  # 2 min timeout
                yield f"data: {json.dumps({'stage': 'timeout'})}\n\n"
                break

            await asyncio.sleep(1)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/committee/trigger/{ticker}")
async def trigger_committee(ticker: str):
    """Manually trigger a committee run for a ticker."""
    result = await committee.run_committee(ticker=ticker.upper())
    return {"run_id": result.get("run_id"), "ticker": ticker.upper(), "decision": result}


# ─── Events ──────────────────────────────────────────────────────────────────

@router.get("/events")
async def get_events(limit: int = 50):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_events ORDER BY detected_at DESC LIMIT ?",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/events/scan")
async def trigger_event_scan():
    """Manually fire the event detection cycle."""
    results = await event_detector.scan_watchlist()
    return {"scanned": True, "events_detected": len(results)}


# ─── Lessons ─────────────────────────────────────────────────────────────────

@router.get("/lessons")
async def get_lessons(status: str = ""):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if status:
            async with db.execute(
                "SELECT * FROM alpha_agent_lessons WHERE status = ? ORDER BY created_at DESC",
                (status.upper(),),
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute(
                "SELECT * FROM alpha_agent_lessons ORDER BY created_at DESC"
            ) as cur:
                rows = await cur.fetchall()
    return [dict(r) for r in rows]


class LessonDecision(BaseModel):
    action: str  # "apply" | "dismiss"

@router.post("/lessons/{lesson_id}/decision")
async def decide_lesson(lesson_id: int, body: LessonDecision):
    if body.action == "apply":
        await lessons.approve_lesson(lesson_id)
        return {"status": "ACTIVE"}
    elif body.action == "dismiss":
        await lessons.dismiss_lesson(lesson_id)
        return {"status": "DISMISSED"}
    raise HTTPException(400, "action must be apply or dismiss")


# ─── Trade Memory + Counterfactual ──────────────────────────────────────────

@router.get("/memory")
async def get_trade_memory(limit: int = 20):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_trade_memory ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/memory/counterfactual/{position_id}")
async def run_counterfactual_endpoint(position_id: int):
    result = await counterfactual.run_counterfactual(position_id)
    if not result:
        raise HTTPException(400, "Counterfactual could not be generated")
    return result


# ─── Strategy Log ────────────────────────────────────────────────────────────

@router.get("/strategy-log")
async def get_strategy_log(limit: int = 12):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_strategy_log ORDER BY week_start DESC LIMIT ?",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/strategy-log/run")
async def trigger_weekly_review():
    result = await weekly_review.run_weekly_review()
    if not result:
        raise HTTPException(500, "Weekly review failed")
    return result


# ─── Costs ───────────────────────────────────────────────────────────────────

@router.get("/costs")
async def get_costs(limit: int = 200):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_costs ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
    daily = await get_today_spend()
    monthly = await get_monthly_spend()
    return {
        "daily_usd": daily["cost_usd"],
        "monthly_usd": monthly["cost_usd"],
        "calls": [dict(r) for r in rows],
    }


# ─── Position close (manual) ─────────────────────────────────────────────────

class CloseBody(BaseModel):
    exit_reason: str = "manual"

@router.post("/positions/{position_id}/close")
async def close_position(position_id: int, body: CloseBody):
    result = await engine.close_paper_position(position_id, body.exit_reason)
    if "error" in result:
        raise HTTPException(400, result["error"])
    asyncio.create_task(counterfactual.run_counterfactual(position_id))
    return {"closed": True, "position_id": position_id, **result}


# ─── Self-Corrector Proposals ────────────────────────────────────────────────

@router.get("/proposals")
async def get_proposals(status: str = ""):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if status:
            async with db.execute(
                "SELECT * FROM alpha_agent_config_proposals WHERE status=? ORDER BY created_at DESC",
                (status.upper(),),
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute(
                "SELECT * FROM alpha_agent_config_proposals ORDER BY created_at DESC"
            ) as cur:
                rows = await cur.fetchall()
    return [dict(r) for r in rows]


class ProposalDecision(BaseModel):
    action: str  # "approve" | "reject"

@router.post("/proposals/{proposal_id}/decision")
async def decide_proposal(proposal_id: int, body: ProposalDecision):
    if body.action == "approve":
        result = await self_corrector.apply_proposal(proposal_id)
        if "error" in result:
            raise HTTPException(400, result["error"])
        return result
    elif body.action == "reject":
        return await self_corrector.reject_proposal(proposal_id)
    raise HTTPException(400, "action must be approve or reject")


# ─── Activity Log ────────────────────────────────────────────────────────────

@router.get("/activity")
async def get_activity(limit: int = 100, since_id: int = 0):
    return await alog.get_recent(limit=limit, since_id=since_id)


@router.get("/activity/stream")
async def stream_activity():
    """SSE: delivers new activity log entries as they are written."""

    async def generator():
        initial = await alog.get_recent(limit=20)
        for entry in initial:
            yield f"data: {json.dumps(entry)}\n\n"

        last_id = initial[-1]["id"] if initial else 0
        idle = 0

        while True:
            entries = await alog.get_recent(limit=50, since_id=last_id)
            for entry in entries:
                last_id = entry["id"]
                idle = 0
                yield f"data: {json.dumps(entry)}\n\n"
            if not entries:
                idle += 1
                if idle % 6 == 0:  # heartbeat every 30s
                    yield f"data: {json.dumps({'event_type': 'heartbeat', 'message': '', 'id': last_id})}\n\n"
            await asyncio.sleep(5)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ─── Phase 1: Market Intelligence ───────────────────────────────────────────

@router.get("/market-narrative")
async def get_market_narrative():
    """Returns latest market narrative + ranked opportunities from last scan."""
    from app.analysis.alpha_agent.macro_intelligence import get_latest_narrative
    narrative = await get_latest_narrative()
    if not narrative:
        return {"narrative": None, "opportunities": []}

    # Attach opportunities from the same row
    opportunities = []
    try:
        opp_json = narrative.pop("opportunities_json", None) or "[]"
        opportunities = json.loads(opp_json)
    except Exception:
        pass

    return {"narrative": narrative, "opportunities": opportunities}


@router.get("/predictions")
async def get_predictions(limit: int = 50):
    """Returns prediction records with actuals where resolved."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_predictions ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.get("/counterfactuals")
async def get_counterfactuals(limit: int = 50):
    """Returns logged passed opportunities and their outcomes."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_counterfactuals ORDER BY passed_at DESC LIMIT ?",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.get("/pattern-memory")
async def get_pattern_memory():
    """Returns the alpha pattern memory library."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_pattern_memory ORDER BY observations DESC, avg_alpha DESC"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


# ─── Phase 3: Calibration & Learning ────────────────────────────────────────

@router.get("/calibration")
async def get_calibration(status: str = ""):
    from app.analysis.alpha_agent.calibration import get_calibration_reports
    return await get_calibration_reports(status)

@router.post("/calibration/run")
async def run_calibration_endpoint():
    from app.analysis.alpha_agent.calibration import run_calibration
    return await run_calibration()

@router.post("/calibration/{cal_id}/apply")
async def apply_calibration_endpoint(cal_id: int):
    from app.analysis.alpha_agent.calibration import apply_calibration
    result = await apply_calibration(cal_id)
    if "error" in result:
        raise HTTPException(400, result["error"])
    return result

@router.post("/calibration/{cal_id}/reject")
async def reject_calibration_endpoint(cal_id: int):
    from app.analysis.alpha_agent.calibration import reject_calibration
    return await reject_calibration(cal_id)

@router.post("/prediction-audit/run")
async def run_prediction_audit_endpoint():
    from app.analysis.alpha_agent.calibration import run_prediction_audit
    result = await run_prediction_audit()
    if not result:
        raise HTTPException(500, "Prediction audit failed or insufficient data (need 3+ resolved predictions)")
    return result

@router.get("/counterfactuals/summary")
async def get_counterfactual_summary_endpoint():
    from app.analysis.alpha_agent.calibration import get_counterfactual_summary
    return await get_counterfactual_summary()

@router.post("/counterfactuals/resolve")
async def resolve_counterfactuals_endpoint():
    from app.analysis.alpha_agent.calibration import resolve_counterfactual_outcomes
    resolved = await resolve_counterfactual_outcomes()
    return {"resolved": resolved}


# ─── Phase 4: Performance Dashboard ─────────────────────────────────────────

@router.get("/performance")
async def get_performance():
    """
    Returns portfolio performance vs SPY benchmark.
    Computes: total return, alpha, win rate, breakdown by alpha source + regime.
    """
    import yfinance as yf, asyncio as _asyncio

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_positions ORDER BY created_at ASC"
        ) as cur:
            positions = [dict(r) for r in await cur.fetchall()]
        async with db.execute(
            "SELECT * FROM alpha_agent_predictions ORDER BY created_at ASC"
        ) as cur:
            predictions = [dict(r) for r in await cur.fetchall()]
        async with db.execute(
            "SELECT cash, total_value, initial_capital FROM alpha_agent_portfolio WHERE id=1"
        ) as cur:
            port = dict(await cur.fetchone() or {})

    closed = [p for p in positions if p["status"] == "CLOSED"]
    open_  = [p for p in positions if p["status"] == "OPEN"]

    pred_by_pos = {p["position_id"]: p for p in predictions}

    # SPY benchmark: buy SPY at each entry date, sell at close date
    spy_hist = None
    try:
        spy_hist = await _asyncio.to_thread(lambda: yf.Ticker("SPY").history(period="max"))
        spy_hist.index = spy_hist.index.tz_localize(None)
    except Exception:
        pass

    def spy_return_over(entry_date: str, exit_date: str) -> float | None:
        if spy_hist is None or spy_hist.empty:
            return None
        try:
            entry = spy_hist.loc[spy_hist.index >= entry_date]["Close"].iloc[0]
            end   = spy_hist.loc[spy_hist.index <= exit_date]["Close"].iloc[-1]
            return round((end / entry - 1) * 100, 2)
        except Exception:
            return None

    # Per-trade stats
    trades = []
    total_spy_benchmark = 0.0
    spy_trade_count     = 0

    for pos in closed:
        ep  = pos.get("entry_price", 0) or 0
        cp  = pos.get("close_price", ep) or ep
        pnl = round((cp / ep - 1) * 100, 2) if ep else 0

        spy_ret = spy_return_over(pos.get("open_date",""), pos.get("close_date",""))
        alpha   = round(pnl - spy_ret, 2) if spy_ret is not None else None

        pred = pred_by_pos.get(pos["id"], {})

        trades.append({
            "ticker":       pos["ticker"],
            "direction":    pos["direction"],
            "open_date":    pos["open_date"],
            "close_date":   pos["close_date"],
            "pnl_pct":      pnl,
            "spy_ret_pct":  spy_ret,
            "alpha_pct":    alpha,
            "alpha_source": pred.get("alpha_source", ""),
            "regime":       pred.get("regime_at_entry", ""),
            "size_pct":     pos.get("size_pct", 0),
        })

        if spy_ret is not None:
            total_spy_benchmark += spy_ret
            spy_trade_count += 1

    # Aggregate stats
    wins     = [t for t in trades if t["pnl_pct"] > 0]
    losses   = [t for t in trades if t["pnl_pct"] <= 0]
    win_rate = round(len(wins) / len(trades) * 100, 1) if trades else 0
    avg_win  = round(sum(t["pnl_pct"] for t in wins) / len(wins), 2) if wins else 0
    avg_loss = round(sum(t["pnl_pct"] for t in losses) / len(losses), 2) if losses else 0
    avg_spy_benchmark = round(total_spy_benchmark / spy_trade_count, 2) if spy_trade_count else 0

    # Portfolio total return
    initial  = float(port.get("initial_capital", 10000))
    current  = float(port.get("total_value", initial))
    total_return_pct = round((current / initial - 1) * 100, 2) if initial else 0

    # SPY since first trade
    spy_since_inception = None
    if trades and spy_hist is not None:
        spy_since_inception = spy_return_over(
            min(t["open_date"] for t in trades if t["open_date"]),
            (datetime.now(UTC).date()).isoformat(),
        )

    # Breakdown by alpha source
    by_source: dict[str, dict] = {}
    for t in trades:
        src = t.get("alpha_source") or "Unknown"
        if src not in by_source:
            by_source[src] = {"trades": 0, "wins": 0, "total_pnl": 0, "total_alpha": 0, "alpha_count": 0}
        by_source[src]["trades"] += 1
        if t["pnl_pct"] > 0:
            by_source[src]["wins"] += 1
        by_source[src]["total_pnl"] += t["pnl_pct"]
        if t.get("alpha_pct") is not None:
            by_source[src]["total_alpha"] += t["alpha_pct"]
            by_source[src]["alpha_count"] += 1

    source_stats = {
        src: {
            "trades":    d["trades"],
            "win_rate":  round(d["wins"] / d["trades"] * 100, 1),
            "avg_pnl":   round(d["total_pnl"] / d["trades"], 2),
            "avg_alpha": round(d["total_alpha"] / d["alpha_count"], 2) if d["alpha_count"] else None,
        }
        for src, d in by_source.items()
    }

    # Breakdown by regime
    by_regime: dict[str, dict] = {}
    for t in trades:
        r = t.get("regime") or "Unknown"
        if r not in by_regime:
            by_regime[r] = {"trades": 0, "wins": 0, "total_pnl": 0}
        by_regime[r]["trades"] += 1
        if t["pnl_pct"] > 0:
            by_regime[r]["wins"] += 1
        by_regime[r]["total_pnl"] += t["pnl_pct"]

    regime_stats = {
        r: {
            "trades":   d["trades"],
            "win_rate": round(d["wins"] / d["trades"] * 100, 1),
            "avg_pnl":  round(d["total_pnl"] / d["trades"], 2),
        }
        for r, d in by_regime.items()
    }

    return {
        "portfolio": {
            "total_value":          current,
            "initial_capital":      initial,
            "total_return_pct":     total_return_pct,
            "spy_since_inception":  spy_since_inception,
            "alpha_vs_spy":         round(total_return_pct - spy_since_inception, 2) if spy_since_inception else None,
            "open_positions":       len(open_),
            "closed_trades":        len(closed),
        },
        "trade_stats": {
            "win_rate":         win_rate,
            "avg_win_pct":      avg_win,
            "avg_loss_pct":     avg_loss,
            "avg_spy_per_trade": avg_spy_benchmark,
            "avg_alpha_per_trade": round(
                sum(t["alpha_pct"] for t in trades if t.get("alpha_pct") is not None) /
                len([t for t in trades if t.get("alpha_pct") is not None]), 2
            ) if any(t.get("alpha_pct") for t in trades) else None,
        },
        "by_alpha_source": source_stats,
        "by_regime":       regime_stats,
        "recent_trades":   sorted(trades, key=lambda t: t["close_date"] or "", reverse=True)[:20],
    }


# ─── Market Status ───────────────────────────────────────────────────────────

@router.get("/market/status")
async def get_market_status():
    import pytz
    from datetime import timedelta

    et      = pytz.timezone("America/New_York")
    now_et  = datetime.now(et)
    weekday = now_et.weekday()

    m_open  = now_et.replace(hour=9,  minute=30, second=0, microsecond=0)
    m_close = now_et.replace(hour=16, minute=0,  second=0, microsecond=0)

    is_weekend = weekday >= 5
    is_open    = not is_weekend and m_open <= now_et < m_close
    is_pre     = not is_weekend and now_et < m_open

    if is_open:
        status = "OPEN"
        secs   = int((m_close - now_et).total_seconds())
    elif is_pre:
        status = "PRE_MARKET"
        secs   = int((m_open - now_et).total_seconds())
    else:
        status = "CLOSED"
        # Find next weekday open
        days_ahead = 1
        while True:
            candidate = (now_et + timedelta(days=days_ahead)).replace(
                hour=9, minute=30, second=0, microsecond=0)
            if candidate.weekday() < 5:
                break
            days_ahead += 1
        secs = int((candidate - now_et).total_seconds())

    last_scan = None
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT created_at FROM alpha_agent_activity_log WHERE event_type='event_scan' ORDER BY id DESC LIMIT 1"
        ) as cur:
            row = await cur.fetchone()
        if row:
            last_scan = row["created_at"]

    return {
        "status":            status,
        "is_open":           is_open,
        "seconds_to_event":  max(0, secs),
        "now_et":            now_et.strftime("%I:%M %p ET"),
        "last_scan_at":      last_scan,
        "scan_interval_sec": 300,
    }
