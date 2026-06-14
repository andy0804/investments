"""
Weekly Review Agent — runs Sunday evening.
Compares portfolio return vs SPY, computes win rate, generates strategy evolution entry.
"""

import json
import logging
import os
from datetime import datetime, UTC, timedelta

import aiosqlite
from anthropic import AsyncAnthropic

from app.config import DB_PATH
from app.analysis.alpha_agent import cost_tracker

log = logging.getLogger(__name__)

_client = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
_HAIKU = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")


async def _get_week_trades() -> list[dict]:
    since = (datetime.now(UTC) - timedelta(days=7)).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT ticker, direction, realized_pnl, entry_price, close_price,
                      conviction, open_date, close_date
               FROM alpha_agent_positions
               WHERE status = 'CLOSED' AND close_date >= ?""",
            (since[:10],),
        ) as cur:
            rows = await cur.fetchall()
    result = []
    for r in rows:
        r = dict(r)
        ep = r.get("entry_price") or 0
        cp = r.get("close_price") or 0
        r["pnl_pct"] = round((cp / ep - 1) * 100, 2) if ep else 0
        result.append(r)
    return result


async def _get_open_count() -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT COUNT(*) FROM alpha_agent_positions WHERE status = 'OPEN'"
        ) as cur:
            row = await cur.fetchone()
    return row[0] if row else 0


async def _get_spy_week_return() -> float:
    try:
        import yfinance as yf
        import asyncio
        spy = await asyncio.get_event_loop().run_in_executor(
            None, lambda: yf.Ticker("SPY").history(period="5d")
        )
        if len(spy) >= 2:
            return round((spy["Close"].iloc[-1] / spy["Close"].iloc[0] - 1) * 100, 2)
    except Exception as e:
        log.warning("SPY weekly return fetch failed: %s", e)
    return 0.0


def _compute_stats(trades: list[dict]) -> dict:
    if not trades:
        return {"total": 0, "wins": 0, "losses": 0, "win_rate": 0.0,
                "avg_win": 0.0, "avg_loss": 0.0, "weekly_pnl": 0.0}
    wins = [t["pnl_pct"] for t in trades if t["pnl_pct"] > 0]
    losses = [t["pnl_pct"] for t in trades if t["pnl_pct"] <= 0]
    return {
        "total": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round(len(wins) / len(trades) * 100, 1),
        "avg_win": round(sum(wins) / len(wins), 2) if wins else 0.0,
        "avg_loss": round(sum(losses) / len(losses), 2) if losses else 0.0,
        "weekly_pnl": round(sum(t["pnl_pct"] for t in trades), 2),
    }


async def run_weekly_review() -> dict | None:
    trades = await _get_week_trades()
    stats = _compute_stats(trades)
    spy_return = await _get_spy_week_return()
    open_count = await _get_open_count()
    alpha = round(stats["weekly_pnl"] - spy_return, 2)

    trade_summary = "\n".join(
        f"- {t['ticker']} ({t['direction']}): {t['pnl_pct']:.1f}%"
        for t in trades
    ) or "No closed trades this week."

    prompt = f"""You are the weekly strategy reviewer for an AI paper-trading agent.

Week summary:
- Trades closed: {stats['total']} ({stats['wins']} wins, {stats['losses']} losses)
- Win rate: {stats['win_rate']}%
- Avg winner: +{stats['avg_win']}%  Avg loser: {stats['avg_loss']}%
- Portfolio weekly P&L: {stats['weekly_pnl']:.2f}%
- SPY weekly return: {spy_return:.2f}%
- Alpha vs SPY: {alpha:.2f}%

Trades:
{trade_summary}

Write a concise strategy evolution entry:
1. What worked this week and why
2. What didn't and the root cause
3. One concrete parameter or approach to test next week

Also, if any parameter should change (e.g. confidence threshold, stop %), describe it briefly.

Respond as JSON:
{{"analysis": "...(3-4 sentences)...", "parameter_changes": "...(or 'none')..."}}"""

    try:
        resp = await _client.messages.create(
            model=_HAIKU,
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        await cost_tracker.log_call(
            stage="weekly_review",
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
        log.error("Weekly review generation failed: %s", e)
        return None

    week_start = (datetime.now(UTC).date() - timedelta(days=7)).isoformat()
    param_changes = data.get("parameter_changes", "none")
    if param_changes.lower() == "none":
        param_changes = None

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO alpha_agent_strategy_log
               (week_start, portfolio_return_pct, spy_return_pct, alpha_pct,
                win_rate, avg_winner_pct, avg_loser_pct, trades_count,
                open_positions, llm_analysis, parameter_changes_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                week_start,
                stats["weekly_pnl"],
                spy_return,
                alpha,
                stats["win_rate"],
                stats["avg_win"],
                stats["avg_loss"],
                stats["total"],
                open_count,
                data.get("analysis", ""),
                json.dumps({"changes": param_changes}) if param_changes else None,
                datetime.now(UTC).isoformat(),
            ),
        )
        await db.commit()

    result = {
        "week_start": week_start,
        "spy_return": spy_return,
        "portfolio_pnl": stats["weekly_pnl"],
        "alpha": alpha,
        "win_rate": stats["win_rate"],
        "trades_closed": stats["total"],
        "analysis": data.get("analysis", ""),
        "parameter_changes": param_changes,
    }
    log.info("Weekly review complete: alpha=%+.2f%%", alpha)
    return result
