import logging
from datetime import datetime
import pytz

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.connectors.portfolio_csv import sync_portfolio_from_csv, get_portfolio_symbols
from app.connectors.finnhub import sync_market_data
from app.connectors.fmp import get_earnings_calendar
from app.connectors.fred import sync_vix
from app.connectors.gdelt import sync_geopolitical_events
from app.connectors.edgar import sync_sec_filings
from app.connectors.rss import sync_rss_news
from app.analysis.risk import check_all_positions

logger = logging.getLogger(__name__)
ET = pytz.timezone("America/New_York")


def _is_market_hours() -> bool:
    now = datetime.now(ET)
    if now.weekday() >= 5:
        return False
    open_t = now.replace(hour=9, minute=30, second=0, microsecond=0)
    close_t = now.replace(hour=16, minute=0, second=0, microsecond=0)
    return open_t <= now <= close_t


async def job_portfolio_csv():
    logger.info("job_portfolio_csv: starting")
    count = await sync_portfolio_from_csv()
    logger.info("job_portfolio_csv: loaded %d positions", count)


async def job_market_data():
    if not _is_market_hours():
        return
    symbols = await get_portfolio_symbols()
    if not symbols:
        return
    count = await sync_market_data(symbols)
    logger.info("job_market_data: updated %d symbols", count)


async def job_vix():
    vix = await sync_vix()
    if vix:
        logger.info("job_vix: %.2f", vix)


async def job_gdelt():
    symbols = await get_portfolio_symbols()
    count = await sync_geopolitical_events(symbols)
    logger.info("job_gdelt: stored %d events", count)


async def job_edgar():
    symbols = await get_portfolio_symbols()
    count = await sync_sec_filings(symbols)
    logger.info("job_edgar: stored %d filings", count)


async def job_rss():
    count = await sync_rss_news()
    logger.info("job_rss: stored %d articles", count)


async def job_morning_brief():
    from app.analysis.orchestrator import generate_morning_brief
    from app.analysis.portfolio_intelligence import generate_portfolio_intelligence
    from app.notifications.telegram_bot import send_morning_brief, send_portfolio_intelligence
    from app.scheduler.manager import update_last_run

    # V1 market context brief (existing)
    brief = await generate_morning_brief()
    if not brief.get("error"):
        await send_morning_brief(brief)

    # Portfolio intelligence brief (new — single source of truth with dashboard)
    try:
        intel = await generate_portfolio_intelligence()
        if not intel.get("error") and intel.get("holdings"):
            await send_portfolio_intelligence(intel)
    except Exception as e:
        logger.warning("job_morning_brief: portfolio intelligence failed: %s", e)

    await update_last_run("morning_brief")
    logger.info("job_morning_brief: sent")


async def job_risk_check():
    from app.notifications.telegram_bot import send_stop_trigger, send_target_hit
    from app.scheduler.manager import get_schedule_telegram_enabled

    telegram_ok = await get_schedule_telegram_enabled("risk_check")
    alerts = await check_all_positions()
    for alert in alerts:
        for trigger in alert.get("triggers", []):
            if not telegram_ok:
                continue
            t_type = trigger["type"]
            if t_type == "stop_loss":
                await send_stop_trigger(
                    alert["symbol"], alert["gain_loss_pct"],
                    alert["cost_basis"], alert["live_price"]
                )
            elif t_type == "target_1":
                await send_target_hit(alert["symbol"], alert["gain_loss_pct"], 1)
            elif t_type == "target_2":
                await send_target_hit(alert["symbol"], alert["gain_loss_pct"], 2)


async def job_ytd_coach():
    from app.analysis.orchestrator import generate_ytd_coach
    from app.notifications.telegram_bot import send_ytd_coach
    coaching = await generate_ytd_coach()
    if not coaching.get("error"):
        await send_ytd_coach(coaching)
    logger.info("job_ytd_coach: sent")


async def job_sotd():
    from app.analysis.sotd_engine import run_sotd_pipeline
    from app.scheduler.manager import update_last_run
    from app.notifications.telegram_bot import send_sotd_alert, send_regime_shift
    import aiosqlite
    from app.config import DB_PATH
    from datetime import date, timedelta

    # Capture yesterday's regime for shift detection
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    prev_regime = None
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT regime FROM stock_picks WHERE pick_date = ?", (yesterday,)
            ) as cur:
                row = await cur.fetchone()
        prev_regime = row[0] if row else None
    except Exception:
        pass

    result = await run_sotd_pipeline(force_refresh=True)
    sotd   = result.get("stock_of_the_day") or {}
    ticker = sotd.get("ticker", "NONE")
    score  = sotd.get("confidence_score", "—")
    new_regime = result.get("market_context", {}).get("regime", "—")

    # Send SOTD Telegram alert (single source of truth — same data as UI)
    await send_sotd_alert(result)

    # Regime shift alert (bypasses daily cap)
    if prev_regime and prev_regime != new_regime:
        logger.info("job_sotd: regime shift %s → %s", prev_regime, new_regime)
        await send_regime_shift(prev_regime, new_regime, result.get("market_context", {}))

    # Record strategy forward picks for today (morning baseline)
    try:
        from app.performance.strategy_comparison import run_strategy_forward_picks
        await run_strategy_forward_picks()
    except Exception as e:
        logger.warning("job_sotd: strategy picks failed: %s", e)

    await update_last_run("sotd")
    logger.info("job_sotd: pick=%s score=%s regime=%s", ticker, score, new_regime)


async def _job_sotd_refresh_with_label(label: str, job_id: str):
    """
    Intraday SOTD refresh — re-runs pipeline, updates all strategy picks,
    then sends Telegram with the full strategy summary.
    label: 'Open' | 'Afternoon' | 'Close'
    """
    from app.analysis.sotd_engine import run_sotd_pipeline
    from app.scheduler.manager import update_last_run
    from app.performance.strategy_comparison import run_strategy_forward_picks, get_strategy_comparison
    from app.notifications.telegram_bot import send_strategy_refresh
    import aiosqlite, json
    from app.config import DB_PATH
    from datetime import date

    result = await run_sotd_pipeline(force_refresh=True)
    sotd   = result.get("stock_of_the_day") or {}
    ticker = sotd.get("ticker", "NONE")
    score  = sotd.get("confidence_score", "—")

    try:
        await run_strategy_forward_picks()
    except Exception as e:
        logger.warning("job_sotd_refresh %s: strategy picks failed: %s", label, e)

    # Build per-strategy pick rows for the Telegram message
    try:
        today = date.today().isoformat()
        strategy_picks: dict = {}
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """SELECT strategy_name, ticker, score, metrics_json, no_pick, no_pick_reason
                   FROM strategy_forward_picks
                   WHERE date(pick_date) = ?""",
                (today,),
            ) as cur:
                rows = await cur.fetchall()
        for row in rows:
            d = dict(row)
            if d.get("metrics_json"):
                try:
                    d["metrics"] = json.loads(d["metrics_json"])
                except Exception:
                    d["metrics"] = {}
            strategy_picks[d["strategy_name"]] = d

        await send_strategy_refresh(label, result, strategy_picks)
        logger.info("job_sotd_refresh %s: telegram sent pick=%s score=%s", label, ticker, score)
    except Exception as e:
        logger.warning("job_sotd_refresh %s: telegram failed: %s", label, e)

    await update_last_run(job_id)


async def job_sotd_refresh():
    """Wrapper kept for compatibility."""
    await _job_sotd_refresh_with_label("Open", "sotd_open")

async def _job_sotd_open():
    await _job_sotd_refresh_with_label("Open", "sotd_open")

async def _job_sotd_afternoon():
    await _job_sotd_refresh_with_label("Afternoon", "sotd_afternoon")

async def _job_sotd_close():
    await _job_sotd_refresh_with_label("Close", "sotd_close")


def create_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone=ET)

    # Portfolio CSV — every 30 min
    scheduler.add_job(job_portfolio_csv, IntervalTrigger(minutes=30), id="portfolio_csv",
                      replace_existing=True, misfire_grace_time=120)

    # Market data — every 15 min during market hours
    scheduler.add_job(job_market_data, IntervalTrigger(minutes=15), id="market_data",
                      replace_existing=True, misfire_grace_time=120)

    # VIX — daily 6:30 AM ET
    scheduler.add_job(job_vix, CronTrigger(hour=6, minute=30, timezone=ET), id="vix",
                      replace_existing=True)

    # GDELT — every 3 hours
    scheduler.add_job(job_gdelt, IntervalTrigger(hours=3), id="gdelt",
                      replace_existing=True, misfire_grace_time=300)

    # EDGAR — daily 7:00 AM ET
    scheduler.add_job(job_edgar, CronTrigger(hour=7, minute=0, timezone=ET), id="edgar",
                      replace_existing=True)

    # RSS — every 2 hours
    scheduler.add_job(job_rss, IntervalTrigger(hours=2), id="rss",
                      replace_existing=True, misfire_grace_time=300)

    # Morning brief — 8:03 AM ET weekdays
    scheduler.add_job(job_morning_brief, CronTrigger(hour=8, minute=3, day_of_week="mon-fri", timezone=ET),
                      id="morning_brief", replace_existing=True)

    # Risk check — every 20 min during market hours
    scheduler.add_job(job_risk_check, IntervalTrigger(minutes=20), id="risk_check",
                      replace_existing=True, misfire_grace_time=120)

    # YTD coaching — Sunday 8:00 AM ET
    scheduler.add_job(job_ytd_coach, CronTrigger(day_of_week="sun", hour=8, minute=0, timezone=ET),
                      id="ytd_coach", replace_existing=True)

    # SOTD V2 pipeline — weekdays 7:30 AM ET (pre-market baseline)
    scheduler.add_job(job_sotd, CronTrigger(hour=7, minute=30, day_of_week="mon-fri", timezone=ET),
                      id="sotd", replace_existing=True)

    # SOTD intraday refreshes — 9:45 AM (15 min after open), 1:30 PM, 3:45 PM ET + Telegram
    scheduler.add_job(_job_sotd_open,      CronTrigger(hour=9,  minute=45, day_of_week="mon-fri", timezone=ET),
                      id="sotd_open",      replace_existing=True)
    scheduler.add_job(_job_sotd_afternoon, CronTrigger(hour=13, minute=30, day_of_week="mon-fri", timezone=ET),
                      id="sotd_afternoon", replace_existing=True)
    scheduler.add_job(_job_sotd_close,     CronTrigger(hour=15, minute=45, day_of_week="mon-fri", timezone=ET),
                      id="sotd_close",     replace_existing=True)

    # Foresight report — Monday 7:30 AM ET (shifted to 7:35 to avoid overlap)
    scheduler.add_job(_job_foresight, CronTrigger(day_of_week="mon", hour=7, minute=35, timezone=ET),
                      id="foresight", replace_existing=True)

    # Signal resolution — daily 9:00 PM ET
    scheduler.add_job(_job_resolve_signals, CronTrigger(hour=21, minute=0, timezone=ET),
                      id="signal_resolution", replace_existing=True)

    # Outcome computation — daily 9:30 PM ET (after signal resolution)
    scheduler.add_job(_job_compute_outcomes, CronTrigger(hour=21, minute=30, timezone=ET),
                      id="outcome_computation", replace_existing=True)

    # Health monitor — every 6 hours
    scheduler.add_job(_job_health_check, IntervalTrigger(hours=6), id="health_monitor",
                      replace_existing=True)

    # Top Performers of the Day — weekdays 4:05 PM ET (5 min after close)
    scheduler.add_job(job_top_performers, CronTrigger(hour=16, minute=5, day_of_week="mon-fri", timezone=ET),
                      id="top_performers", replace_existing=True)

    # Virtual portfolio — entry check 10:00 AM ET (confirmation window after SOTD)
    scheduler.add_job(job_virtual_entry, CronTrigger(hour=10, minute=0, day_of_week="mon-fri", timezone=ET),
                      id="virtual_entry", replace_existing=True)

    # Virtual portfolio — daily evaluation 4:15 PM ET (after close)
    scheduler.add_job(job_virtual_evaluation, CronTrigger(hour=16, minute=15, day_of_week="mon-fri", timezone=ET),
                      id="virtual_evaluation", replace_existing=True)

    return scheduler


async def _job_foresight():
    from app.analysis.preemptive_engine import job_foresight
    await job_foresight()


async def _job_resolve_signals():
    from app.performance.signal_tracker import resolve_old_signals
    count = await resolve_old_signals()
    logger.info("signal_resolution: resolved %d signals", count)


async def _job_compute_outcomes():
    from app.performance.signal_event_tracker import compute_pending_outcomes
    from app.scheduler.manager import update_last_run
    count = await compute_pending_outcomes()
    await update_last_run("outcome_computation")
    logger.info("outcome_computation: evaluated %d events", count)


async def job_top_performers():
    from app.analysis.top_performers import get_top_performers
    from app.notifications.telegram_bot import send_top_performers
    from app.scheduler.manager import update_last_run
    data = await get_top_performers()
    await send_top_performers(data)
    await update_last_run("top_performers")


async def job_virtual_entry():
    """10:00 AM — confirmation window buy check after SOTD fires."""
    from app.analysis.virtual_engine import try_entry
    from app.scheduler.manager import update_last_run
    import aiosqlite, json
    from app.config import DB_PATH
    from datetime import date
    # Read today's SOTD pick
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM stock_picks WHERE pick_date = ? ORDER BY id DESC LIMIT 1",
            (date.today().isoformat(),)
        ) as cur:
            pick = await cur.fetchone()
    if not pick:
        logger.info("job_virtual_entry: no SOTD pick today — skip")
        return
    sig   = json.loads(pick["signal_json"] or "{}")
    score = sig.get("confidence_score") or sig.get("score")
    price = (sig.get("metrics") or sig.get("technicals") or {}).get("price")
    regime = pick["regime"] or "BULL"
    if not score or not price:
        logger.info("job_virtual_entry: missing score/price in SOTD pick — skip")
        return
    result = await try_entry(pick["symbol"], int(score), regime, float(price))
    await update_last_run("virtual_entry")
    logger.info("job_virtual_entry: %s", result)


async def job_virtual_evaluation():
    """4:15 PM — daily position evaluation after market close."""
    from app.analysis.virtual_engine import evaluate_positions
    from app.notifications.telegram_bot import send_virtual_portfolio_update
    from app.scheduler.manager import update_last_run, get_schedule_telegram_enabled
    actions = await evaluate_positions()
    telegram_ok = await get_schedule_telegram_enabled("virtual_evaluation")
    if telegram_ok and actions:
        try:
            await send_virtual_portfolio_update(actions)
        except Exception as e:
            logger.warning("job_virtual_evaluation: telegram failed: %s", e)
    await update_last_run("virtual_evaluation")
    logger.info("job_virtual_evaluation: %d actions", len(actions))


async def _job_health_check():
    from app.performance.health_monitor import check_all_apis
    results = await check_all_apis()
    failed = [k for k, v in results.items() if v != "ok"]
    if failed:
        logger.warning("health_check: degraded APIs: %s", failed)
