"""
Self-Corrector — evaluates trading performance after each trade closes.
Fires four independent triggers. Each generates a PENDING config proposal
that the user must approve before any rule changes take effect.
"""

import json
import logging
from datetime import datetime, UTC

import aiosqlite

from app.config import DB_PATH

log = logging.getLogger(__name__)


async def _load_config() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT key, value FROM alpha_agent_config") as cur:
            rows = await cur.fetchall()
    return {k: v for k, v in rows}


async def _recent_closed_trades(n: int = 20) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT ticker, direction, entry_price, close_price, pnl_pct,
                      realized_pnl, close_date, open_date
               FROM alpha_agent_positions
               WHERE status = 'CLOSED'
               ORDER BY close_date DESC LIMIT ?""",
            (n,),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def _portfolio_peak_value() -> float:
    """Highest ever total_value recorded."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT MAX(total_value) FROM alpha_agent_portfolio"
        ) as cur:
            row = await cur.fetchone()
    return float(row[0]) if row and row[0] else 10000.0


async def _current_portfolio_value() -> float:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT total_value FROM alpha_agent_portfolio LIMIT 1"
        ) as cur:
            row = await cur.fetchone()
    return float(row[0]) if row else 10000.0


async def _already_proposed(trigger_type: str) -> bool:
    """Avoid duplicate proposals for the same trigger while one is still PENDING."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id FROM alpha_agent_config_proposals WHERE trigger_type=? AND status='PENDING'",
            (trigger_type,),
        ) as cur:
            return await cur.fetchone() is not None


async def _save_proposal(trigger_type: str, trigger_description: str,
                          proposed_changes: dict, rationale: str) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """INSERT INTO alpha_agent_config_proposals
               (trigger_type, trigger_description, proposed_changes_json, rationale, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (trigger_type, trigger_description,
             json.dumps(proposed_changes), rationale,
             datetime.now(UTC).isoformat()),
        ) as cur:
            proposal_id = cur.lastrowid
        await db.commit()
    log.info("Self-corrector: new proposal id=%d trigger=%s", proposal_id, trigger_type)
    return proposal_id


async def _trigger_consecutive_stops(trades: list[dict], cfg: dict) -> dict | None:
    """
    Trigger 1: 3 consecutive trades all exited at or near their stop loss.
    Proposes: tighten stop by 1%, reduce max_position_pct by 2%.
    """
    threshold = int(cfg.get("self_correct_consec_stops", "3"))
    if len(trades) < threshold:
        return None

    recent = trades[:threshold]
    # A trade "hit stop" if pnl_pct <= -(hard_stop - 2), i.e. close to the stop
    hard_stop = float(cfg.get("hard_stop_pct", "8"))
    stop_hits = sum(1 for t in recent if (t.get("pnl_pct") or 0) <= -(hard_stop - 2))

    if stop_hits < threshold:
        return None

    if await _already_proposed("consecutive_stops"):
        return None

    current_stop  = float(cfg.get("hard_stop_pct", "8"))
    current_max   = float(cfg.get("max_position_pct", "12"))
    proposed = {
        "hard_stop_pct":    str(max(4.0, current_stop - 1.0)),
        "max_position_pct": str(max(5.0, current_max - 2.0)),
    }
    tickers = ", ".join(t["ticker"] for t in recent)
    return await _save_proposal(
        trigger_type="consecutive_stops",
        trigger_description=f"{threshold} consecutive stop-loss exits ({tickers})",
        proposed_changes=proposed,
        rationale=(
            f"The last {threshold} trades all exited at the stop loss ({tickers}). "
            f"This suggests either entries are too early or the stop is too wide for current volatility. "
            f"Proposed: tighten hard stop from -{current_stop}% → -{proposed['hard_stop_pct']}% "
            f"and reduce max position size from {current_max}% → {proposed['max_position_pct']}% "
            f"to limit damage per trade while we recalibrate."
        ),
    )


async def _trigger_low_win_rate(trades: list[dict], cfg: dict) -> dict | None:
    """
    Trigger 2: Win rate < 40% over 15+ closed trades.
    Proposes: raise min_confidence_to_trade from current → current + 10.
    """
    min_trades = 15
    if len(trades) < min_trades:
        return None

    target_rate = float(cfg.get("self_correct_min_win_rate", "40"))
    wins = sum(1 for t in trades if (t.get("pnl_pct") or 0) > 0)
    win_rate = wins / len(trades) * 100

    if win_rate >= target_rate:
        return None

    if await _already_proposed("low_win_rate"):
        return None

    current_conf = float(cfg.get("min_confidence_to_trade", "55"))
    proposed_conf = min(75.0, current_conf + 10.0)
    proposed = {"min_confidence_to_trade": str(proposed_conf)}

    return await _save_proposal(
        trigger_type="low_win_rate",
        trigger_description=f"Win rate {win_rate:.0f}% over last {len(trades)} trades (threshold: {target_rate:.0f}%)",
        proposed_changes=proposed,
        rationale=(
            f"Win rate is {win_rate:.0f}% over {len(trades)} trades, below the {target_rate:.0f}% floor. "
            f"The committee is approving too many low-quality setups. "
            f"Proposed: raise the minimum confidence threshold to enter a trade "
            f"from {current_conf:.0f}% → {proposed_conf:.0f}%. "
            f"This will reduce trade frequency but improve selectivity."
        ),
    )


async def _trigger_rr_imbalance(trades: list[dict], cfg: dict) -> dict | None:
    """
    Trigger 3: Average loss > 1.5× average win over 10+ trades.
    Proposes: tighten take-profit (lower it to force earlier exits) or widen stop.
    """
    if len(trades) < 10:
        return None

    rr_threshold = float(cfg.get("self_correct_rr_threshold", "1.5"))
    wins   = [t.get("pnl_pct") or 0 for t in trades if (t.get("pnl_pct") or 0) > 0]
    losses = [abs(t.get("pnl_pct") or 0) for t in trades if (t.get("pnl_pct") or 0) < 0]

    if not wins or not losses:
        return None

    avg_win  = sum(wins) / len(wins)
    avg_loss = sum(losses) / len(losses)

    if avg_loss < avg_win * rr_threshold:
        return None

    if await _already_proposed("rr_imbalance"):
        return None

    # Losses are running bigger than wins — tighten the stop to cut losses faster
    current_stop = float(cfg.get("hard_stop_pct", "8"))
    proposed_stop = max(4.0, current_stop - 1.5)
    proposed = {"hard_stop_pct": str(proposed_stop)}

    return await _save_proposal(
        trigger_type="rr_imbalance",
        trigger_description=f"Avg loss ({avg_loss:.1f}%) is {avg_loss/avg_win:.1f}× the avg win ({avg_win:.1f}%)",
        proposed_changes=proposed,
        rationale=(
            f"The average loss ({avg_loss:.1f}%) is {avg_loss/avg_win:.1f}× the average win ({avg_win:.1f}%), "
            f"exceeding the {rr_threshold}× threshold. Losses are running larger than gains — "
            f"the risk/reward math is inverted. Proposed: tighten the hard stop "
            f"from -{current_stop}% → -{proposed_stop}% to cut losing trades faster "
            f"before they erode the portfolio."
        ),
    )


async def _trigger_drawdown(cfg: dict) -> dict | None:
    """
    Trigger 4: Portfolio drawdown from peak > 15%. Hard pause — no new trades.
    Proposes: reduce max_deployed_pct and tighten stops across all regimes.
    This is the only trigger that does not require 15+ trades first.
    """
    max_dd = float(cfg.get("self_correct_max_drawdown", "15"))
    peak   = await _portfolio_peak_value()
    current = await _current_portfolio_value()

    if peak <= 0:
        return None

    dd_pct = (peak - current) / peak * 100
    if dd_pct < max_dd:
        return None

    if await _already_proposed("drawdown"):
        return None

    current_bull_deployed   = float(cfg.get("bull_max_deployed_pct",   "75"))
    current_normal_deployed = float(cfg.get("normal_max_deployed_pct", "60"))
    current_caution_deployed= float(cfg.get("caution_max_deployed_pct","35"))

    proposed = {
        "bull_max_deployed_pct":    str(max(40.0, current_bull_deployed - 15)),
        "normal_max_deployed_pct":  str(max(30.0, current_normal_deployed - 15)),
        "caution_max_deployed_pct": str(max(15.0, current_caution_deployed - 10)),
        "bull_hard_stop_pct":       "7.0",
        "normal_hard_stop_pct":     "6.0",
        "caution_hard_stop_pct":    "4.0",
    }

    return await _save_proposal(
        trigger_type="drawdown",
        trigger_description=f"Portfolio drawdown {dd_pct:.1f}% from peak ${peak:,.2f} → ${current:,.2f}",
        proposed_changes=proposed,
        rationale=(
            f"The portfolio has drawn down {dd_pct:.1f}% from its peak of ${peak:,.2f} "
            f"(current: ${current:,.2f}). This exceeds the {max_dd:.0f}% pain threshold. "
            f"Proposed: reduce deployment ceilings across all regimes by ~15% "
            f"and tighten stops by ~1-2% to slow further losses while the committee "
            f"recalibrates. IMPORTANT: No new positions should be opened until this is reviewed."
        ),
    )


async def run_after_trade_close(cfg: dict | None = None) -> list[int]:
    """
    Run all four triggers. Called after every position closes.
    Returns list of new proposal IDs created.
    """
    if cfg is None:
        cfg = await _load_config()

    if cfg.get("self_correct_enabled", "1") != "1":
        return []

    trades = await _recent_closed_trades(20)
    proposals = []

    for fn in [
        lambda: _trigger_consecutive_stops(trades, cfg),
        lambda: _trigger_low_win_rate(trades, cfg),
        lambda: _trigger_rr_imbalance(trades, cfg),
        lambda: _trigger_drawdown(cfg),
    ]:
        try:
            pid = await fn()
            if pid:
                proposals.append(pid)
        except Exception as e:
            log.error("self_corrector trigger failed: %s", e)

    return proposals


async def apply_proposal(proposal_id: int) -> dict:
    """Apply an approved proposal — write each proposed key/value to alpha_agent_config."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_config_proposals WHERE id=?", (proposal_id,)
        ) as cur:
            row = await cur.fetchone()

    if not row:
        return {"error": "Proposal not found"}

    row = dict(row)
    if row["status"] != "PENDING":
        return {"error": f"Proposal is already {row['status']}"}

    changes = json.loads(row["proposed_changes_json"])
    now = datetime.now(UTC).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        for key, value in changes.items():
            await db.execute(
                "INSERT OR REPLACE INTO alpha_agent_config (key, value, updated_at) VALUES (?, ?, ?)",
                (key, str(value), now),
            )
        await db.execute(
            "UPDATE alpha_agent_config_proposals SET status='APPROVED', resolved_at=? WHERE id=?",
            (now, proposal_id),
        )
        await db.commit()

    log.info("Self-corrector: proposal %d APPROVED — applied %d changes", proposal_id, len(changes))
    return {"applied": changes, "proposal_id": proposal_id}


async def reject_proposal(proposal_id: int) -> dict:
    now = datetime.now(UTC).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE alpha_agent_config_proposals SET status='REJECTED', resolved_at=? WHERE id=?",
            (now, proposal_id),
        )
        await db.commit()
    log.info("Self-corrector: proposal %d REJECTED", proposal_id)
    return {"rejected": True, "proposal_id": proposal_id}
