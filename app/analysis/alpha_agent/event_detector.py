"""
Event detector — two-pass tier-aware scan with Macro Intelligence Layer.

Pass 1 (Universe): price/volume only, NO Haiku. Strong moves auto-promote.
                   All promoted stocks collected for Macro Intelligence Layer.

Macro Intelligence Layer: After Pass 1, 1 Haiku call per cycle detects
                   market narrative, regime, sector themes.

Opportunity Ranking: Ranks all movers by expected alpha vs SPY using
                   pattern memory. Minimum hurdle 3% alpha over 20d.

Pass 2 (Watchlist/Manual): Tiered committee — no more binary gate.
                   ≥80 → full 5-agent committee
                   50-79 → light review (Bull + Judge, 2 Haiku calls)
                   20-49 → log to counterfactual portfolio, watch
                   <20  → ignore

Volume normalization: before 11 AM ET, intraday vol is projected to
                   full-day equivalent so early movers aren't penalized.
"""

import os, json, logging, asyncio
import aiosqlite
import anthropic
import yfinance as yf
from datetime import datetime, UTC

import pytz

from app.config import DB_PATH
from app.analysis.alpha_agent import cost_tracker, watchlist as wl_mod, activity_log as alog
from app.analysis.alpha_agent import macro_intelligence, opportunity_ranking

log = logging.getLogger(__name__)
MODEL = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")

_ET = pytz.timezone("America/New_York")


async def _get_config() -> dict:
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute("SELECT key, value FROM alpha_agent_config") as cur:
                return {k: v for k, v in await cur.fetchall()}
    except Exception:
        return {}


def _normalize_volume(curr_vol: float, avg_vol: float) -> float:
    """
    Normalize intraday volume to projected full-day volume before 11 AM ET.
    Prevents early-session movers from being penalized for 'low volume'.
    """
    try:
        now_et = datetime.now(_ET)
        h, m = now_et.hour, now_et.minute
        # Market opens at 9:30 → full day = 390 minutes
        elapsed = max((h - 9) * 60 + (m - 30), 1)
        if elapsed < 90:  # before 11 AM ET
            projected_vol = curr_vol * (390 / elapsed)
            return projected_vol / avg_vol if avg_vol > 0 else 1.0
    except Exception:
        pass
    return curr_vol / avg_vol if avg_vol > 0 else 1.0


def _price_volume_check(ticker: str, price_threshold: float, volume_threshold: float) -> dict | None:
    """Pure price/volume check — no API cost, used for both tiers."""
    try:
        hist = yf.Ticker(ticker).history(period="5d")
        if hist.empty or len(hist) < 2:
            return None

        close    = hist["Close"]
        volume   = hist["Volume"]
        curr     = float(close.iloc[-1])
        prev     = float(close.iloc[-2])
        move     = (curr - prev) / prev * 100
        avg_vol  = float(volume.iloc[:-1].mean())
        curr_vol = float(volume.iloc[-1])

        # Use normalized (projected) vol ratio
        vol_ratio = _normalize_volume(curr_vol, avg_vol)

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


async def score_significance(ticker: str, event_data: dict, market_context: dict | None = None) -> int:
    """
    One Haiku call: score this watchlist event 0-100 with market context.
    New thresholds: 0-20 ignore / 20-49 counterfactual / 50-79 light / 80+ full
    """
    ctx_str = ""
    if market_context:
        ctx_str = f"""
MARKET CONTEXT:
- Today's regime: {market_context.get("regime", "NORMAL")}
- Theme: {market_context.get("primary_theme", "No theme")}
- Narrative: {market_context.get("narrative", "")}
- Sectors leading up: {", ".join(market_context.get("sectors_leading_up", []))}
- Sectors leading down: {", ".join(market_context.get("sectors_leading_down", []))}

Events that align with the dominant theme should score higher.
In EVENT_DRIVEN regime with clear macro theme: sector leaders scoring 50+ is expected.
"""

    prompt = f"""Rate the investment significance of this market event for {ticker}.
{ctx_str}
EVENT: {json.dumps(event_data, indent=2)[:800]}

Scoring guide (alpha-focused, not just news significance):
- 0-20:  routine noise — skip entirely
- 20-49: notable move but unclear alpha edge vs SPY — log for tracking
- 50-79: significant — likely alpha edge, worth light review
- 80-100: high conviction — strong alpha case, run full committee

Return ONLY: {{"score": 0-100, "reason": "one sentence explaining the alpha opportunity or why it lacks one"}}"""

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


async def _save_opportunities(narrative_id_hint: str, opportunities: list[dict]) -> None:
    """Persist ranked opportunities to the latest narrative record."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """UPDATE alpha_agent_market_narrative
                   SET opportunities_json=?
                   WHERE id=(SELECT MAX(id) FROM alpha_agent_market_narrative)""",
                (json.dumps(opportunities),),
            )
            await db.commit()
    except Exception as e:
        log.debug("save_opportunities failed: %s", e)


def _is_market_hours() -> bool:
    try:
        now_et = datetime.now(_ET)
        if now_et.weekday() >= 5:
            return False
        h, m = now_et.hour, now_et.minute
        return (h == 9 and m >= 30) or (10 <= h < 16)
    except Exception:
        return True


async def scan_watchlist() -> list[dict]:
    """
    Main scan entry point — called every 5 minutes by the scheduler.

    Pass 1 → Macro Intelligence Layer → Opportunity Ranking → Pass 2 (tiered).
    Returns list of events that triggered a committee run request.
    """
    cfg = await _get_config()
    if cfg.get("is_on", "0") != "1":
        return []
    if not _is_market_hours():
        return []

    wl_price_thresh   = float(cfg.get("event_price_threshold_pct", "2.0"))
    wl_vol_thresh     = float(cfg.get("event_volume_threshold", "2.0"))
    univ_price_thresh = float(cfg.get("universe_price_threshold", "3.0"))
    univ_vol_thresh   = float(cfg.get("universe_volume_threshold", "3.0"))

    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT COUNT(*) FROM alpha_agent_positions WHERE status='OPEN'"
        ) as cur:
            (open_count,) = await cur.fetchone()

    triggered_events: list[dict] = []
    universe_movers:  list[dict] = []  # collected for Macro Intelligence Layer

    await alog.write("event_scan",
                     "Event scan started — Pass 1 (universe) + Macro Intelligence + Pass 2 (tiered)",
                     level="info")

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
                # Add sector from static map (fast, no yfinance call)
                data["sector"] = macro_intelligence._get_sector(ticker)
                universe_movers.append(data)
                promoted = await wl_mod.promote_to_watchlist(ticker, reason)
                if promoted:
                    await _log_event(ticker, "price_volume", data, 50, False, "universe")
                    log.info("event_detector: promoted %s to watchlist (%s)", ticker, reason)
                    await alog.write(
                        "promotion",
                        f"{ticker} promoted to Watchlist — {reason}",
                        ticker=ticker, level="success",
                    )

        batch_size = 30
        for i in range(0, len(universe_tickers), batch_size):
            batch = universe_tickers[i:i + batch_size]
            await asyncio.gather(*[_check_universe(t) for t in batch])
            await asyncio.sleep(1)

    # ── Macro Intelligence Layer ──────────────────────────────────────────────
    # Runs once per scan cycle, 1 Haiku call regardless of stock count
    narrative: dict = {}
    opportunities: list[dict] = []

    if universe_movers:
        log.info("event_detector: Macro Intelligence — %d movers", len(universe_movers))
        try:
            narrative = await macro_intelligence.analyze_market_narrative(universe_movers)
            await alog.write(
                "macro_narrative",
                f"Market narrative: {narrative.get('primary_theme', '?')} | "
                f"Regime: {narrative.get('regime', '?')} | "
                f"Confidence: {narrative.get('confidence', 0)}%",
                level="info",
                metadata=narrative,
            )

            # Opportunity Ranking
            opportunities = await opportunity_ranking.rank_opportunities(
                universe_movers, narrative
            )
            await _save_opportunities("latest", opportunities)
            log.info("event_detector: ranked %d opportunities", len(opportunities))
        except Exception as e:
            log.warning("macro intelligence / ranking failed: %s", e)
            narrative = {"regime": "NORMAL", "primary_theme": "Unknown", "confidence": 50}
    else:
        # No universe movers — still generate a narrative (no activity)
        try:
            narrative = await macro_intelligence.analyze_market_narrative([])
        except Exception:
            narrative = {"regime": "NORMAL", "primary_theme": "No Activity", "confidence": 50}

    # ── Budget guard before Pass 2 ────────────────────────────────────────────
    daily_budget = float(cfg.get("daily_cost_budget", "0.15"))
    scan_abort   = float(cfg.get("scan_abort_threshold", "0.12"))
    from app.analysis.alpha_agent.cost_tracker import get_today_spend
    today_spend  = await get_today_spend()
    budget_ok    = today_spend["cost_usd"] < scan_abort

    if not budget_ok:
        await alog.write(
            "budget_warning",
            f"Significance scoring paused — daily spend ${today_spend['cost_usd']:.4f} "
            f"≥ scan abort threshold ${scan_abort:.2f} (budget ${daily_budget:.2f}). "
            f"Opportunities still ranked from pattern memory — no Haiku calls until tomorrow.",
            level="warning",
        )

    # ── Pass 2: Watchlist + Manual scan (tiered committee) ───────────────────
    watchlist_items = await wl_mod.get_watchlist(tier="watchlist")
    manual_items    = await wl_mod.get_watchlist(tier="manual")
    deep_items      = watchlist_items + manual_items

    if not deep_items:
        log.info("event_detector: Pass 2 — no watchlist/manual tickers")
        return triggered_events

    log.info("event_detector: Pass 2 — scanning %d watchlist/manual tickers", len(deep_items))

    # Build opportunity lookup by ticker for fast access
    opp_by_ticker = {o["ticker"]: o for o in opportunities}

    for item in deep_items:
        ticker = item["ticker"]
        tier   = item["tier"]

        data = await asyncio.to_thread(
            _price_volume_check, ticker, wl_price_thresh, wl_vol_thresh
        )
        if not data:
            await _update_last_evaluated(ticker)
            continue

        # Add sector to event data
        data["sector"] = macro_intelligence._get_sector(ticker)

        event_id = await _log_event(ticker, "price_volume", data, 0, False, tier)

        # ── Tiered routing via opportunity score (no per-stock Haiku call) ────
        # Opportunity score from pattern memory is more consistent and costs nothing.
        # Per-stock Haiku significance calls were too conservative (returned ~0 for
        # valid moves) and accounted for 60%+ of daily API spend.
        opp = opp_by_ticker.get(ticker)
        # If this watchlist stock wasn't in today's universe movers (already on
        # watchlist from a previous day), score it from price move + regime defaults.
        if not opp:
            from app.analysis.alpha_agent.opportunity_ranking import rank_opportunities
            data["sector"] = macro_intelligence._get_sector(ticker)
            opp_list = await rank_opportunities([data], narrative or {"regime": "NORMAL"})
            opp = opp_list[0] if opp_list else None

        blended_score = opp["score"] if opp else 0

        if blended_score >= 80 and open_count == 0:
            # ── Full 5-agent committee ────────────────────────────────────────
            await _log_event_triggered(ticker, event_id, significance, tier)
            triggered_events.append({
                **data,
                "event_id":     event_id,
                "significance": significance,
                "blended_score": blended_score,
                "tier":         tier,
                "review_type":  "FULL",
            })
            open_count += 1
            log.info("event_detector: %s score=%d → FULL committee", ticker, blended_score)
            await alog.write(
                "committee_trigger",
                f"{ticker} — score {blended_score} → full committee triggered ({' | '.join(data.get('triggers', []))})",
                ticker=ticker, level="alert",
                metadata={"significance": significance, "blended_score": blended_score,
                          "price_move": data.get("price_move"), "review_type": "FULL"},
            )

        elif blended_score >= 50:
            # ── Light Review (Bull + Judge) ───────────────────────────────────
            log.info("event_detector: %s score=%d → LIGHT review", ticker, blended_score)
            await alog.write(
                "light_review_trigger",
                f"{ticker} — score {blended_score} → light review triggered (expected alpha "
                f"{opp.get('expected_alpha_20d', '?'):+.1f}% vs SPY)" if opp else
                f"{ticker} — score {blended_score} → light review triggered",
                ticker=ticker, level="info",
                metadata={"significance": significance, "blended_score": blended_score,
                          "price_move": data.get("price_move"), "review_type": "LIGHT"},
            )
            try:
                from app.analysis.alpha_agent import light_review
                opp_for_review = opp or {
                    "expected_alpha_20d": 2.0, "meets_hurdle": False,
                    "confidence": 50, "sector": data.get("sector", "")
                }
                decision = await light_review.run_light_review(
                    ticker, data, opp_for_review, narrative, event_id
                )
                if decision.get("action") == "BUY" and open_count == 0:
                    triggered_events.append({
                        **data,
                        "event_id":     event_id,
                        "significance": significance,
                        "blended_score": blended_score,
                        "tier":         tier,
                        "review_type":  "LIGHT",
                        "run_id":       decision.get("run_id"),
                    })
                    open_count += 1
            except Exception as e:
                log.warning("light_review failed for %s: %s", ticker, e)

        elif blended_score >= 20:
            # ── Log to counterfactual (watch but don't trade) ─────────────────
            await alog.write(
                "event_scored",
                f"{ticker} — score {blended_score} (watch · logged to counterfactual)",
                ticker=ticker, level="info",
                metadata={"significance": significance, "blended_score": blended_score},
            )
            await opportunity_ranking.log_counterfactual(
                ticker=ticker,
                reason_passed=f"Score {blended_score} — below light review threshold (50)",
                price_at_pass=data.get("current_px", 0),
                expected_alpha=opp.get("expected_alpha_20d", 0) if opp else 0,
                regime=narrative.get("regime", "NORMAL"),
                theme=narrative.get("primary_theme", ""),
            )

        else:
            # Score < 20 — routine noise, skip silently
            pass

        await _update_last_evaluated(ticker)

    return triggered_events


async def _log_event_triggered(ticker: str, event_id: int, significance: int, tier: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE alpha_agent_events SET triggered_committee=1 WHERE id=?",
            (event_id,),
        )
        await db.commit()


async def _update_last_evaluated(ticker: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE alpha_agent_watchlist SET last_evaluated=? WHERE ticker=?",
            (datetime.now(UTC).isoformat(), ticker),
        )
        await db.commit()
