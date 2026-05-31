import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime, UTC
from typing import Any
import aiosqlite
import pandas as pd
import yfinance as yf
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from app.config import DB_PATH
from app.db.schema import init_db
from app.connectors.portfolio_csv import sync_portfolio_from_csv, get_portfolio_symbols
from app.connectors.finnhub import sync_market_data, fetch_earnings_calendar
from app.connectors.fred import sync_vix, get_latest_vix
from app.scheduler.jobs import create_scheduler
from app.analysis.orchestrator import (
    generate_morning_brief, generate_signal, generate_deep_dive,
    generate_ytd_coach, generate_earnings_prep, scan_all_signals,
    generate_stock_of_day, save_deep_dive, list_saved_deep_dives,
)
from app.analysis.filter_presets import (
    list_presets, get_active_preset, create_preset, activate_preset,
    update_preset, delete_preset,
)
from app.analysis.top_performers import get_top_performers
from app.analysis.sotd_engine import run_sotd_pipeline, reset_pipeline_lock
from app.analysis.portfolio_intelligence import generate_portfolio_intelligence
from app.scheduler.manager import seed_schedules, list_schedules, toggle_schedule, delete_schedule, update_schedule
from app.analysis.macro import get_macro_snapshot
from app.analysis.risk import check_all_positions, get_position_risk_summary
from app.analysis.claude_engine import get_daily_cost
from app.analysis.screener import screen_stocks, screen_momentum, screen_oversold
from app.analysis.sector_rotation import get_sector_performance
from app.analysis.preemptive_engine import generate_foresight_report
from app.performance.signal_tracker import get_signal_accuracy, resolve_old_signals
from app.performance.roi_tracker import get_monthly_roi_report
from app.performance.health_monitor import check_all_apis
from app.routers.options import router as options_router
from app.routers.live_portfolio import router as live_portfolio_router
from app.routers.options_scanner import router as options_scanner_router

import os as _os

_log_dir = _os.path.join(_os.path.dirname(__file__), "..", "logs")
_os.makedirs(_log_dir, exist_ok=True)
_log_file = _os.path.join(_log_dir, "agent.log")

_file_handler = logging.FileHandler(_log_file, mode="a", encoding="utf-8")
_file_handler.setFormatter(logging.Formatter("%(asctime)s %(name)s %(levelname)s %(message)s"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(), _file_handler],
)
logger = logging.getLogger(__name__)

scheduler = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global scheduler
    await init_db()
    from app.simulator.job_runner import recover_stale_runs
    await recover_stale_runs()
    await sync_portfolio_from_csv()
    scheduler = create_scheduler()
    scheduler.start()
    await seed_schedules()
    app.state.scheduler = scheduler
    logger.info("Investment agent started")
    yield
    if scheduler:
        scheduler.shutdown()
    logger.info("Investment agent stopped")


app = FastAPI(title="Investment Agent", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://localhost:5175"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(options_router)
app.include_router(live_portfolio_router)
app.include_router(options_scanner_router)


@app.get("/health")
async def health():
    jobs = []
    if scheduler:
        for job in scheduler.get_jobs():
            jobs.append({"id": job.id, "next_run": str(job.next_run_time)})

    vix = await get_latest_vix()

    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT COUNT(*) FROM positions") as cur:
            pos_count = (await cur.fetchone())[0]
        async with db.execute(
            "SELECT job_name, status, ran_at FROM sync_log ORDER BY ran_at DESC LIMIT 10"
        ) as cur:
            recent_syncs = [{"job": r[0], "status": r[1], "at": r[2]} for r in await cur.fetchall()]

    return {
        "status": "ok",
        "positions_loaded": pos_count,
        "vix": vix,
        "scheduler_jobs": jobs,
        "recent_syncs": recent_syncs,
    }


@app.get("/positions")
async def get_positions():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT p.*, m.price as live_price, m.change_pct, m.fetched_at as price_fetched_at
               FROM positions p
               LEFT JOIN market_data m ON p.symbol = m.symbol
               ORDER BY p.account_number, p.current_value DESC"""
        ) as cur:
            rows = await cur.fetchall()
    return {"positions": [dict(r) for r in rows], "count": len(rows)}


@app.post("/portfolio/reload-csv")
async def reload_csv():
    count = await sync_portfolio_from_csv()
    symbols = await get_portfolio_symbols()
    await sync_market_data(symbols)
    return {"status": "ok", "positions_loaded": count}


@app.get("/portfolio/summary")
async def portfolio_summary():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT account_number, account_name,
                      SUM(current_value) as total_value,
                      SUM(total_gain_loss_dollar) as total_gain_loss,
                      COUNT(*) as position_count
               FROM positions
               GROUP BY account_number, account_name"""
        ) as cur:
            accounts = [dict(r) for r in await cur.fetchall()]

    vix = await get_latest_vix()
    total = sum(a["total_value"] or 0 for a in accounts)
    return {"accounts": accounts, "portfolio_total": total, "vix": vix}


@app.get("/events")
async def get_events(limit: int = 50, source: str = None):
    query = "SELECT * FROM events"
    params = []
    if source:
        query += " WHERE source = ?"
        params.append(source)
    query += " ORDER BY fetched_at DESC LIMIT ?"
    params.append(limit)

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(query, params) as cur:
            rows = await cur.fetchall()
    return {"events": [dict(r) for r in rows], "count": len(rows)}


@app.post("/portfolio/log-trade")
async def log_trade(
    symbol: str, action: str, quantity: float, price: float,
    account_number: str = None, notes: str = None
):
    if action not in ("buy", "sell"):
        raise HTTPException(status_code=400, detail="action must be 'buy' or 'sell'")
    total_value = quantity * price
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO trade_log (account_number, symbol, action, quantity, price, total_value, notes)
               VALUES (?,?,?,?,?,?,?)""",
            (account_number, symbol.upper(), action, quantity, price, total_value, notes),
        )
        await db.commit()
    return {"status": "ok", "symbol": symbol.upper(), "action": action,
            "quantity": quantity, "price": price, "total_value": total_value}


@app.get("/trade-log")
async def get_trade_log(limit: int = 50):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM trade_log ORDER BY traded_at DESC LIMIT ?", (limit,)
        ) as cur:
            rows = await cur.fetchall()
    return {"trades": [dict(r) for r in rows], "count": len(rows)}


@app.get("/earnings")
async def get_upcoming_earnings(days_ahead: int = 14):
    earnings = await fetch_earnings_calendar(days_ahead)
    return {"earnings": earnings, "count": len(earnings)}


# ── Analysis endpoints ────────────────────────────────────────────────────────

@app.post("/analysis/morning-brief")
async def morning_brief(send_telegram: bool = False):
    result = await generate_morning_brief()
    sent = False
    if send_telegram:
        from app.notifications.telegram_bot import send_message
        from app.notifications.formatters import fmt_morning_brief
        sent = await send_message(fmt_morning_brief(result), force=True)
    return {"status": "ok", "brief": result, "sent_to_telegram": sent}


@app.post("/analysis/signal")
async def signal(symbol: str):
    result = await generate_signal(symbol.upper())
    return {"status": "ok", "signal": result}




@app.get("/analysis/ytd-coach")
async def ytd_coach():
    result = await generate_ytd_coach()
    return {"status": "ok", "coaching": result}


@app.get("/analysis/portfolio-intelligence")
async def portfolio_intelligence():
    """
    Full portfolio intelligence report: sector exposure, concentration risk,
    per-holding efficiency scores, regime alignment, and Haiku action suggestions.
    """
    result = await generate_portfolio_intelligence()
    return {"status": "ok", "data": result}


@app.post("/analysis/earnings-prep")
async def earnings_prep(symbol: str, earnings_date: str):
    result = await generate_earnings_prep(symbol.upper(), earnings_date)
    return {"status": "ok", "prep": result}


@app.get("/signals")
async def get_signals(limit: int = 20):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM signals ORDER BY created_at DESC LIMIT ?", (limit,)
        ) as cur:
            rows = await cur.fetchall()
    return {"signals": [dict(r) for r in rows], "count": len(rows)}


@app.get("/macro")
async def macro():
    snapshot = await get_macro_snapshot()
    return {"status": "ok", "macro": snapshot}


@app.get("/risk")
async def risk_check():
    alerts = await check_all_positions()
    summary = await get_position_risk_summary()
    return {"alerts": alerts, "summary": summary}


@app.get("/analysis/daily-cost")
async def daily_cost():
    cost = await get_daily_cost()
    return {"today_usd": round(cost, 4), "budget_usd": 0.15,
            "remaining_usd": round(max(0, 0.15 - cost), 4)}


# ── Screener & Preemptive endpoints ──────────────────────────────────────────

@app.get("/screener/momentum")
async def screener_momentum():
    results = screen_momentum()
    return {"status": "ok", "results": results[:20], "count": len(results)}


@app.get("/screener/oversold")
async def screener_oversold():
    results = screen_oversold()
    return {"status": "ok", "results": results[:20], "count": len(results)}


@app.get("/screener/custom")
async def screener_custom(sector: str = None, min_market_cap: str = "+Mid (over $2bln)"):
    filters = {"Market Cap.": min_market_cap}
    if sector:
        filters["Sector"] = sector
    results = screen_stocks(filters)
    return {"status": "ok", "results": results[:20], "count": len(results)}


@app.get("/sectors")
async def sector_rotation():
    sectors = await get_sector_performance()
    return {"status": "ok", "sectors": sectors}


@app.post("/analysis/foresight")
async def foresight_report():
    result = await generate_foresight_report()
    return {"status": "ok", "report": result}


# ── Performance & Health endpoints ───────────────────────────────────────────

@app.get("/performance/signal-accuracy")
async def signal_accuracy():
    accuracy = await get_signal_accuracy()
    return {"status": "ok", "accuracy": accuracy}


@app.get("/performance/signal-outcomes")
async def signal_outcomes():
    from app.performance.signal_event_tracker import get_signal_outcome_stats
    data = await get_signal_outcome_stats()
    return {"status": "ok", **data}


@app.post("/performance/compute-outcomes")
async def compute_outcomes():
    """Manually trigger outcome computation for pending signal events."""
    from app.performance.signal_event_tracker import compute_pending_outcomes
    count = await compute_pending_outcomes()
    return {"status": "ok", "computed": count}


@app.get("/performance/roi")
async def roi_report():
    report = await get_monthly_roi_report()
    return {"status": "ok", "report": report}


@app.post("/performance/resolve-signals")
async def resolve_signals():
    count = await resolve_old_signals()
    return {"status": "ok", "resolved": count}


@app.get("/performance/health")
async def api_health():
    results = await check_all_apis()
    all_ok = all(v == "ok" for v in results.values())
    return {"status": "ok" if all_ok else "degraded", "apis": results}


@app.get("/performance/series")
async def performance_series():
    """Rolling win-rate + cumulative alpha time-series for dashboard charts."""
    from app.performance.attribution import get_performance_series
    data = await get_performance_series()
    return {"status": "ok", **data}


@app.get("/performance/attribution")
async def performance_attribution():
    """Compute this week's attribution snapshot and return it."""
    from app.performance.attribution import compute_weekly_attribution
    data = await compute_weekly_attribution()
    return {"status": "ok", "attribution": data}


@app.get("/performance/correction-proposals")
async def list_correction_proposals(proposal_status: str = "all"):
    from app.performance.attribution import get_correction_proposals
    proposals = await get_correction_proposals(proposal_status)
    return {"status": "ok", "proposals": proposals}


@app.post("/performance/correction-proposals/generate")
async def generate_correction_proposals():
    """Run the auto-analysis and generate any new correction proposals."""
    from app.performance.attribution import auto_generate_proposals
    created = await auto_generate_proposals()
    return {"status": "ok", "created": len(created), "proposals": created}


@app.post("/performance/correction-proposals/{proposal_id}/approve")
async def approve_correction_proposal(proposal_id: int):
    from app.performance.attribution import apply_correction_proposal
    result = await apply_correction_proposal(proposal_id)
    return {"status": "ok", **result}


@app.post("/performance/correction-proposals/{proposal_id}/reject")
async def reject_correction_proposal_endpoint(proposal_id: int, reason: str = ""):
    from app.performance.attribution import reject_correction_proposal
    result = await reject_correction_proposal(proposal_id, reason)
    return {"status": "ok", **result}


@app.get("/performance/best-bet")
async def get_best_bet_endpoint(force_refresh: bool = False):
    from app.performance.best_bet import get_best_bet
    result = await get_best_bet(force_refresh=force_refresh)
    return result


@app.get("/performance/strategy-comparison")
async def get_strategy_comparison_endpoint():
    from app.performance.strategy_comparison import get_strategy_comparison
    return await get_strategy_comparison()


@app.post("/performance/strategy-comparison/run")
async def run_strategy_picks_endpoint(backfill: bool = False):
    from app.performance.strategy_comparison import run_strategy_forward_picks
    results = await run_strategy_forward_picks(backfill=backfill)
    return {"status": "ok", "picks": results, "backfill": backfill}


@app.post("/performance/strategy-comparison/outcomes")
async def compute_strategy_outcomes_endpoint():
    from app.performance.strategy_comparison import compute_strategy_outcomes
    count = await compute_strategy_outcomes()
    return {"status": "ok", "computed": count}


@app.get("/performance/cooldown")
async def get_cooldown_endpoint():
    from app.performance.signal_event_tracker import get_cooldown_list
    items = await get_cooldown_list()
    return {"status": "ok", "cooldown": items, "count": len(items)}


@app.post("/performance/cooldown/update")
async def update_cooldown_endpoint():
    from app.performance.signal_event_tracker import update_universe_cooldown
    blocked = await update_universe_cooldown()
    return {"status": "ok", "newly_blocked": blocked, "count": len(blocked)}


@app.delete("/performance/cooldown/{ticker}")
async def remove_cooldown_endpoint(ticker: str):
    from app.performance.signal_event_tracker import remove_from_cooldown
    await remove_from_cooldown(ticker.upper())
    return {"status": "ok", "removed": ticker.upper()}


# ── Config endpoints ──────────────────────────────────────────────────────────

@app.get("/config")
async def get_config():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM agent_config ORDER BY group_name, key") as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    grouped: dict[str, list] = {}
    for r in rows:
        g = r["group_name"] or "General"
        grouped.setdefault(g, []).append(r)
    return {"config": rows, "grouped": grouped}


@app.put("/config")
async def update_config(request: Request):
    updates: dict[str, Any] = await request.json()
    async with aiosqlite.connect(DB_PATH) as db:
        for key, value in updates.items():
            await db.execute(
                "UPDATE agent_config SET value = ?, updated_at = ? WHERE key = ?",
                (str(value), datetime.now(UTC).isoformat(), key),
            )
        await db.commit()
    return {"status": "ok", "updated": list(updates.keys())}


# ── Scheduler endpoints ───────────────────────────────────────────────────────

@app.get("/scheduler/schedules")
async def get_schedules():
    """List all schedules with live next_run and enabled state."""
    sched = app.state.scheduler
    items = await list_schedules(sched)
    return {"status": "ok", "schedules": items, "count": len(items)}


@app.put("/scheduler/schedules/{job_id}/toggle")
async def toggle_job(job_id: str):
    """Pause or resume a scheduled job without restarting the server."""
    sched = app.state.scheduler
    result = await toggle_schedule(job_id, sched)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return {"status": "ok", **result}


@app.put("/scheduler/schedules/{job_id}")
async def edit_schedule(job_id: str, request: Request):
    """Update name, description, delivery_channel, telegram_enabled, or timing of a schedule."""
    body = await request.json()
    result = await update_schedule(job_id, body, app.state.scheduler)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return {"status": "ok", **result}


@app.delete("/scheduler/schedules/{job_id}")
async def remove_schedule(job_id: str):
    """Remove a schedule permanently."""
    sched = app.state.scheduler
    result = await delete_schedule(job_id, sched)
    return {"status": "ok", **result}


@app.post("/scheduler/schedules/{job_id}/run-now")
async def run_job_now(job_id: str):
    """Trigger a scheduled job to run immediately (one-shot)."""
    sched = app.state.scheduler
    job = sched.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")
    sched.modify_job(job_id, next_run_time=datetime.now(UTC))
    return {"status": "ok", "job_id": job_id, "message": "Job queued for immediate execution"}


# ── Stock of the day ──────────────────────────────────────────────────────────

@app.get("/analysis/stock-of-day")
async def stock_of_day():
    result = await generate_stock_of_day()
    return {"status": "ok", "pick": result}


@app.get("/analysis/sotd/full")
async def sotd_full(force_refresh: bool = False):
    """Full V2 SOTD pipeline result with market context, all candidates, and score breakdowns."""
    try:
        result = await run_sotd_pipeline(force_refresh=force_refresh)
    except Exception:
        reset_pipeline_lock()
        raise
    return {"status": "ok", "data": result}


@app.get("/analysis/sotd/stream")
async def sotd_stream(force_refresh: bool = True):
    """SSE endpoint — streams pipeline progress events then the final result."""
    import asyncio as _asyncio

    queue: _asyncio.Queue = _asyncio.Queue()

    async def emit(event: dict):
        await queue.put(event)

    async def run():
        try:
            result = await run_sotd_pipeline(force_refresh=force_refresh, emit=emit)
            await queue.put({"step": "complete", "status": "done", "data": result})
        except Exception as e:
            logger.error("sotd_stream pipeline error: %s", e)
            reset_pipeline_lock()
            await queue.put({"step": "error", "status": "error", "msg": str(e)})

    _asyncio.create_task(run())

    async def generate():
        while True:
            try:
                event = await _asyncio.wait_for(queue.get(), timeout=180.0)
            except _asyncio.TimeoutError:
                yield f"data: {json.dumps({'step': 'error', 'status': 'error', 'msg': 'Pipeline timed out after 3 minutes'})}\n\n"
                break
            yield f"data: {json.dumps(event)}\n\n"
            if event.get("step") in ("complete", "error"):
                break

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.get("/analysis/sotd/history")
async def sotd_history():
    """All SOTD picks with entry price and current price gain."""
    import asyncio

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT pick_date, symbol, regime, signal_json FROM stock_picks ORDER BY pick_date DESC"
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]

    if not rows:
        return {"status": "ok", "picks": []}

    symbols = list({r["symbol"] for r in rows})

    def _fetch_prices():
        import yfinance as yf
        import warnings
        warnings.filterwarnings("ignore")
        result = {}
        try:
            tickers = " ".join(symbols)
            raw = yf.download(tickers, period="6mo", interval="1d", auto_adjust=True, progress=False)
            if raw.empty:
                return result
            # Handle single vs multi ticker column structure
            if len(symbols) == 1:
                sym = symbols[0]
                closes = raw["Close"]
                for dt, price in closes.items():
                    d = str(dt)[:10]
                    if sym not in result:
                        result[sym] = {}
                    result[sym][d] = round(float(price), 4)
            else:
                # MultiIndex — detect column order
                if hasattr(raw["Close"], "columns"):
                    closes = raw["Close"]
                else:
                    closes = raw.xs("Close", axis=1, level=0) if "Close" in raw.columns.get_level_values(0) else raw.xs("Close", axis=1, level=1)
                for sym in closes.columns:
                    result[sym] = {}
                    for dt, price in closes[sym].items():
                        if price and str(price) != "nan":
                            result[sym][str(dt)[:10]] = round(float(price), 4)
        except Exception as e:
            logger.warning("sotd_history price fetch error: %s", e)
        return result

    try:
        prices_by_sym = await asyncio.wait_for(
            asyncio.get_event_loop().run_in_executor(None, _fetch_prices),
            timeout=15.0
        )
    except asyncio.TimeoutError:
        prices_by_sym = {}

    picks = []
    today = datetime.now().strftime("%Y-%m-%d")

    for row in rows:
        sym = row["symbol"]
        if not sym:
            continue  # no-trade day — no pick to show
        pick_date = row["pick_date"]
        sig = {}
        try:
            sig = json.loads(row["signal_json"] or "{}")
        except Exception:
            pass

        sotd = sig.get("stock_of_the_day") or {}
        metrics = sotd.get("metrics") or {}

        entry_price = metrics.get("price")
        sym_prices  = prices_by_sym.get(sym, {})

        # Use the price from the pick date (or closest after)
        if not entry_price:
            sorted_dates = sorted(sym_prices.keys())
            for d in sorted_dates:
                if d >= pick_date:
                    entry_price = sym_prices[d]
                    break

        # Current price = most recent available
        current_price = None
        if sym_prices:
            current_price = sym_prices.get(today) or sym_prices.get(sorted(sym_prices.keys())[-1])

        gain_pct = None
        if entry_price and current_price and entry_price > 0:
            gain_pct = round((current_price - entry_price) / entry_price * 100, 2)

        days_held = None
        try:
            from datetime import date as _date
            d0 = _date.fromisoformat(pick_date)
            d1 = _date.today()
            days_held = (d1 - d0).days
        except Exception:
            pass

        picks.append({
            "pick_date":        pick_date,
            "symbol":           sym,
            "company":          sotd.get("company_name", sym),
            "sector":           sotd.get("sector", ""),
            "regime":           row["regime"],
            "confidence_score": sotd.get("confidence_score"),
            "signal_type":      sotd.get("signal_type", ""),
            "summary":          sotd.get("summary", ""),
            "entry_price":      round(entry_price, 2) if entry_price else None,
            "current_price":    round(current_price, 2) if current_price else None,
            "gain_pct":         gain_pct,
            "days_held":        days_held,
        })

    return {"status": "ok", "picks": picks}


@app.get("/analysis/price-history/{symbol}")
async def price_history(symbol: str, days: int = 30):
    """OHLCV price history for mini chart. Days: 10–90."""
    import asyncio
    days = max(10, min(90, days))

    def _download():
        import warnings
        warnings.filterwarnings("ignore")
        df = yf.download(symbol.upper(), period=f"{days}d", auto_adjust=True, progress=False)
        if isinstance(df.columns, pd.MultiIndex):
            df = pd.DataFrame({
                "Open":   df["Open"].iloc[:, 0],
                "High":   df["High"].iloc[:, 0],
                "Low":    df["Low"].iloc[:, 0],
                "Close":  df["Close"].iloc[:, 0],
                "Volume": df["Volume"].iloc[:, 0],
            }).dropna()
        return df

    df = await asyncio.to_thread(_download)
    if df is None or df.empty:
        raise HTTPException(status_code=404, detail=f"No price data found for {symbol.upper()}")

    records = []
    for idx, row in df.iterrows():
        records.append({
            "date":   str(idx.date() if hasattr(idx, "date") else idx),
            "open":   round(float(row["Open"]), 2),
            "high":   round(float(row["High"]), 2),
            "low":    round(float(row["Low"]), 2),
            "close":  round(float(row["Close"]), 2),
            "volume": int(row["Volume"]),
        })

    return {"symbol": symbol.upper(), "days": days, "data": records, "count": len(records)}


# ── Deep Dive endpoints ───────────────────────────────────────────────────────

@app.post("/analysis/deep-dive")
async def deep_dive(symbol: str, save: bool = False):
    """Run a full deep-dive analysis on any ticker. Optionally save to deep_dive_log."""
    symbol = symbol.upper().strip()
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")
    result = await generate_deep_dive(symbol)
    row_id = None
    if save:
        row_id = await save_deep_dive(symbol, result)
    return {"status": "ok", "symbol": symbol, "result": result, "saved_id": row_id}


@app.post("/analysis/deep-dive/{dive_id}/save")
async def save_existing_deep_dive(dive_id: int):
    """Mark an already-returned deep-dive result as saved (called after the fact)."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE deep_dive_log SET saved = 1 WHERE id = ?", (dive_id,))
        await db.commit()
    return {"status": "ok", "saved_id": dive_id}


@app.get("/analysis/deep-dive/saved")
async def get_saved_deep_dives():
    """List all saved deep-dive analyses."""
    rows = await list_saved_deep_dives()
    return {"status": "ok", "dives": rows, "count": len(rows)}


@app.get("/analysis/deep-dive/saved/{dive_id}")
async def get_saved_deep_dive(dive_id: int):
    """Fetch a single saved deep-dive result by id."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM deep_dive_log WHERE id = ?", (dive_id,)
        ) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="not found")
    data = dict(row)
    for field in ("technicals_json", "fundamentals_json", "full_result_json"):
        if data.get(field):
            try:
                data[field] = json.loads(data[field])
            except Exception:
                pass
    return {"status": "ok", "dive": data}


# ── Fundamental Intelligence endpoints ───────────────────────────────────────

@app.get("/analysis/fundamentals/{symbol}")
async def get_fundamentals(
    symbol: str,
    model: str = "haiku",
    force_refresh: bool = False,
    signal_type: str = None,
    confidence_score: int = None,
    regime: str = None,
):
    """
    Fetch fundamental analysis for a symbol.
    Caches per symbol per day. Re-runs LLM if model changes.
    Pass signal_type/confidence_score/regime to enrich the analysis with technical context.
    """
    from app.analysis.fundamental_engine import get_fundamental_analysis

    signal_data = None
    if confidence_score is not None:
        signal_data = {
            "signal_type":       signal_type or "MOMENTUM",
            "confidence_score":  confidence_score,
            "regime":            regime or "UNKNOWN",
            "key_drivers":       [],
        }

    result = await get_fundamental_analysis(
        symbol=symbol.upper(),
        model=model,
        signal_data=signal_data,
        force_refresh=force_refresh,
    )
    return {"status": "ok", **result}


# ── Filter Preset endpoints ───────────────────────────────────────────────────

@app.get("/config/filter-presets")
async def get_filter_presets():
    rows = await list_presets()
    return {"status": "ok", "presets": rows}


@app.get("/config/filter-presets/active")
async def get_active_filter_preset():
    p = await get_active_preset()
    return {"status": "ok", "preset": p}


@app.post("/config/filter-presets")
async def create_filter_preset(request: Request):
    body = await request.json()
    if not body.get("name"):
        raise HTTPException(status_code=400, detail="name is required")
    result = await create_preset(body)
    return {"status": "ok", "preset": result}


@app.put("/config/filter-presets/{preset_id}/activate")
async def activate_filter_preset(preset_id: int):
    result = await activate_preset(preset_id)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return {"status": "ok", "preset": result}


@app.put("/config/filter-presets/{preset_id}")
async def update_filter_preset(preset_id: int, request: Request):
    body = await request.json()
    result = await update_preset(preset_id, body)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return {"status": "ok", "preset": result}


@app.delete("/config/filter-presets/{preset_id}")
async def delete_filter_preset(preset_id: int):
    result = await delete_preset(preset_id)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return {"status": "ok", **result}


# ── Schedule builder endpoint ─────────────────────────────────────────────────

@app.post("/scheduler/schedules")
async def create_schedule(request: Request):
    """Create and immediately register a new custom schedule."""
    from app.scheduler.jobs import (
        job_morning_brief, job_risk_check, job_ytd_coach,
        job_vix, job_rss, job_edgar, job_gdelt,
        job_top_performers, job_sotd,
    )
    JOB_FN_MAP = {
        "morning_brief":  job_morning_brief,
        "risk_check":     job_risk_check,
        "ytd_coach":      job_ytd_coach,
        "vix":            job_vix,
        "rss":            job_rss,
        "edgar":          job_edgar,
        "gdelt":          job_gdelt,
        "top_performers": job_top_performers,
        "sotd":           job_sotd,
    }

    body = await request.json()
    job_type     = body.get("job_type", "")
    name         = body.get("name", "").strip()
    cron_expr    = body.get("cron_expression", "").strip()
    interval_min = body.get("interval_minutes")
    schedule_type = body.get("schedule_type", "cron")
    delivery      = body.get("delivery_channel", "both")
    telegram_on   = int(body.get("telegram_enabled", True))

    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    if job_type not in JOB_FN_MAP:
        raise HTTPException(status_code=400, detail=f"unknown job_type. Valid: {list(JOB_FN_MAP)}")

    # Build a unique job_id
    import re, time
    job_id = f"custom_{job_type}_{int(time.time())}"

    sched = app.state.scheduler
    from apscheduler.triggers.cron import CronTrigger
    from apscheduler.triggers.interval import IntervalTrigger
    import pytz
    ET = pytz.timezone("America/New_York")

    if schedule_type == "interval" and interval_min:
        trigger = IntervalTrigger(minutes=int(interval_min))
    elif cron_expr:
        parts = cron_expr.split()
        if len(parts) != 5:
            raise HTTPException(status_code=400, detail="cron_expression must have 5 fields: min hour dom mon dow")
        trigger = CronTrigger.from_crontab(cron_expr, timezone=ET)
    else:
        raise HTTPException(status_code=400, detail="provide cron_expression or interval_minutes")

    sched.add_job(JOB_FN_MAP[job_type], trigger, id=job_id, replace_existing=True, misfire_grace_time=300)

    now = datetime.now(UTC).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO schedules
               (job_id, name, description, schedule_type, cron_expression, interval_minutes,
                enabled, delivery_channel, telegram_enabled, created_at, updated_at)
               VALUES (?,?,?,?,?,?,1,?,?,?,?)""",
            (job_id, name, body.get("description", ""), schedule_type,
             cron_expr or None, interval_min, delivery, telegram_on, now, now),
        )
        await db.commit()

    return {"status": "ok", "job_id": job_id, "name": name}


@app.put("/scheduler/schedules/{job_id}/telegram")
async def set_schedule_telegram(job_id: str, request: Request):
    """Toggle Telegram output for a specific schedule."""
    body = await request.json()
    enabled = int(body.get("telegram_enabled", True))
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE schedules SET telegram_enabled = ?, updated_at = ? WHERE job_id = ?",
            (enabled, datetime.now(UTC).isoformat(), job_id),
        )
        await db.commit()
    return {"status": "ok", "job_id": job_id, "telegram_enabled": bool(enabled)}


# ── Top Performers endpoint ───────────────────────────────────────────────────

@app.get("/analysis/top-performers")
async def top_performers_endpoint():
    """Run the Top Performers of the Day analysis on demand."""
    data = await get_top_performers()
    return {"status": "ok", "data": data}


@app.get("/market/quotes")
async def market_quotes(symbols: str = "SPY,^VIX"):
    """Live quotes (price, daily %, YTD %) for a comma-separated list of symbols via yfinance."""
    import asyncio
    from datetime import date as _date
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]

    def _fetch():
        result = {}
        for sym in syms:
            try:
                t          = yf.Ticker(sym)
                info       = t.fast_info
                price      = float(info.last_price)     if info.last_price     else None
                prev_close = float(info.previous_close) if info.previous_close else None
                change_pct = round((price - prev_close) / prev_close * 100, 2) if price and prev_close else None

                # YTD: fetch history from Jan 1 of this year
                ytd_pct = None
                if price:
                    try:
                        hist = t.history(start=f"{_date.today().year}-01-01", interval="1d", auto_adjust=True)
                        if not hist.empty:
                            jan_price = float(hist["Close"].dropna().iloc[0])
                            ytd_pct   = round((price - jan_price) / jan_price * 100, 2)
                    except Exception:
                        pass

                result[sym] = {
                    "symbol": sym,
                    "price": round(price, 2) if price else None,
                    "change_pct": change_pct,
                    "ytd_pct": ytd_pct,
                }
            except Exception:
                result[sym] = {"symbol": sym, "price": None, "change_pct": None, "ytd_pct": None}
        return result

    try:
        data = await asyncio.wait_for(
            asyncio.get_event_loop().run_in_executor(None, _fetch),
            timeout=20.0
        )
    except asyncio.TimeoutError:
        data = {sym: {"symbol": sym, "price": None, "change_pct": None, "ytd_pct": None, "error": "timeout"} for sym in syms}
    return {"status": "ok", "quotes": data}


# ── Daemon control ─────────────────────────────────────────────────────────────

import subprocess as _subprocess

_PLIST_LABEL = "com.investmentagent"
_PLIST_PATH  = str(_os.path.expanduser("~/Library/LaunchAgents/com.investmentagent.plist"))


def _launchctl(*args) -> tuple[int, str]:
    r = _subprocess.run(["launchctl", *args], capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()


@app.get("/system/daemon")
async def daemon_status():
    code, out = _launchctl("list", _PLIST_LABEL)
    running = code == 0
    pid = None
    if running:
        for line in out.splitlines():
            if '"PID"' in line or line.strip().startswith('"PID"'):
                try:
                    pid = int(line.split("=")[-1].strip().rstrip(";"))
                except Exception:
                    pass
    return {"running": running, "pid": pid, "detail": out}


@app.post("/system/daemon/start")
async def daemon_start():
    code, out = _launchctl("load", _PLIST_PATH)
    return {"ok": code == 0, "detail": out}


@app.post("/system/daemon/stop")
async def daemon_stop():
    code, out = _launchctl("unload", _PLIST_PATH)
    return {"ok": code == 0, "detail": out}


@app.post("/system/daemon/restart")
async def daemon_restart():
    _launchctl("unload", _PLIST_PATH)
    import asyncio
    await asyncio.sleep(1)
    code, out = _launchctl("load", _PLIST_PATH)
    return {"ok": code == 0, "detail": out}


# ── Virtual Portfolio ──────────────────────────────────────────────────────────

from app.analysis.virtual_engine import (
    get_portfolio_summary, get_open_positions, evaluate_positions,
    reload_wallet, backfill_from_history,
)


@app.get("/virtual/summary")
async def virtual_summary():
    data = await get_portfolio_summary()
    return {"status": "ok", "data": data}


@app.get("/virtual/positions")
async def virtual_positions():
    rows = await get_open_positions()
    return {"status": "ok", "positions": rows}


@app.get("/virtual/trades")
async def virtual_trades(limit: int = 50):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT vt.*, vp.ticker, vp.entry_date, vp.entry_price, vp.entry_score
               FROM virtual_trades vt
               JOIN virtual_positions vp ON vt.position_id = vp.id
               ORDER BY vt.trade_date DESC, vt.id DESC LIMIT ?""", (limit,)
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    return {"status": "ok", "trades": rows}


@app.get("/virtual/closed")
async def virtual_closed(limit: int = 50):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT * FROM virtual_positions
               WHERE account_id = 1 AND status = 'CLOSED'
               ORDER BY exit_date DESC LIMIT ?""", (limit,)
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    return {"status": "ok", "positions": rows}


@app.get("/virtual/decisions")
async def virtual_decisions(limit: int = 100, action: str = None, ticker: str = None):
    query = "SELECT * FROM decision_log WHERE account_id = 1"
    params: list = []
    if action:
        query += " AND action = ?"
        params.append(action.upper())
    if ticker:
        query += " AND ticker = ?"
        params.append(ticker.upper())
    query += " ORDER BY date DESC, id DESC LIMIT ?"
    params.append(limit)

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(query, params) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    return {"status": "ok", "decisions": rows}


@app.get("/virtual/performance")
async def virtual_performance():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM portfolio_daily WHERE account_id = 1 ORDER BY date ASC"
        ) as cur:
            portfolio = [dict(r) for r in await cur.fetchall()]
        async with db.execute(
            "SELECT * FROM benchmark_daily ORDER BY date ASC"
        ) as cur:
            benchmark = [dict(r) for r in await cur.fetchall()]
    return {"status": "ok", "portfolio": portfolio, "benchmark": benchmark}


@app.post("/virtual/reload")
async def virtual_reload(amount: float = 2000.0):
    result = await reload_wallet(amount)
    return {"status": "ok", **result}


@app.post("/virtual/backfill")
async def virtual_backfill():
    result = await backfill_from_history()
    return {"status": "ok", **result}


@app.post("/virtual/evaluate")
async def virtual_evaluate_now():
    actions = await evaluate_positions()
    return {"status": "ok", "actions": actions, "count": len(actions)}


# ── Strategy Lab ──────────────────────────────────────────────────────────────

from app.simulator.job_runner import (
    create_run, launch_job, get_run, get_results, list_runs,
    cancel_run,
)


@app.get("/strategy/strategies")
async def get_strategies():
    """List all available strategy configs."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM strategy_configs ORDER BY id"
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    return {"status": "ok", "strategies": rows}


@app.post("/strategy/run")
async def start_strategy_run(request: Request):
    """
    Launch a background strategy test job.
    Body:
      job_type:       'backtest' | 'simulation'
      strategy_ids:   [1, 2, 3] — which strategy_configs to test
      start_date:     'YYYY-MM-DD' (backtest only)
      end_date:       'YYYY-MM-DD' (backtest only)
      sweep_params:   true/false
      simulation_days: 30 (simulation only)
      seed:            42
      market_regime:  'BULL'|'BEAR'|'CHOP'
      volatility_level: 'LOW'|'MEDIUM'|'HIGH'
      sector_bias:    {Technology: 0.2, Energy: -0.1}
    """
    body        = await request.json()
    job_type    = body.get("job_type", "backtest")
    strat_ids   = body.get("strategy_ids", [1, 2, 3, 4, 5, 6, 7])
    sweep       = bool(body.get("sweep_params", False))

    # Load strategy configs
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        placeholders = ",".join("?" * len(strat_ids))
        async with db.execute(
            f"SELECT * FROM strategy_configs WHERE id IN ({placeholders})",
            strat_ids
        ) as cur:
            strategies = [dict(r) for r in await cur.fetchall()]

    if not strategies:
        raise HTTPException(status_code=400, detail="No valid strategy IDs found")

    initial_capital = float(body.get("initial_capital", 10_000))
    allocation_pct  = body.get("allocation_pct")       # None = use per-strategy default
    max_pos_override = body.get("max_positions_override")  # None = use per-strategy default

    # Apply run-level overrides to each strategy
    for s in strategies:
        if allocation_pct is not None:
            s["allocation_pct"] = float(allocation_pct)
        if max_pos_override is not None:
            s["max_positions"] = int(max_pos_override)

    config = {
        "job_type":         job_type,
        "start_date":       body.get("start_date", "2023-01-01"),
        "end_date":         body.get("end_date",   "2024-12-31"),
        "sweep_params":     sweep,
        "simulation_days":  body.get("simulation_days", 30),
        "seed":             body.get("seed", 42),
        "market_regime":    body.get("market_regime", "BULL"),
        "volatility_level": body.get("volatility_level", "MEDIUM"),
        "sector_bias":      body.get("sector_bias", {}),
        "initial_capital":  initial_capital,
    }

    run_id = await create_run(job_type, config, strategies)
    launch_job(run_id, job_type, config, strategies)

    return {"status": "ok", "run_id": run_id, "job_type": job_type, "strategies": len(strategies)}


@app.get("/strategy/runs")
async def get_strategy_runs(limit: int = 20):
    runs = await list_runs(limit)
    return {"status": "ok", "runs": runs}


@app.get("/strategy/run/{run_id}")
async def get_strategy_run(run_id: str):
    run = await get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return {"status": "ok", "run": run}


@app.get("/strategy/results/{run_id}")
async def get_strategy_results(run_id: str):
    run = await get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["status"] != "COMPLETED":
        return {"status": "ok", "run_status": run["status"], "results": []}
    results = await get_results(run_id)
    return {"status": "ok", "run_id": run_id, "results": results, "count": len(results)}


@app.post("/strategy/run/{run_id}/cancel")
async def cancel_strategy_run(run_id: str):
    ok = await cancel_run(run_id)
    return {"status": "ok", "cancelled": ok}


@app.post("/strategy/promote/{run_id}/{strategy_name}")
async def promote_strategy_to_live(run_id: str, strategy_name: str):
    """
    Promote a backtest winner to the live virtual portfolio.
    Finds the matching result, upserts its params into strategy_configs,
    then updates virtual_account to use that config.
    """
    results = await get_results(run_id)
    match   = next((r for r in results if r["strategy_name"] == strategy_name), None)
    if not match:
        raise HTTPException(status_code=404, detail=f"Strategy '{strategy_name}' not found in run {run_id}")

    params = match.get("params_json", {})
    base   = strategy_name.split("_b")[0]  # strip sweep variant suffix

    async with aiosqlite.connect(DB_PATH) as db:
        # Upsert a promoted config
        promo_name = f"Promoted_{strategy_name[:40]}"
        await db.execute(
            """INSERT OR REPLACE INTO strategy_configs
               (name, description, buy_threshold, max_positions, allocation_pct,
                min_hold_days, max_hold_days, profit_target_pct, stop_loss_pct,
                score_exit_threshold, regime_filter, is_active)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,0)""",
            (promo_name,
             f"Promoted from backtest run {run_id} — strategy {strategy_name}",
             params.get("buy_threshold", 80),
             params.get("max_positions", 5),
             params.get("allocation_pct", 20.0),
             params.get("min_hold_days", 30),
             params.get("max_hold_days", 90),
             params.get("profit_target_pct", 15.0),
             params.get("stop_loss_pct", -8.0),
             params.get("score_exit_threshold", 60),
             params.get("regime_filter", "ALL"))
        )
        async with db.execute(
            "SELECT id FROM strategy_configs WHERE name = ?", (promo_name,)
        ) as cur:
            row = await cur.fetchone()
        new_config_id = row[0]

        await db.execute(
            "UPDATE virtual_account SET config_id = ?, updated_at = ? WHERE id = 1",
            (new_config_id, datetime.now(UTC).isoformat())
        )
        await db.commit()

    logger.info("Promoted strategy %s (config_id=%d) to live virtual portfolio", strategy_name, new_config_id)
    return {
        "status":        "ok",
        "promoted_name": promo_name,
        "new_config_id": new_config_id,
        "params":        params,
        "message":       "Virtual portfolio will use these parameters from next evaluation.",
    }


# ── Daily Decision Log ─────────────────────────────────────────────────────────

@app.get("/decisions/daily")
async def get_daily_decisions(date: str = ""):
    """
    Aggregate everything the agent decided/did on a given date.
    date format: YYYY-MM-DD (defaults to today UTC)
    """
    if not date:
        date = datetime.now(UTC).strftime("%Y-%m-%d")

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # SOTD pick
        async with db.execute(
            "SELECT pick_date, symbol, regime, signal_json, market_context_json FROM stock_picks WHERE date(pick_date) = ?",
            (date,)
        ) as cur:
            sotd_row = await cur.fetchone()

        sotd = None
        if sotd_row:
            sig = json.loads(sotd_row["signal_json"] or "{}")
            mkt = json.loads(sotd_row["market_context_json"] or "{}")
            sotd = {
                "symbol":  sotd_row["symbol"],
                "regime":  sotd_row["regime"],
                "score":   sig.get("score"),
                "tier":    sig.get("tier"),
                "reasoning": sig.get("haiku_analysis") or sig.get("reasoning"),
                "market_context": {
                    "vix":      mkt.get("vix"),
                    "spy_10d":  mkt.get("spy_10d"),
                    "regime":   mkt.get("regime"),
                },
            }

        # Virtual portfolio decisions (BUY/SELL/HOLD)
        async with db.execute(
            """SELECT d.date, d.ticker, d.action, d.score_current, d.score_previous,
                      d.regime_current, d.return_pct, d.days_held, d.confidence, d.reasoning_json
               FROM decision_log d
               WHERE date(d.date) = ?
               ORDER BY d.date ASC""",
            (date,)
        ) as cur:
            rows = await cur.fetchall()

        decisions = []
        for r in rows:
            try:
                rationale = json.loads(r["reasoning_json"] or "{}")
            except Exception:
                rationale = {}
            decisions.append({
                "time":       r["date"],
                "ticker":     r["ticker"],
                "action":     r["action"],
                "score":      r["score_current"],
                "score_prev": r["score_previous"],
                "regime":     r["regime_current"],
                "return_pct": r["return_pct"],
                "days_held":  r["days_held"],
                "confidence": r["confidence"],
                "rationale":  rationale.get("rationale", ""),
                "why_selected": rationale.get("why_selected", []),
                "why_rejected": rationale.get("why_rejected", []),
                "risk_signals": rationale.get("risk_signals", []),
            })

        # AI / LLM calls
        async with db.execute(
            """SELECT job_name, model, input_tokens, output_tokens, cost_usd, ran_at
               FROM analysis_log WHERE date(ran_at) = ?
               ORDER BY ran_at ASC""",
            (date,)
        ) as cur:
            rows = await cur.fetchall()
        ai_calls = [dict(r) for r in rows]

        # Signals generated
        async with db.execute(
            """SELECT symbol, signal_type, score, action, reasoning, model_used, created_at
               FROM signals WHERE date(created_at) = ?
               ORDER BY created_at ASC""",
            (date,)
        ) as cur:
            rows = await cur.fetchall()
        signals = [dict(r) for r in rows]

        # Job health summary (sync_log counts per job)
        async with db.execute(
            """SELECT job_name, status, count(*) as cnt
               FROM sync_log WHERE date(ran_at) = ?
               GROUP BY job_name, status
               ORDER BY job_name""",
            (date,)
        ) as cur:
            rows = await cur.fetchall()
        job_counts: dict = {}
        for r in rows:
            jn = r["job_name"]
            if jn not in job_counts:
                job_counts[jn] = {"success": 0, "error": 0}
            job_counts[jn][r["status"]] = r["cnt"]
        job_health = [
            {"job": k, "success": v["success"], "error": v["error"]}
            for k, v in sorted(job_counts.items())
        ]

        # Available dates (for calendar navigation)
        async with db.execute(
            """SELECT DISTINCT date(pick_date) as d FROM stock_picks
               UNION SELECT DISTINCT date(date) as d FROM decision_log
               ORDER BY d DESC LIMIT 90"""
        ) as cur:
            rows = await cur.fetchall()
        available_dates = [r["d"] for r in rows]

        # All pipeline candidates from SOTD signal_json
        all_candidates = []
        if sotd_row:
            sig_full = json.loads(sotd_row["signal_json"] or "{}")
            all_candidates = sig_full.get("all_candidates", [])

        # All-time pick history recap: best/worst alpha_14d across evaluated picks
        async with db.execute(
            """SELECT se.ticker, se.pick_date, so.alpha_14d, so.return_14d, so.outcome
               FROM signal_events se
               JOIN signal_outcomes so ON so.signal_event_id = se.id
               WHERE so.alpha_14d IS NOT NULL
               ORDER BY se.pick_date DESC"""
        ) as cur:
            outcome_rows = [dict(r) for r in await cur.fetchall()]

        best_pick  = max(outcome_rows, key=lambda r: r["alpha_14d"]) if outcome_rows else None
        worst_pick = min(outcome_rows, key=lambda r: r["alpha_14d"]) if outcome_rows else None
        wins       = [r for r in outcome_rows if r["outcome"] == "win"]
        overall_wr = round(len(wins) / len(outcome_rows), 3) if outcome_rows else None

        pick_recap = {
            "total_evaluated": len(outcome_rows),
            "win_rate":        overall_wr,
            "best_pick":       best_pick,
            "worst_pick":      worst_pick,
        }

    total_ai_cost = round(sum(c["cost_usd"] or 0 for c in ai_calls), 6)

    # Cooldown list
    from app.performance.signal_event_tracker import get_cooldown_list
    cooldown = await get_cooldown_list()

    return {
        "date":            date,
        "sotd":            sotd,
        "all_candidates":  all_candidates,
        "pick_recap":      pick_recap,
        "cooldown":        cooldown,
        "decisions":       decisions,
        "ai_calls":        ai_calls,
        "signals":         signals,
        "job_health":      job_health,
        "total_ai_cost":   total_ai_cost,
        "available_dates": available_dates,
    }


# ── Stock Intelligence / Research endpoints ───────────────────────────────────

@app.post("/stock-analysis/ingest")
async def stock_analysis_ingest(request: Request):
    """Ingest a research note — extracts signals and stores embedding."""
    from app.analysis.stock_intelligence import ingest_note
    body = await request.json()
    ticker = (body.get("ticker") or "").strip().upper()
    text   = (body.get("text") or "").strip()
    source = body.get("source_label", "own_note")
    if not ticker:
        raise HTTPException(400, "ticker is required")
    if not text or len(text) < 10:
        raise HTTPException(400, "text must be at least 10 characters")
    result = await ingest_note(ticker, text, source)
    return result


@app.get("/stock-analysis/run/{ticker}")
async def stock_analysis_run(ticker: str):
    """Run full hybrid analysis for a ticker — retrieval + scoring + LLM synthesis."""
    from app.analysis.stock_intelligence import run_full_analysis
    ticker = ticker.upper().strip()
    result = await run_full_analysis(ticker)
    return result


@app.get("/stock-analysis/history/{ticker}")
async def stock_analysis_history(ticker: str, limit: int = 10):
    """Return past analysis runs for a ticker."""
    from app.analysis.stock_intelligence import get_analysis_history
    return await get_analysis_history(ticker.upper(), limit)


@app.get("/stock-analysis/notes/{ticker}")
async def stock_analysis_notes(ticker: str):
    """Return all stored intelligence notes for a ticker."""
    from app.analysis.stock_intelligence import get_notes
    return await get_notes(ticker.upper())


@app.delete("/stock-analysis/notes/{note_id}")
async def stock_analysis_delete_note(note_id: int):
    """Delete a stored note."""
    from app.analysis.stock_intelligence import delete_note
    deleted = await delete_note(note_id)
    if not deleted:
        raise HTTPException(404, f"note {note_id} not found")
    return {"deleted": True, "note_id": note_id}


@app.get("/stock-analysis/contradictions/{ticker}")
async def stock_analysis_contradictions(ticker: str):
    """Return thesis drift / contradiction alerts for a ticker."""
    from app.analysis.stock_intelligence import detect_contradictions
    return await detect_contradictions(ticker.upper())
