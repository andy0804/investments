import json
import logging
import aiosqlite
from datetime import datetime, date
from app.config import DB_PATH, INVESTOR_PROFILE
from app.analysis.technicals import compute_technicals
from app.analysis.fundamentals import get_fundamentals
from app.analysis.macro import get_macro_snapshot
from app.analysis.risk import check_all_positions, get_position_risk_summary
from app.analysis.events import get_recent_events, score_events_for_portfolio
from app.analysis.claude_engine import call_claude, get_daily_cost
from app.connectors.portfolio_csv import get_portfolio_symbols
from app.connectors.finnhub import fetch_company_news
from app.prompts.morning_brief import build_morning_brief_prompt
from app.prompts.signal_alert import build_signal_prompt
from app.prompts.deep_dive import build_deep_dive_prompt
from app.prompts.ytd_coach import build_ytd_coach_prompt
from app.prompts.earnings_prep import build_earnings_prep_prompt

logger = logging.getLogger(__name__)


async def generate_morning_brief() -> dict:
    symbols = await get_portfolio_symbols()
    macro = await get_macro_snapshot()
    risk_alerts = await check_all_positions()
    top_events = await score_events_for_portfolio(symbols)

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT p.*, m.price as live_price FROM positions p
               LEFT JOIN market_data m ON p.symbol = m.symbol
               WHERE p.position_type NOT IN ('Cash_MM')
               ORDER BY p.current_value DESC"""
        ) as cur:
            positions = [dict(r) for r in await cur.fetchall()]

    prompt = build_morning_brief_prompt(positions, macro, risk_alerts, top_events)
    result = await call_claude(prompt, model="haiku", job_name="morning_brief")

    async with aiosqlite.connect(DB_PATH) as db:
        total_value = sum(p.get("current_value") or 0 for p in positions)
        await db.execute(
            """INSERT INTO portfolio_snapshot (total_value, positions_json, vix, snapped_at)
               VALUES (?,?,?,?)""",
            (total_value, str([p["symbol"] for p in positions]), macro.get("vix"), datetime.utcnow().isoformat()),
        )
        await db.commit()

    return result


async def generate_signal(symbol: str) -> dict:
    technicals = await compute_technicals(symbol)
    fundamentals = await get_fundamentals(symbol)
    macro = await get_macro_snapshot()
    news = await fetch_company_news(symbol, days_back=5)
    headlines = [n.get("headline", "") for n in news]

    prompt = build_signal_prompt(symbol, technicals or {}, fundamentals or {}, macro, headlines)
    result = await call_claude(prompt, model="haiku", job_name=f"signal_{symbol}")

    if result and "score" in result:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """INSERT INTO signals (symbol, signal_type, score, reasoning, action, model_used)
                   VALUES (?,?,?,?,?,?)""",
                (symbol, result.get("signal", "watch"), result.get("score", 5),
                 result.get("reasoning", ""), result.get("suggested_action", ""),
                 "haiku"),
            )
            await db.commit()

    return {**result, "symbol": symbol, "technicals": technicals, "fundamentals": fundamentals}


def _to_json_safe(obj):
    """Recursively convert numpy/pandas scalars to Python native types."""
    if isinstance(obj, dict):
        return {k: _to_json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_json_safe(v) for v in obj]
    if hasattr(obj, 'item'):  # numpy scalar
        return obj.item()
    if isinstance(obj, bool):
        return bool(obj)
    if isinstance(obj, float):
        return float(obj)
    if isinstance(obj, int):
        return int(obj)
    return obj


async def generate_deep_dive(symbol: str) -> dict:
    technicals = await compute_technicals(symbol)
    fundamentals = await get_fundamentals(symbol)
    macro = await get_macro_snapshot()
    news = await fetch_company_news(symbol, days_back=7)

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM positions WHERE symbol = ? LIMIT 1", (symbol,)
        ) as cur:
            row = await cur.fetchone()
    position = dict(row) if row else None

    tech_safe  = _to_json_safe(technicals or {})
    fund_safe  = _to_json_safe(fundamentals or {})
    macro_safe = _to_json_safe(macro or {})

    prompt = build_deep_dive_prompt(symbol, tech_safe, fund_safe, macro_safe, news, position)
    result = await call_claude(prompt, model="sonnet", job_name=f"deep_dive_{symbol}")
    return {
        **result,
        "symbol":       symbol,
        "technicals":   tech_safe,
        "fundamentals": fund_safe,
    }


async def save_deep_dive(symbol: str, result: dict) -> int:
    """Persist a deep dive result to deep_dive_log. Returns the inserted row id."""
    import json
    from datetime import datetime, UTC
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO deep_dive_log
               (symbol, verdict, score, reasoning, technicals_json, fundamentals_json, full_result_json, saved)
               VALUES (?,?,?,?,?,?,?,1)""",
            (
                symbol,
                result.get("verdict"),
                result.get("score"),
                result.get("reasoning"),
                json.dumps(result.get("technicals", {})),
                json.dumps(result.get("fundamentals", {})),
                json.dumps(result),
            ),
        )
        await db.commit()
        return cur.lastrowid


async def list_saved_deep_dives() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, symbol, verdict, score, reasoning, created_at FROM deep_dive_log WHERE saved = 1 ORDER BY created_at DESC LIMIT 50"
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def generate_ytd_coach() -> dict:
    macro = await get_macro_snapshot()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM positions WHERE position_type NOT IN ('Cash_MM')"
        ) as cur:
            positions = [dict(r) for r in await cur.fetchall()]
        async with db.execute(
            "SELECT * FROM trade_log ORDER BY traded_at DESC LIMIT 20"
        ) as cur:
            trades = [dict(r) for r in await cur.fetchall()]

    prompt = build_ytd_coach_prompt(positions, trades, macro)
    return await call_claude(prompt, model="sonnet", job_name="ytd_coach")


async def generate_earnings_prep(symbol: str, earnings_date: str) -> dict:
    technicals = await compute_technicals(symbol)
    fundamentals = await get_fundamentals(symbol)
    prompt = build_earnings_prep_prompt(symbol, earnings_date, technicals or {}, fundamentals or {})
    return await call_claude(prompt, model="sonnet", job_name=f"earnings_prep_{symbol}")


async def scan_all_signals() -> list[dict]:
    symbols = await get_portfolio_symbols()
    results = []
    daily_cost = await get_daily_cost()
    if daily_cost >= 0.12:
        logger.warning("Daily cost $%.4f near limit — skipping signal scan", daily_cost)
        return []
    for symbol in symbols[:10]:
        try:
            sig = await generate_signal(symbol)
            if sig.get("score", 5) >= 7 or sig.get("score", 5) <= 3:
                results.append(sig)
        except Exception as e:
            logger.error("scan_all_signals failed for %s: %s", symbol, e)
    return results


async def generate_stock_of_day() -> dict:
    today = date.today().isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM stock_picks WHERE pick_date = ?", (today,)) as cur:
            row = await cur.fetchone()
    if row:
        return json.loads(row["signal_json"])

    portfolio_symbols = set(await get_portfolio_symbols())

    try:
        from app.analysis.screener import screen_momentum
        candidates = screen_momentum()
    except Exception as e:
        logger.warning("screener failed for stock_of_day: %s", e)
        candidates = []

    pick_symbol = None
    for c in candidates:
        sym = (c.get("Ticker") or "").strip()
        if sym and sym not in portfolio_symbols:
            pick_symbol = sym
            break

    if not pick_symbol:
        return {"error": "No screener candidates found outside your portfolio"}

    result = await generate_signal(pick_symbol)
    result["pick_reason"] = "Top momentum screener result not currently in your portfolio"
    result["pick_date"] = today

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO stock_picks (pick_date, symbol, signal_json) VALUES (?,?,?)",
            (today, pick_symbol, json.dumps(result)),
        )
        await db.commit()

    return result
