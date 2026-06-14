"""
Watchlist — three tiers:
  universe  : ~150 S&P 500 stocks, price/volume scan only, no Haiku calls
  watchlist : 20-30 agent-curated stocks, full scan + committee eligible
  manual    : user's own picks, full scan, never auto-aged

Promotion:  universe → watchlist  when a strong move is detected
Demotion:   watchlist → universe  after N days with no committee trigger
"""

import asyncio
import logging
from datetime import datetime, UTC, timedelta

import aiosqlite

from app.config import DB_PATH
from app.analysis.alpha_agent import activity_log as alog

log = logging.getLogger(__name__)

# Curated S&P 500 large/mid-cap universe — fetched from Wikipedia daily,
# but we keep a 200-ticker fallback so the agent works even offline.
_FALLBACK_UNIVERSE = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","GOOG","BRK-B","LLY","AVGO",
    "JPM","TSLA","UNH","XOM","V","MA","JNJ","COST","PG","HD",
    "ABBV","MRK","CVX","NFLX","CRM","BAC","AMD","PEP","KO","TMO",
    "WMT","ORCL","ACN","CSCO","ABT","MCD","DHR","LIN","TXN","NEE",
    "PM","ADBE","QCOM","NKE","IBM","HON","AMAT","INTC","AMGN","CAT",
    "INTU","GS","SPGI","MS","BLK","ISRG","MDT","SYK","DE","GILD",
    "AXP","RTX","NOW","PLD","CI","T","VZ","AMT","SCHW","ADI",
    "BKNG","REGN","MDLZ","VRTX","ETN","ZTS","MO","CB","AON","SBUX",
    "C","SLB","BMY","SO","DUK","PNC","USB","MMC","LRCX","CME",
    "CL","BDX","EQIX","HCA","ICE","TJX","APD","EMR","FIS","GE",
    "MCO","NOC","NSC","PSA","PXD","TGT","WM","ADP","ECL","KLAC",
    "F","GM","DAL","UAL","LUV","BA","GD","LMT","HII","TDG",
    "PANW","CRWD","SNOW","DDOG","ZS","FTNT","OKTA","NET","MDB","CFLT",
    "SHOP","SQ","PYPL","COIN","RBLX","HOOD","SOFI","AFFIRM","AFRM","U",
    "ENPH","FSLR","RUN","BE","PLUG","CHPT","RIVN","LCID","NIO","XPEV",
    "WFC","COF","DFS","SYF","AIG","ALL","MET","PRU","UNM","AFL",
    "CVS","WBA","MCK","ABC","CAH","HUM","MOH","CNC","ELV","ANTM",
    "DIS","PARA","WBD","NWSA","FOX","LYV","IEX","MTCH","SNAP","PINS",
    "UBER","LYFT","ABNB","DASH","CART","EXPE","BKNG","H","MAR","HLT",
]


async def _load_config() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT key, value FROM alpha_agent_config") as cur:
            return {k: v for k, v in await cur.fetchall()}


async def fetch_sp500_tickers() -> list[str]:
    """
    Fetch current S&P 500 constituent tickers from Wikipedia.
    Falls back to the hardcoded list if the request fails.
    """
    try:
        import requests
        import pandas as pd
        resp = requests.get(
            "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
            timeout=10,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        resp.raise_for_status()
        tables = pd.read_html(resp.text)
        tickers = tables[0]["Symbol"].tolist()
        # Wikipedia uses dots (BRK.B) but yfinance uses dashes (BRK-B)
        tickers = [t.replace(".", "-") for t in tickers]
        log.info("watchlist: fetched %d S&P 500 tickers from Wikipedia", len(tickers))
        return tickers
    except Exception as e:
        log.warning("watchlist: Wikipedia fetch failed (%s), using fallback universe", e)
        return list(_FALLBACK_UNIVERSE)


async def screen_universe() -> int:
    """
    Daily job: fetch S&P 500 tickers, filter by market cap + volume,
    upsert qualifying tickers into the universe tier.
    Returns number of tickers now in universe.
    """
    import yfinance as yf

    cfg = await _load_config()
    if cfg.get("universe_enabled", "1") != "1":
        return 0

    min_cap_b  = float(cfg.get("universe_min_market_cap_b", "5"))
    min_vol_m  = float(cfg.get("universe_min_volume_m", "1"))

    tickers = await fetch_sp500_tickers()
    qualified: list[str] = []

    # Batch-download basic info — yfinance fast_info is the lightest call
    log.info("watchlist: screening %d tickers for universe…", len(tickers))

    async def _check(ticker: str) -> str | None:
        try:
            info = await asyncio.to_thread(lambda: yf.Ticker(ticker).fast_info)
            market_cap = getattr(info, "market_cap", None) or 0
            avg_volume = getattr(info, "three_month_average_volume", None) or 0
            if market_cap >= min_cap_b * 1e9 and avg_volume >= min_vol_m * 1e6:
                return ticker
        except Exception:
            pass
        return None

    # Process in batches to avoid hammering the API
    batch_size = 20
    for i in range(0, len(tickers), batch_size):
        batch = tickers[i:i + batch_size]
        results = await asyncio.gather(*[_check(t) for t in batch])
        qualified.extend(t for t in results if t)
        await asyncio.sleep(0.5)

    log.info("watchlist: %d tickers qualified for universe", len(qualified))
    await alog.write("universe_screen",
                     f"Universe screened — {len(qualified)} S&P 500 stocks loaded",
                     level="info", metadata={"count": len(qualified)})

    now = datetime.now(UTC).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        # Remove stale universe tickers that no longer qualify
        await db.execute(
            "UPDATE alpha_agent_watchlist SET status='removed' WHERE tier='universe'"
        )
        for ticker in qualified:
            await db.execute(
                """INSERT INTO alpha_agent_watchlist
                   (ticker, source, tier, status, agent_notes, added_at)
                   VALUES (?, 'universe_screen', 'universe', 'active', 'S&P 500 universe', ?)
                   ON CONFLICT(ticker) DO UPDATE SET
                     status='active', tier='universe', added_at=excluded.added_at
                   WHERE tier='universe'""",
                (ticker, now),
            )
        await db.commit()

    return len(qualified)


async def promote_to_watchlist(ticker: str, reason: str) -> bool:
    """Move a universe ticker up to the watchlist tier for deep monitoring."""
    now = datetime.now(UTC).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT tier FROM alpha_agent_watchlist WHERE ticker=? AND status='active'",
            (ticker.upper(),),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return False
        if row[0] in ("watchlist", "manual"):
            return False  # Already there
        await db.execute(
            """UPDATE alpha_agent_watchlist
               SET tier='watchlist', agent_notes=?, promoted_at=?, last_evaluated=?
               WHERE ticker=?""",
            (f"Auto-promoted: {reason}", now, now, ticker.upper()),
        )
        await db.commit()
    log.info("watchlist: promoted %s to watchlist tier (%s)", ticker, reason)
    await alog.write("promotion",
                     f"{ticker} promoted to Watchlist — {reason}",
                     ticker=ticker, level="success")
    return True


async def auto_age_watchlist() -> int:
    """
    Demote watchlist-tier stocks that haven't triggered a committee in N days.
    Manual-tier stocks are never touched.
    Returns number demoted.
    """
    cfg = await _load_config()
    age_days = int(cfg.get("watchlist_auto_age_days", "30"))
    cutoff = (datetime.now(UTC) - timedelta(days=age_days)).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        # Stocks on watchlist tier that were promoted more than age_days ago
        # AND have no recent committee run
        async with db.execute(
            """SELECT w.ticker FROM alpha_agent_watchlist w
               WHERE w.tier = 'watchlist'
               AND w.status = 'active'
               AND (w.promoted_at IS NULL OR w.promoted_at < ?)
               AND NOT EXISTS (
                   SELECT 1 FROM alpha_agent_runs r
                   WHERE r.ticker = w.ticker
                   AND r.started_at > ?
               )""",
            (cutoff, cutoff),
        ) as cur:
            stale = [r[0] for r in await cur.fetchall()]

        for ticker in stale:
            await db.execute(
                "UPDATE alpha_agent_watchlist SET tier='universe', agent_notes='Auto-aged: no committee trigger in 30 days' WHERE ticker=?",
                (ticker,),
            )
        await db.commit()

    if stale:
        log.info("watchlist: auto-aged %d tickers back to universe tier: %s", len(stale), stale)
        await alog.write("auto_age",
                         f"Auto-age — {len(stale)} tickers demoted to universe tier: {', '.join(stale)}",
                         level="info", metadata={"tickers": stale})
    return len(stale)


# ─── CRUD (router-facing) ────────────────────────────────────────────────────

async def get_watchlist(tier: str = "") -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if tier:
            async with db.execute(
                "SELECT * FROM alpha_agent_watchlist WHERE tier=? AND status='active' ORDER BY added_at DESC",
                (tier,),
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute(
                "SELECT * FROM alpha_agent_watchlist WHERE status='active' ORDER BY tier, added_at DESC"
            ) as cur:
                rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_watchlist_summary() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT tier, COUNT(*) as cnt FROM alpha_agent_watchlist WHERE status='active' GROUP BY tier"
        ) as cur:
            rows = await cur.fetchall()
    return {r["tier"]: r["cnt"] for r in rows}


async def add_to_watchlist(ticker: str, source: str = "manual", notes: str = "") -> bool:
    ticker = ticker.upper().strip()
    now = datetime.now(UTC).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id, tier FROM alpha_agent_watchlist WHERE ticker=?", (ticker,)
        ) as cur:
            existing = await cur.fetchone()

        if existing:
            # Re-activate and promote to manual if re-added by user
            await db.execute(
                "UPDATE alpha_agent_watchlist SET status='active', tier='manual', source='manual', agent_notes=? WHERE ticker=?",
                (notes or "Manually added", ticker),
            )
        else:
            await db.execute(
                """INSERT INTO alpha_agent_watchlist
                   (ticker, source, tier, status, agent_notes, added_at)
                   VALUES (?, ?, 'manual', 'active', ?, ?)""",
                (ticker, source, notes or "Manually added", now),
            )
        await db.commit()
    log.info("watchlist +%s (manual)", ticker)
    return True


async def remove_from_watchlist(ticker: str) -> bool:
    ticker = ticker.upper().strip()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "UPDATE alpha_agent_watchlist SET status='removed' WHERE ticker=? AND tier IN ('watchlist','manual')",
            (ticker,),
        ) as cur:
            removed = cur.rowcount
        await db.commit()
    return removed > 0


async def seed_from_sotd_history(min_confidence: int = 65) -> int:
    """Seed watchlist tier from high-confidence past SOTD picks."""
    now = datetime.now(UTC).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT COUNT(*) FROM alpha_agent_watchlist WHERE source='sotd_history'"
        ) as cur:
            (already,) = await cur.fetchone()
        if already > 0:
            return 0

        try:
            async with db.execute(
                """SELECT DISTINCT symbol FROM stock_picks
                   WHERE symbol IS NOT NULL AND symbol != ''
                   AND json_extract(signal_json,'$.stock_of_the_day.confidence_score') >= ?
                   ORDER BY pick_date DESC LIMIT 30""",
                (min_confidence,),
            ) as cur:
                rows = await cur.fetchall()
        except Exception:
            return 0

        count = 0
        for (ticker,) in rows:
            await db.execute(
                """INSERT OR IGNORE INTO alpha_agent_watchlist
                   (ticker, source, tier, status, agent_notes, added_at)
                   VALUES (?, 'sotd_history', 'watchlist', 'active',
                           'Seeded from SOTD history', ?)""",
                (ticker.upper(), now),
            )
            count += 1
        await db.commit()
    log.info("watchlist: seeded %d tickers from SOTD history → watchlist tier", count)
    return count


async def get_active_tickers(tier: str = "") -> list[str]:
    async with aiosqlite.connect(DB_PATH) as db:
        if tier:
            async with db.execute(
                "SELECT ticker FROM alpha_agent_watchlist WHERE status='active' AND tier=?",
                (tier,),
            ) as cur:
                return [r[0] for r in await cur.fetchall()]
        async with db.execute(
            "SELECT ticker FROM alpha_agent_watchlist WHERE status='active'"
        ) as cur:
            return [r[0] for r in await cur.fetchall()]
