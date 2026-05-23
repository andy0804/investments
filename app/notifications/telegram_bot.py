import logging
import asyncio
from telegram import Bot, Update
from telegram.ext import Application, CommandHandler, ContextTypes
from telegram.constants import ParseMode
from app.config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
from app.notifications.formatters import (
    fmt_morning_brief, fmt_signal_alert, fmt_stop_trigger,
    fmt_target_hit, fmt_event_alert, fmt_ytd_coach,
    fmt_sotd_telegram, fmt_portfolio_intelligence_telegram, fmt_regime_shift,
    fmt_top_performers, fmt_strategy_refresh,
)

logger = logging.getLogger(__name__)

_bot: Bot = None
_daily_message_count = 0
_last_count_date = None
MAX_DAILY_MESSAGES = 8


async def get_bot() -> Bot:
    global _bot
    if _bot is None:
        _bot = Bot(token=TELEGRAM_BOT_TOKEN)
    return _bot


async def _is_telegram_enabled() -> bool:
    import aiosqlite
    from app.config import DB_PATH
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT value FROM agent_config WHERE key = 'telegram_enabled'"
            ) as cur:
                row = await cur.fetchone()
        return (row[0] if row else "true") == "true"
    except Exception:
        return True


async def send_message(text: str, force: bool = False) -> bool:
    if not await _is_telegram_enabled():
        logger.info("Telegram disabled via config — message suppressed")
        return False

    global _daily_message_count, _last_count_date
    from datetime import date
    today = date.today()
    if _last_count_date != today:
        _daily_message_count = 0
        _last_count_date = today

    if not force and _daily_message_count >= MAX_DAILY_MESSAGES:
        logger.info("Daily message cap reached (%d/%d)", _daily_message_count, MAX_DAILY_MESSAGES)
        return False

    try:
        bot = await get_bot()
        await bot.send_message(
            chat_id=TELEGRAM_CHAT_ID,
            text=text,
            parse_mode=ParseMode.MARKDOWN,
        )
        _daily_message_count += 1
        return True
    except Exception as e:
        logger.error("telegram send_message failed: %s", e)
        return False


async def send_morning_brief(brief: dict):
    await send_message(fmt_morning_brief(brief))


async def send_signal_alert(signal: dict):
    await send_message(fmt_signal_alert(signal), force=True)


async def send_stop_trigger(symbol: str, gain_pct: float, cost_basis: float, live_price: float):
    await send_message(fmt_stop_trigger(symbol, gain_pct, cost_basis, live_price), force=True)


async def send_target_hit(symbol: str, gain_pct: float, target_num: int):
    await send_message(fmt_target_hit(symbol, gain_pct, target_num), force=True)


async def send_ytd_coach(coaching: dict):
    await send_message(fmt_ytd_coach(coaching))


async def send_sotd_alert(result: dict):
    """Send the full SOTD pick — matches the dashboard Intelligence tab output."""
    await send_message(fmt_sotd_telegram(result), force=False)


async def send_portfolio_intelligence(data: dict):
    """Send the portfolio intelligence brief — matches the dashboard Portfolio tab."""
    await send_message(fmt_portfolio_intelligence_telegram(data), force=False)


async def send_regime_shift(old_regime: str, new_regime: str, mkt: dict):
    """Send regime change alert immediately — always forced (bypasses daily cap)."""
    await send_message(fmt_regime_shift(old_regime, new_regime, mkt), force=True)


async def send_top_performers(data: dict):
    """Send Top Performers of the Day close recap."""
    await send_message(fmt_top_performers(data), force=False)


async def send_virtual_portfolio_update(actions: list):
    """Send virtual portfolio daily evaluation summary."""
    from app.notifications.formatters import fmt_virtual_portfolio_update
    await send_message(fmt_virtual_portfolio_update(actions), force=False)


async def send_strategy_refresh(label: str, sotd_result: dict, strategy_picks: dict):
    """Send intraday strategy refresh with all 5 strategy picks — forced (bypasses daily cap)."""
    await send_message(fmt_strategy_refresh(label, sotd_result, strategy_picks), force=True)


# ── Command handlers ──────────────────────────────────────────────────────────

async def cmd_brief(update: Update, context: ContextTypes.DEFAULT_TYPE):
    from app.analysis.orchestrator import generate_morning_brief
    await update.message.reply_text("Generating brief... ⏳")
    brief = await generate_morning_brief()
    await update.message.reply_text(fmt_morning_brief(brief), parse_mode=ParseMode.MARKDOWN)


async def cmd_analyse(update: Update, context: ContextTypes.DEFAULT_TYPE):
    from app.analysis.orchestrator import generate_deep_dive
    args = context.args
    if not args:
        await update.message.reply_text("Usage: /analyse AAPL")
        return
    symbol = args[0].upper()
    await update.message.reply_text(f"Running deep dive on {symbol}... ⏳")
    result = await generate_deep_dive(symbol)
    verdict = result.get("verdict", "hold").upper()
    score = result.get("score", 5)
    reasoning = result.get("reasoning", "")[:400]
    await update.message.reply_text(
        f"*{symbol} Deep Dive*\n"
        f"Verdict: *{verdict}* | Score: {score}/10\n\n"
        f"_{reasoning}_\n\n"
        f"Reply /signals for all current signals",
        parse_mode=ParseMode.MARKDOWN,
    )


async def cmd_signals(update: Update, context: ContextTypes.DEFAULT_TYPE):
    import aiosqlite
    from app.config import DB_PATH
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT symbol, signal_type, score, created_at FROM signals ORDER BY created_at DESC LIMIT 10"
        ) as cur:
            rows = await cur.fetchall()
    if not rows:
        await update.message.reply_text("No signals yet. Use /analyse SYMBOL to generate one.")
        return
    lines = [f"• {r['symbol']}: {r['signal_type'].upper()} ({r['score']}/10)" for r in rows]
    await update.message.reply_text("*Recent Signals:*\n" + "\n".join(lines), parse_mode=ParseMode.MARKDOWN)


async def cmd_positions(update: Update, context: ContextTypes.DEFAULT_TYPE):
    import aiosqlite
    from app.config import DB_PATH
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT symbol, current_value, total_gain_loss_percent FROM positions "
            "WHERE position_type NOT IN ('Cash_MM') ORDER BY current_value DESC"
        ) as cur:
            rows = await cur.fetchall()
    if not rows:
        await update.message.reply_text("No positions loaded. Drop a CSV and use /reload.")
        return
    total = sum(r["current_value"] or 0 for r in rows)
    lines = [f"• {r['symbol']}: ${r['current_value']:,.0f} ({r['total_gain_loss_percent']:+.1f}%)" for r in rows]
    await update.message.reply_text(
        f"*Positions — ${total:,.0f} total*\n" + "\n".join(lines[:15]),
        parse_mode=ParseMode.MARKDOWN,
    )


async def cmd_macro(update: Update, context: ContextTypes.DEFAULT_TYPE):
    from app.analysis.macro import get_macro_snapshot
    macro = await get_macro_snapshot()
    await update.message.reply_text(
        f"*Macro Snapshot*\n"
        f"VIX: {macro.get('vix', 'N/A'):.1f} — {macro.get('vix_signal', '')}\n"
        f"Regime: {macro.get('market_regime', 'unknown').replace('_', ' ').title()}",
        parse_mode=ParseMode.MARKDOWN,
    )


async def cmd_coach(update: Update, context: ContextTypes.DEFAULT_TYPE):
    from app.analysis.orchestrator import generate_ytd_coach
    await update.message.reply_text("Generating coaching report... ⏳")
    coaching = await generate_ytd_coach()
    await update.message.reply_text(fmt_ytd_coach(coaching), parse_mode=ParseMode.MARKDOWN)


async def cmd_bought(update: Update, context: ContextTypes.DEFAULT_TYPE):
    import aiosqlite
    from app.config import DB_PATH
    args = context.args
    if len(args) < 3:
        await update.message.reply_text("Usage: /bought AAPL 10 150.00")
        return
    symbol, qty, price = args[0].upper(), float(args[1]), float(args[2])
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO trade_log (symbol, action, quantity, price, total_value) VALUES (?,?,?,?,?)",
            (symbol, "buy", qty, price, qty * price),
        )
        await db.commit()
    await update.message.reply_text(f"✅ Logged BUY: {qty} × {symbol} @ ${price:.2f} = ${qty*price:,.2f}")


async def cmd_sold(update: Update, context: ContextTypes.DEFAULT_TYPE):
    import aiosqlite
    from app.config import DB_PATH
    args = context.args
    if len(args) < 3:
        await update.message.reply_text("Usage: /sold AAPL 5 165.00")
        return
    symbol, qty, price = args[0].upper(), float(args[1]), float(args[2])
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO trade_log (symbol, action, quantity, price, total_value) VALUES (?,?,?,?,?)",
            (symbol, "sell", qty, price, qty * price),
        )
        await db.commit()
    await update.message.reply_text(f"✅ Logged SELL: {qty} × {symbol} @ ${price:.2f} = ${qty*price:,.2f}")


async def cmd_earnings(update: Update, context: ContextTypes.DEFAULT_TYPE):
    from app.connectors.fmp import get_earnings_calendar
    earnings = await get_earnings_calendar(days_ahead=14)
    if not earnings:
        await update.message.reply_text("No upcoming earnings in the next 14 days.")
        return
    lines = [f"• {e.get('symbol', '?')}: {e.get('date', '?')}" for e in earnings[:10]]
    await update.message.reply_text("*Upcoming Earnings (14 days):*\n" + "\n".join(lines),
                                    parse_mode=ParseMode.MARKDOWN)


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "*Investment Agent Commands*\n\n"
        "/brief — Morning portfolio brief\n"
        "/analyse SYMBOL — Deep dive analysis\n"
        "/signals — Recent trade signals\n"
        "/positions — Current holdings\n"
        "/macro — Market conditions & VIX\n"
        "/coach — Weekly coaching report\n"
        "/bought SYMBOL QTY PRICE — Log a buy\n"
        "/sold SYMBOL QTY PRICE — Log a sell\n"
        "/earnings — Upcoming earnings\n"
        "/help — This message",
        parse_mode=ParseMode.MARKDOWN,
    )


def build_telegram_app() -> Application:
    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("brief", cmd_brief))
    app.add_handler(CommandHandler("analyse", cmd_analyse))
    app.add_handler(CommandHandler("analyze", cmd_analyse))
    app.add_handler(CommandHandler("signals", cmd_signals))
    app.add_handler(CommandHandler("positions", cmd_positions))
    app.add_handler(CommandHandler("macro", cmd_macro))
    app.add_handler(CommandHandler("coach", cmd_coach))
    app.add_handler(CommandHandler("bought", cmd_bought))
    app.add_handler(CommandHandler("sold", cmd_sold))
    app.add_handler(CommandHandler("earnings", cmd_earnings))
    app.add_handler(CommandHandler("help", cmd_help))
    return app
