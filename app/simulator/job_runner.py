"""
app/simulator/job_runner.py

Asyncio background job lifecycle for strategy lab runs.

Jobs execute in asyncio.create_task() — no Celery/Redis required.
State persisted to strategy_runs table so the frontend can poll for progress.
Jobs that are RUNNING when the server restarts are marked FAILED on next startup.
"""
import asyncio
import json
import logging
import uuid
from datetime import datetime, UTC
from typing import Optional

import aiosqlite

from app.config import DB_PATH

logger = logging.getLogger(__name__)


# ── DB helpers ────────────────────────────────────────────────────────────────

async def create_run(job_type: str, config: dict, strategies: list[dict]) -> str:
    run_id = str(uuid.uuid4())[:8]
    now    = datetime.now(UTC).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO strategy_runs
               (run_id, job_type, status, progress, current_step, config_json, strategies_json, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (run_id, job_type, "PENDING", 0, "Queued",
             json.dumps(config), json.dumps(strategies), now)
        )
        await db.commit()
    return run_id


async def update_run(run_id: str, status: str, progress: int = None,
                     step: str = None, error: str = None) -> None:
    fields = ["status = ?", "updated = ?"]
    params: list = [status, datetime.now(UTC).isoformat()]

    if progress is not None:
        fields.append("progress = ?")
        params.append(progress)
    if step is not None:
        fields.append("current_step = ?")
        params.append(step)
    if status in ("COMPLETED", "FAILED"):
        fields.append("completed_at = ?")
        params.append(datetime.now(UTC).isoformat())
    if error is not None:
        fields.append("error = ?")
        params.append(error)

    params.append(run_id)
    sql = f"UPDATE strategy_runs SET {', '.join(f for f in fields if 'updated' not in f)} WHERE run_id = ?"

    # Build correct SQL without "updated" pseudo field
    real_fields = []
    real_params: list = []
    if "status = ?" in fields:
        real_fields.append("status = ?")
        real_params.append(status)
    if progress is not None:
        real_fields.append("progress = ?")
        real_params.append(progress)
    if step is not None:
        real_fields.append("current_step = ?")
        real_params.append(step)
    if status in ("COMPLETED", "FAILED"):
        real_fields.append("completed_at = ?")
        real_params.append(datetime.now(UTC).isoformat())
    if error is not None:
        real_fields.append("error = ?")
        real_params.append(error)
    real_params.append(run_id)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            f"UPDATE strategy_runs SET {', '.join(real_fields)} WHERE run_id = ?",
            real_params
        )
        await db.commit()


async def log_run(run_id: str, message: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO run_logs (run_id, timestamp, message) VALUES (?,?,?)",
            (run_id, datetime.now(UTC).isoformat(), message)
        )
        await db.commit()


async def save_results(run_id: str, results: list[dict]) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        for r in results:
            metrics = r.get("metrics", {})
            regime_bd = metrics.pop("regime_breakdown", {})
            # Store trades only for top-ranked results (rank <= 10) to keep DB lean
            trades = r.get("trades", []) if (r.get("rank", 99) <= 10) else []
            await db.execute(
                """INSERT INTO strategy_results
                   (run_id, strategy_name, params_json, metrics_json,
                    regime_breakdown_json, trades_json, composite_score, rank)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (run_id,
                 r["strategy_name"],
                 json.dumps(r.get("params", {})),
                 json.dumps(metrics),
                 json.dumps(regime_bd),
                 json.dumps(trades),
                 r.get("composite_score", 0.0),
                 r.get("rank", 0))
            )
        await db.commit()


async def get_run(run_id: str) -> Optional[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM strategy_runs WHERE run_id = ?", (run_id,)
        ) as cur:
            row = await cur.fetchone()
    if not row:
        return None
    d = dict(row)
    for field in ("config_json", "strategies_json"):
        if d.get(field):
            try:
                d[field] = json.loads(d[field])
            except Exception:
                pass
    return d


async def get_results(run_id: str) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM strategy_results WHERE run_id = ? ORDER BY rank ASC",
            (run_id,)
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    for r in rows:
        for field in ("params_json", "metrics_json", "regime_breakdown_json", "trades_json"):
            if r.get(field):
                try:
                    r[field] = json.loads(r[field])
                except Exception:
                    pass
    return rows


async def list_runs(limit: int = 20) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT run_id, job_type, status, progress, current_step, created_at, completed_at, error "
            "FROM strategy_runs ORDER BY created_at DESC LIMIT ?",
            (limit,)
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def cancel_run(run_id: str) -> bool:
    """Mark a run as FAILED. Running asyncio tasks cannot be killed from here
       but will detect the status on next DB check."""
    await update_run(run_id, "FAILED", error="Cancelled by user")
    return True


async def recover_stale_runs() -> None:
    """Mark any RUNNING/PENDING jobs as FAILED on server startup (they were killed)."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE strategy_runs SET status='FAILED', error='Server restarted — run aborted' "
            "WHERE status IN ('RUNNING','PENDING')"
        )
        await db.commit()


# ── Job execution ─────────────────────────────────────────────────────────────

async def _execute_backtest_job(run_id: str, config: dict, strategies: list[dict]) -> None:
    """Inner coroutine that runs the backtest and updates DB throughout."""
    from app.simulator.backtest_engine import run_backtest_job

    progress_steps = [0]

    async def _progress(msg: str):
        progress_steps[0] = min(progress_steps[0] + 5, 90)
        await update_run(run_id, "RUNNING", progress=progress_steps[0], step=msg)
        await log_run(run_id, msg)
        logger.info("backtest[%s]: %s", run_id, msg)

    try:
        await update_run(run_id, "RUNNING", progress=5, step="Starting backtest…")

        start     = config.get("start_date", "2023-01-01")
        end       = config.get("end_date",   "2024-12-31")
        sweep     = config.get("sweep_params", False)

        capital = float(config.get("initial_capital", 10_000))
        results = await run_backtest_job(run_id, strategies, start, end, sweep, _progress, capital)

        await _progress(f"Saving {len(results)} strategy results…")
        await save_results(run_id, results)
        await update_run(run_id, "COMPLETED", progress=100, step=f"Done — {len(results)} strategies ranked")
        logger.info("backtest[%s]: completed %d results", run_id, len(results))

    except Exception as e:
        msg = f"Backtest failed: {e}"
        logger.error("backtest[%s]: %s", run_id, msg, exc_info=True)
        await update_run(run_id, "FAILED", error=msg)


async def _execute_simulation_job(run_id: str, config: dict, strategies: list[dict]) -> None:
    """Synthetic simulation job — generate data then run backtest on it."""
    from app.simulator.market_engine import run_simulation

    async def _progress(msg: str):
        await update_run(run_id, "RUNNING", step=msg)
        await log_run(run_id, msg)

    try:
        await update_run(run_id, "RUNNING", progress=5, step="Generating synthetic market data…")
        await run_simulation(run_id, config, _progress)

        await update_run(run_id, "RUNNING", progress=50, step="Running strategies on simulated data…")
        # For Phase 2: backtest_engine can accept simulated_prices as data source.
        # For now we complete the simulation generation phase and mark done.
        await update_run(run_id, "COMPLETED", progress=100, step="Simulation data generated successfully")

    except Exception as e:
        msg = f"Simulation failed: {e}"
        logger.error("simulation[%s]: %s", run_id, msg, exc_info=True)
        await update_run(run_id, "FAILED", error=msg)


def launch_job(run_id: str, job_type: str, config: dict, strategies: list[dict]) -> None:
    """
    Fire-and-forget: creates an asyncio task for the job.
    Returns immediately — the task runs in the background event loop.
    """
    if job_type == "backtest":
        coro = _execute_backtest_job(run_id, config, strategies)
    elif job_type == "simulation":
        coro = _execute_simulation_job(run_id, config, strategies)
    else:
        logger.error("Unknown job_type: %s", job_type)
        return

    asyncio.create_task(coro, name=f"stratlab_{run_id}")
    logger.info("Launched %s job %s", job_type, run_id)
