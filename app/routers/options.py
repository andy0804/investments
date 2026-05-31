"""
Options Trading Desk — FastAPI router.
All endpoints under /options-desk prefix.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

import aiosqlite
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel

from app.config import DB_PATH
from app.analysis.options_engine import (
    fetch_options_chain, get_expirations, get_underlying_price,
    scenario_pnl as engine_scenario_pnl,
    bs_price, bs_greeks, RISK_FREE_RATE, _dte_years, _dte,
    COMMISSION_PER_CONTRACT, MULTIPLIER,
)
from app.analysis.options_simulator import (
    get_account, open_position_with_chain, close_position,
    revalue_all_positions, list_positions, get_scenario_pnl,
    ensure_account, open_multi_leg_position,
    get_position_alerts, get_performance_curve,
)
from app.analysis.aria_agent import (
    analyze_and_trade, check_aria_exits,
    get_aria_account, list_aria_positions, list_aria_decisions, get_scoreboard,
)
from app.analysis.claude_engine import call_claude

log = logging.getLogger(__name__)
router = APIRouter(prefix="/options-desk", tags=["options"])


# ── Pydantic models ───────────────────────────────────────────────────────────

class OpenPositionRequest(BaseModel):
    ticker: str
    expiry: str
    strike: float
    option_type: str   # "call" or "put"
    action: str        # "BUY" or "SELL"
    quantity: int = 1
    note: str = ""


class ClosePositionRequest(BaseModel):
    note: str = ""


class ScenarioRequest(BaseModel):
    leg_id: int
    price_range_pct: float = 0.20
    steps: int = 11


class LiveScenarioRequest(BaseModel):
    ticker: str
    expiry: str
    strike: float
    option_type: str
    action: str
    fill_price: float
    quantity: int = 1
    price_range_pct: float = 0.20
    steps: int = 11
    iv_override: float | None = None  # as decimal e.g. 0.35


class MultiLegRequest(BaseModel):
    ticker: str
    expiry: str
    strategy_label: str   # e.g. "Bull Call Spread"
    legs: list[dict]      # [{strike, option_type, action, quantity}, ...]
    note: str = ""


class AICommentaryRequest(BaseModel):
    position_id: int
    question: str = ""


# ── Account ───────────────────────────────────────────────────────────────────

@router.get("/account")
async def get_options_account():
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            await ensure_account(db)
            acct = await get_account(db)
        return {"account": acct}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/account/reset")
async def reset_options_account():
    """Reset account to $10k (wipes all positions — use with care)."""
    try:
        now_str = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute("DELETE FROM options_greeks_history")
            await db.execute("DELETE FROM options_risk_snapshots")
            await db.execute("DELETE FROM options_transactions")
            await db.execute("DELETE FROM options_legs")
            await db.execute("DELETE FROM options_trade_notes")
            await db.execute("DELETE FROM options_positions")
            await db.execute(
                "INSERT OR REPLACE INTO options_account "
                "(id, cash, initial_capital, realized_pnl, total_commissions, created_at, updated_at) "
                "VALUES (1, 10000.0, 10000.0, 0.0, 0.0, ?, ?)",
                (now_str, now_str),
            )
            await db.commit()
        return {"ok": True, "message": "Account reset to $10,000"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Chain ─────────────────────────────────────────────────────────────────────

@router.get("/chain/{ticker}/expirations")
async def get_option_expirations(ticker: str):
    try:
        expirations = get_expirations(ticker.upper())
        return {"ticker": ticker.upper(), "expirations": expirations}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/chain/{ticker}/{expiry}")
async def get_option_chain(ticker: str, expiry: str):
    try:
        chain = fetch_options_chain(ticker.upper(), expiry)
        return chain
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/underlying/{ticker}")
async def get_underlying(ticker: str):
    price = get_underlying_price(ticker.upper())
    if price is None:
        raise HTTPException(status_code=404, detail=f"Could not fetch price for {ticker}")
    return {"ticker": ticker.upper(), "price": price}


# ── Positions ─────────────────────────────────────────────────────────────────

@router.get("/positions")
async def list_open_positions():
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            positions = await list_positions(db, "OPEN")
        return {"positions": positions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/positions/closed")
async def list_closed_positions():
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            positions = await list_positions(db, "CLOSED")
        return {"positions": positions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


async def _aria_background(pos_id: int, ticker: str, expiry: str, legs: list[dict]):
    """Fire-and-forget ARIA analysis after user opens a position."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            await analyze_and_trade(pos_id, ticker, expiry, legs, db)
    except Exception as e:
        log.warning("ARIA background task failed: %s", e)


@router.post("/positions/open")
async def open_options_position(req: OpenPositionRequest, background_tasks: BackgroundTasks):
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            result = await open_position_with_chain(
                db,
                req.ticker.upper(),
                req.expiry,
                req.strike,
                req.option_type,
                req.action,
                req.quantity,
                req.note,
            )
        # Trigger ARIA in background — non-blocking
        background_tasks.add_task(
            _aria_background,
            result["position_id"],
            req.ticker.upper(),
            req.expiry,
            [{"strike": req.strike, "option_type": req.option_type,
              "action": req.action, "quantity": req.quantity}],
        )
        return {"ok": True, **result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.exception("open_options_position")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/positions/{position_id}/close")
async def close_options_position(position_id: int, req: ClosePositionRequest):
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            result = await close_position(db, position_id, req.note)
        return {"ok": True, **result}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Revaluation ───────────────────────────────────────────────────────────────

@router.post("/revalue")
async def trigger_revaluation():
    """Manually trigger mark-to-market (also runs every 15 min via scheduler)."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            result = await revalue_all_positions(db)
        return {"ok": True, **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Scenario P&L ──────────────────────────────────────────────────────────────

@router.post("/scenario/from-leg")
async def scenario_from_leg(req: ScenarioRequest):
    """Compute P&L grid for an existing leg in the DB."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            rows = await get_scenario_pnl(req.leg_id, db, req.price_range_pct, req.steps)
        return {"rows": rows}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/scenario/live")
async def scenario_live(req: LiveScenarioRequest):
    """
    Compute P&L grid from live parameters (no DB leg required).
    Useful for the builder panel before opening a position.
    """
    try:
        S0 = get_underlying_price(req.ticker.upper())
        if S0 is None:
            raise ValueError(f"Cannot fetch price for {req.ticker}")
        T = _dte_years(req.expiry)
        if req.iv_override is not None:
            iv = req.iv_override
        else:
            # Fetch from chain
            chain = fetch_options_chain(req.ticker.upper(), req.expiry)
            contracts = chain["calls"] if req.option_type.lower() == "call" else chain["puts"]
            match = next((c for c in contracts if abs(c["strike"] - req.strike) < 0.001), None)
            iv = (match.get("iv") or 30.0) / 100.0 if match else 0.30
        is_call = req.option_type.lower() == "call"
        rows = engine_scenario_pnl(
            S0, req.strike, T, RISK_FREE_RATE, iv, is_call,
            req.action, req.fill_price, req.quantity,
            req.price_range_pct, req.steps,
        )
        return {"rows": rows, "underlying": S0, "iv": round(iv * 100, 2)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── AI Commentary (explicit user request only) ────────────────────────────────

@router.post("/ai-commentary")
async def get_ai_commentary(req: AICommentaryRequest):
    """
    On-demand Sonnet commentary for a specific position.
    NOT triggered automatically — only when user explicitly requests.
    """
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            positions = await list_positions(db, "OPEN")
            pos = next((p for p in positions if p["id"] == req.position_id), None)
            if not pos:
                # Try closed
                closed = await list_positions(db, "CLOSED")
                pos = next((p for p in closed if p["id"] == req.position_id), None)
            if not pos:
                raise HTTPException(status_code=404, detail=f"Position {req.position_id} not found")

            acct = await get_account(db)

        legs = pos.get("legs", [])
        if not legs:
            raise HTTPException(status_code=400, detail="Position has no legs")

        leg = legs[0]
        dte = _dte(leg["expiry"])
        unrealized = pos.get("unrealized_pnl", 0)
        cost = pos.get("total_cost", 0)
        pnl_pct = round(unrealized / abs(cost) * 100, 1) if cost else 0

        prompt = f"""You are an expert options trader reviewing this position for a retail investor.

Position summary:
- Ticker: {pos['ticker']}
- Strategy: {leg['action']} {leg['quantity']}x {leg['option_type'].upper()} @ Strike ${leg['strike']}
- Expiry: {leg['expiry']} ({dte} DTE)
- Fill price: ${leg['fill_price']:.3f} per share (${leg['fill_price'] * 100 * leg['quantity']:.2f} total)
- Entry IV: {leg.get('iv_at_entry', '?')}%
- Entry Delta: {leg.get('delta_at_entry', '?')}
- Current price: ${leg.get('current_price', '?')} | Current IV: {leg.get('current_iv', '?')}%
- Current delta: {leg.get('current_delta', '?')} | Theta: {leg.get('current_theta', '?')}/day
- Unrealized P&L: ${unrealized:.2f} ({pnl_pct:+.1f}%)
- Account net liq: ${acct['net_liq']:.2f} of ${acct['initial_capital']:.2f}

User question: {req.question if req.question else 'Give me a brief analysis of this position: risks, key levels to watch, and what would make you exit early.'}

Respond in 3–5 bullet points. Be direct, quantitative where possible. Explain any options terminology in plain English."""

        # call_claude returns parsed JSON; wrap prompt to return plain text
        text_prompt = prompt + "\n\nRespond as plain text bullet points only — no JSON."
        result = await call_claude(text_prompt, model="sonnet", job_name="options_commentary")
        # If JSON parse fails, result has 'raw' key with the actual text
        commentary = result.get("raw") or str(result)
        return {"commentary": commentary, "position_id": req.position_id}
    except HTTPException:
        raise
    except Exception as e:
        log.exception("ai_commentary")
        raise HTTPException(status_code=500, detail=str(e))


# ── Risk snapshot ─────────────────────────────────────────────────────────────

@router.get("/market-status")
async def get_market_status():
    """Return whether the US equity market is currently open."""
    import pytz
    from datetime import datetime
    ET = pytz.timezone("America/New_York")
    now = datetime.now(ET)
    weekday = now.weekday()  # 0=Mon … 6=Sun
    is_weekend = weekday >= 5

    # US market holidays 2025–2026 (observed dates)
    HOLIDAYS = {
        "2025-01-01","2025-01-20","2025-02-17","2025-04-18","2025-05-26",
        "2025-06-19","2025-07-04","2025-09-01","2025-11-27","2025-12-25",
        "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25",
        "2026-06-19","2026-07-03","2026-09-07","2026-11-26","2026-12-25",
    }
    today_str = now.strftime("%Y-%m-%d")
    is_holiday = today_str in HOLIDAYS

    market_open  = now.replace(hour=9,  minute=30, second=0, microsecond=0)
    market_close = now.replace(hour=16, minute=0,  second=0, microsecond=0)
    is_trading_hours = market_open <= now <= market_close

    is_open = not is_weekend and not is_holiday and is_trading_hours

    if is_weekend:
        reason = f"Weekend — market closed. Prices shown are as of last Friday's close."
    elif is_holiday:
        reason = f"US market holiday ({today_str}). Prices are stale."
    elif not is_trading_hours:
        if now < market_open:
            mins = int((market_open - now).total_seconds() / 60)
            reason = f"Pre-market. Market opens in {mins} min (9:30 AM ET). Prices are last close."
        else:
            reason = "After-hours. Market closed at 4:00 PM ET. Prices are last close."
    else:
        reason = "Market is open. Prices are live (15-min delay via yfinance)."

    return {
        "is_open": is_open,
        "is_weekend": is_weekend,
        "is_holiday": is_holiday,
        "is_trading_hours": is_trading_hours,
        "current_et": now.strftime("%Y-%m-%d %H:%M:%S ET"),
        "reason": reason,
        "data_freshness": "LIVE" if is_open else "STALE",
    }


@router.get("/risk")
async def get_portfolio_risk():
    """Latest portfolio-level Greeks and risk metrics."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT * FROM options_risk_snapshots ORDER BY snapshot_at DESC LIMIT 1"
            ) as cur:
                row = await cur.fetchone()
        if not row:
            return {"risk": None, "message": "No risk snapshots yet — open a position first."}
        cols = ["id","snapshot_at","net_delta","net_gamma","net_theta","net_vega","net_rho",
                "total_unrealized_pnl","total_realized_pnl","open_position_count","cash","net_liq"]
        return {"risk": dict(zip(cols, row))}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Multi-leg strategies ───────────────────────────────────────────────────────

@router.post("/positions/open-multi")
async def open_multi_leg(req: MultiLegRequest, background_tasks: BackgroundTasks):
    """Execute a multi-leg strategy (spreads, straddles, strangles)."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            result = await open_multi_leg_position(
                db, req.ticker.upper(), req.expiry,
                req.strategy_label, req.legs, req.note,
            )
        background_tasks.add_task(
            _aria_background,
            result["position_id"],
            req.ticker.upper(),
            req.expiry,
            req.legs,
        )
        return {"ok": True, **result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.exception("open_multi_leg")
        raise HTTPException(status_code=500, detail=str(e))


# ── Alerts ────────────────────────────────────────────────────────────────────

@router.get("/alerts")
async def get_alerts():
    """Return actionable alerts for all open positions."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            alerts = await get_position_alerts(db)
        return {"alerts": alerts, "count": len(alerts)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Performance curve ─────────────────────────────────────────────────────────

@router.get("/performance")
async def get_performance(days: int = 30):
    """Return daily net-liq snapshots for the equity curve chart."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            curve = await get_performance_curve(db, days)
        return {"curve": curve, "days": days}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/benchmark")
async def get_benchmark(days: int = 30):
    """Return SPY daily closes + return % for benchmark overlay."""
    try:
        import yfinance as yf
        ticker = yf.Ticker("SPY")
        hist = ticker.history(period=f"{days}d")
        if hist.empty:
            return {"benchmark": [], "ticker": "SPY"}
        closes = hist["Close"].dropna()
        base = float(closes.iloc[0])
        result = []
        for dt, price in closes.items():
            date_str = dt.strftime("%Y-%m-%d") if hasattr(dt, "strftime") else str(dt)[:10]
            result.append({
                "date": date_str,
                "price": round(float(price), 2),
                "return_pct": round((float(price) - base) / base * 100, 3),
            })
        return {"benchmark": result, "ticker": "SPY"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── ARIA AI Agent ─────────────────────────────────────────────────────────────

@router.get("/aria/account")
async def get_aria_account_endpoint():
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            acct = await get_aria_account(db)
        return {"account": acct}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/aria/positions")
async def get_aria_positions(status: str = "OPEN"):
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            positions = await list_aria_positions(db, status.upper())
        return {"positions": positions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/aria/decisions")
async def get_aria_decisions(limit: int = 50):
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            decisions = await list_aria_decisions(db, limit)
        return {"decisions": decisions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/aria/scoreboard")
async def get_aria_scoreboard():
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            board = await get_scoreboard(db)
        return board
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/aria/check-exits")
async def trigger_aria_exits():
    """Manually trigger ARIA exit checks (also runs with 15-min revaluation)."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            result = await check_aria_exits(db)
        return {"ok": True, **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/aria/reset")
async def reset_aria():
    """Reset ARIA back to $10k (clears all ARIA positions and decisions)."""
    try:
        now = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute("DELETE FROM aria_decisions")
            await db.execute("DELETE FROM aria_positions")
            await db.execute(
                "INSERT OR REPLACE INTO aria_account "
                "(id, cash, initial_capital, realized_pnl, total_commissions, "
                "trade_count, win_count, created_at, updated_at) "
                "VALUES (1, 10000.0, 10000.0, 0.0, 0.0, 0, 0, ?, ?)",
                (now, now),
            )
            await db.commit()
        return {"ok": True, "message": "ARIA reset to $10,000"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
