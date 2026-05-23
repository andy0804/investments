"""
Top Performers of the Day — runs at market close (4 PM ET weekdays).

Three sections:
  1. SOTD candidates pool: which candidate moved the most during the session
  2. FinViz top gainers: broad market leaders at close
  3. SOTD pick tracking: how today's morning pick did vs SPY
"""
import json
import logging
from datetime import date, datetime, UTC

import aiosqlite
import yfinance as yf

from app.config import DB_PATH

logger = logging.getLogger(__name__)


async def get_top_performers() -> dict:
    today = date.today().isoformat()

    # ── Section 1: SOTD candidates pool ─────────────────────────────────────────
    candidates_perf: list[dict] = []
    sotd_ticker: str | None = None
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT symbol, signal_json FROM stock_picks WHERE pick_date = ?", (today,)
            ) as cur:
                row = await cur.fetchone()

        if row:
            sotd_ticker = row[0]
            signal_json = json.loads(row[1] or "{}")
            all_candidates = signal_json.get("all_candidates", [])
            tickers = [c["ticker"] for c in all_candidates if c.get("passed_filter") and c.get("ticker")]

            if tickers:
                import asyncio
                data = await asyncio.to_thread(
                    lambda: yf.download(tickers, period="1d", interval="1d", progress=False, auto_adjust=True)
                )
                for t in tickers:
                    try:
                        if len(tickers) == 1:
                            o = float(data["Open"].iloc[0])
                            c = float(data["Close"].iloc[0])
                        else:
                            o = float(data["Open"][t].iloc[0])
                            c = float(data["Close"][t].iloc[0])
                        if o > 0:
                            chg = round((c - o) / o * 100, 2)
                            candidates_perf.append({"ticker": t, "open": round(o, 2), "close": round(c, 2), "change_pct": chg})
                    except Exception:
                        pass
                candidates_perf.sort(key=lambda x: -x["change_pct"])
    except Exception as e:
        logger.warning("top_performers: candidates section failed: %s", e)

    # ── Section 2: FinViz top gainers ────────────────────────────────────────────
    finviz_gainers: list[dict] = []
    try:
        import asyncio
        from finvizfinance.screener.performance import Performance

        def _fetch_gainers():
            fov = Performance()
            fov.set_filter(filters_dict={
                "Country":        "USA",
                "Market Cap.":    "+Mid (over $2bln)",
                "Average Volume": "Over 1M",
            })
            df = fov.screener_view(order="Change", ascend=False)
            out = []
            for _, row in df.head(10).iterrows():
                out.append({
                    "ticker":     str(row.get("Ticker", "")).strip(),
                    "company":    str(row.get("Company", "")).strip(),
                    "change_pct": float(str(row.get("Change", "0")).replace("%", "") or 0),
                    "volume":     str(row.get("Volume", "")),
                    "sector":     str(row.get("Sector", "")),
                })
            return out

        finviz_gainers = await asyncio.to_thread(_fetch_gainers)
    except Exception as e:
        logger.warning("top_performers: finviz gainers failed: %s", e)

    # ── Section 3: SOTD pick vs SPY ──────────────────────────────────────────────
    sotd_tracking: dict = {}
    if sotd_ticker:
        try:
            import asyncio
            data = await asyncio.to_thread(
                lambda: yf.download([sotd_ticker, "SPY"], period="1d", interval="1d", progress=False, auto_adjust=True)
            )

            def _ret(tkr: str) -> float | None:
                try:
                    o = float(data["Open"][tkr].iloc[0])
                    c = float(data["Close"][tkr].iloc[0])
                    return round((c - o) / o * 100, 2) if o > 0 else None
                except Exception:
                    return None

            stock_ret = _ret(sotd_ticker)
            spy_ret   = _ret("SPY")
            alpha     = round(stock_ret - spy_ret, 2) if stock_ret is not None and spy_ret is not None else None
            sotd_tracking = {
                "ticker":     sotd_ticker,
                "return_pct": stock_ret,
                "spy_pct":    spy_ret,
                "alpha":      alpha,
                "outcome":    "win" if alpha is not None and alpha > 0 else "loss" if alpha is not None else "unknown",
            }
        except Exception as e:
            logger.warning("top_performers: sotd tracking failed: %s", e)

    return {
        "date":               today,
        "generated_at":       datetime.now(UTC).isoformat(),
        "candidates_leaders": candidates_perf[:5],
        "finviz_gainers":     finviz_gainers[:10],
        "sotd_tracking":      sotd_tracking,
    }
