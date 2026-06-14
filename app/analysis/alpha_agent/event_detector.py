"""
Event detector — two-pass tier-aware scan.

Pass 1 (Universe):  price/volume only, NO Haiku calls.
                    A strong move auto-promotes the ticker to watchlist tier.
Pass 2 (Watchlist/Manual): price/volume + Haiku significance scoring.
                    High-scoring events trigger the full committee.

This keeps universe scanning cheap (0 API calls) while giving watchlist
stocks the full treatment.
"""

import os, json, logging, asyncio
import aiosqlite
import anthropic
import yfinance as yf
from datetime import datetime, UTC

from app.config import DB_PATH
from app.analysis.alpha_agent import cost_tracker, watchlist as wl_mod, activity_log as alog

log = logging.getLogger(__name__)
MODEL = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")


async def _get_config() -> dict:
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute("SELECT key, value FROM alpha_agent_config") as cur:
                return {k: v for k, v in await cur.fetchall()}
    except Exception:
        return {}


def _price_volume_check(ticker: str, price_threshold: float, volume_threshold: float) -> dict | None:
    """Pure price/volume check — no API cost, used for both tiers."""
    try:
        hist = yf.Ticker(ticker).history(period="5d")
        if hist.empty or len(hist) < 2:
            return None

        close   = hist["Close"]
        volume  = hist["Volume"]
        curr    = float(close.iloc[-1])
        prev    = float(close.iloc[-2])
        move    = (curr - prev) / prev * 100
        avg_vol = float(volume.iloc[:-1].mean())
        curr_vol= float(volume.iloc[-1])
        vol_ratio = curr_vol / avg_vol if avg_vol > 0 else 1.0

        triggers = []
        if abs(move) >= price_threshold:
            triggers.append(f"Price {'+' if move > 0 else ''}{move:.1f}% today")
        if vol_ratio >= volume_threshold:
            triggers.append(f"Volume {vol_ratio:.1f}× average")

        if not triggers:
            return None

        return {
            "ticker":     ticker,
            "event_type": "price_volume",
            "price_move": round(move, 2),
            "vol_ratio":  round(vol_ratio, 2),
            "current_px": round(curr, 2),
            "triggers":   triggers,
        }
    except Exception as e:
        log.debug("price check failed %s: %s", ticker, e)
        return None


async def score_significance(ticker: str, event_data: dict) -> int:
    """One Haiku call: is this watchlist event worth a committee run?"""
    prompt = f"""Rate the investment significance of this market event for {ticker}.

EVENT: {json.dumps(event_data, indent=2)[:800]}

Score 0-100:
- 0-40: routine noise, skip
- 41-60: notable but not urgent
- 61-80: significant, run committee
- 81-100: high conviction signal

Return ONLY: {{"score": 0-100, "reason": "one sentence"}}"""

    client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
    try:
        response = await client.messages.create(
            model=MODEL, max_tokens=100,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text.strip()
        await cost_tracker.log_call(
            "significance", MODEL,
            response.usage.input_tokens, response.usage.output_tokens, None,
        )
        result = json.loads(text)
        return int(result.get("score", 0))
    except Exception as e:
        log.warning("significance scoring failed: %s", e)
        return 0


async def _log_event(ticker: str, event_type: str, data: dict,
                     significance: int, triggered: bool, tier: str) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """INSERT INTO alpha_agent_events
               (ticker, event_type, event_data_json, significance_score,
                triggered_committee, detected_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (ticker, f"{tier}:{event_type}", json.dumps(data),
             significance, int(triggered), datetime.now(UTC).isoformat()),
        ) as cur:
            event_id = cur.lastrowid
        await db.commit()
    return event_id


def _is_market_hours() -> bool:
    try:
        import pytz
        et = pytz.timezone("America/New_York")
        now_et = datetime.now(et)
        if now_et.weekday() >= 5:
            return False
        h, m = now_et.hour, now_et.minute
        return (h == 9 and m >= 30) or (10 <= h < 16)
    except Exception:
        return True  # default open if timezone lib missing


async def scan_watchlist() -> list[dict]:
    """
    Main scan entry point — called every 5 minutes by the scheduler.
    Runs Pass 1 (universe) then Pass 2 (watchlist/manual).
    Returns list of events that triggered a committee run request.
    """
    cfg = await _get_config()
    if cfg.get("is_on", "0") != "1":
        return []
    if not _is_market_hours():
        return []

    # Config values
    wl_price_thresh   = float(cfg.get("event_price_threshold_pct", "2.0"))
    wl_vol_thresh     = float(cfg.get("event_volume_threshold", "2.0"))
    univ_price_thresh = float(cfg.get("universe_price_threshold", "3.0"))
    univ_vol_thresh   = float(cfg.get("universe_volume_threshold", "3.0"))
    min_significance  = int(cfg.get("significance_min_score", "60"))

    # How many positions are open?
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT COUNT(*) FROM alpha_agent_positions WHERE status='OPEN'"
        ) as cur:
            (open_count,) = await cur.fetchone()

    triggered_events: list[dict] = []
    await alog.write("event_scan", "Event scan started — Pass 1 (universe) + Pass 2 (watchlist)", level="info")

    # ── Pass 1: Universe scan (no Haiku, promotion only) ─────────────────────
    universe_tickers = await wl_mod.get_active_tickers(tier="universe")
    if universe_tickers:
        log.info("event_detector: Pass 1 — scanning %d universe tickers", len(universe_tickers))

        async def _check_universe(ticker: str):
            data = await asyncio.to_thread(
                _price_volume_check, ticker, univ_price_thresh, univ_vol_thresh
            )
            if data:
                reason = " | ".join(data["triggers"])
                promoted = await wl_mod.promote_to_watchlist(ticker, reason)
                if promoted:
                    await _log_event(ticker, "price_volume", data, 50, False, "universe")
                    log.info("event_detector: promoted %s to watchlist (%s)", ticker, reason)

        # Batch to keep yfinance happy
        batch_size = 30
        for i in range(0, len(universe_tickers), batch_size):
            batch = universe_tickers[i:i + batch_size]
            await asyncio.gather(*[_check_universe(t) for t in batch])
            await asyncio.sleep(1)

    # ── Pass 2: Watchlist + Manual scan (full treatment) ─────────────────────
    watchlist_items = await wl_mod.get_watchlist(tier="watchlist")
    manual_items    = await wl_mod.get_watchlist(tier="manual")
    deep_items      = watchlist_items + manual_items

    if not deep_items:
        log.info("event_detector: Pass 2 — no watchlist/manual tickers")
        return triggered_events

    log.info("event_detector: Pass 2 — scanning %d watchlist/manual tickers", len(deep_items))

    for item in deep_items:
        ticker = item["ticker"]
        tier   = item["tier"]

        data = await asyncio.to_thread(
            _price_volume_check, ticker, wl_price_thresh, wl_vol_thresh
        )
        if not data:
            await _update_last_evaluated(ticker)
            continue

        # Score significance — this is where we spend ~$0.001
        significance = await score_significance(ticker, data)
        should_trigger = (
            significance >= min_significance
            and open_count == 0  # don't stack positions
        )

        event_id = await _log_event(ticker, "price_volume", data,
                                    significance, should_trigger, tier)

        if should_trigger:
            log.info("event_detector: %s score=%d → committee", ticker, significance)
            await alog.write(
                "committee_trigger",
                f"{ticker} — significance {significance} → committee triggered ({' | '.join(data.get('triggers', []))})",
                ticker=ticker, level="alert",
                metadata={"significance": significance, "price_move": data.get("price_move"), "vol_ratio": data.get("vol_ratio")},
            )
            triggered_events.append({
                **data,
                "event_id":    event_id,
                "significance": significance,
                "tier":         tier,
            })
            open_count += 1  # count optimistically to avoid stacking
        elif significance > 0:
            await alog.write(
                "event_scored",
                f"{ticker} — significance {significance} (below threshold, no committee)",
                ticker=ticker, level="info",
                metadata={"significance": significance},
            )

        await _update_last_evaluated(ticker)

    return triggered_events


async def _update_last_evaluated(ticker: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE alpha_agent_watchlist SET last_evaluated=? WHERE ticker=?",
            (datetime.now(UTC).isoformat(), ticker),
        )
        await db.commit()
