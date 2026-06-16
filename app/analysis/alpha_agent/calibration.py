"""
Calibration Engine — Phase 3.

1. run_calibration()       Weekly job: compares predicted vs actual alpha per
                           alpha_source. Proposes confidence adjustments when
                           error > 2%. Stored in alpha_agent_calibration.

2. apply_calibration(id)   User-approved: applies multiplier to alpha_pattern_memory.

3. run_prediction_audit()  Sunday async: Haiku reads 30 days of data, detects
                           systematic biases, writes to strategy_log.

4. resolve_counterfactuals() Background: fetches current prices for unresolved
                           counterfactual entries (passed opportunities), computes
                           5d/20d returns so opportunity cost can be calculated.
"""

import os, json, logging
import aiosqlite
import yfinance as yf
import asyncio
from datetime import datetime, UTC, timedelta

from anthropic import AsyncAnthropic

from app.config import DB_PATH
from app.analysis.alpha_agent import cost_tracker, activity_log as alog

log = logging.getLogger(__name__)
_HAIKU  = os.getenv("ANTHROPIC_MODEL_HAIKU",  "claude-haiku-4-5-20251001")
_SONNET = os.getenv("ANTHROPIC_MODEL_SONNET",  "claude-sonnet-4-6")


# ── Calibration Engine ────────────────────────────────────────────────────────

async def run_calibration() -> dict:
    """
    Reads all resolved alpha_agent_predictions from last 30 days.
    Groups by alpha_source, computes calibration error.
    Writes PENDING proposals to alpha_agent_calibration when error > 2%.
    """
    since = (datetime.now(UTC) - timedelta(days=30)).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT alpha_source, predicted_alpha_20d, actual_alpha_20d
               FROM alpha_agent_predictions
               WHERE resolved_at IS NOT NULL
                 AND actual_alpha_20d IS NOT NULL
                 AND created_at >= ?""",
            (since,),
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]

    if not rows:
        return {"status": "no_data", "message": "No resolved predictions in last 30 days"}

    # Group by alpha_source
    by_source: dict[str, list[dict]] = {}
    for r in rows:
        src = r.get("alpha_source") or "Unknown"
        by_source.setdefault(src, []).append(r)

    proposals_created = 0
    report: dict[str, dict] = {}

    async with aiosqlite.connect(DB_PATH) as db:
        for src, records in by_source.items():
            n = len(records)
            avg_pred   = sum(r["predicted_alpha_20d"] for r in records) / n
            avg_actual = sum(r["actual_alpha_20d"]    for r in records) / n
            error      = avg_pred - avg_actual  # positive = overestimate

            report[src] = {
                "observations":   n,
                "avg_predicted":  round(avg_pred,   2),
                "avg_actual":     round(avg_actual,  2),
                "calibration_error": round(error,   2),
                "well_calibrated": abs(error) < 2.0,
            }

            # Propose adjustment only when error is meaningful
            if n >= 3 and abs(error) >= 2.0:
                # Multiplier: shrink confidence proportionally to overestimate
                proposed_mult = round(avg_actual / avg_pred, 3) if avg_pred != 0 else 1.0
                proposed_mult = max(0.3, min(2.0, proposed_mult))  # clamp

                # Don't duplicate pending proposals for the same source
                async with db.execute(
                    """SELECT id FROM alpha_agent_calibration
                       WHERE alpha_source=? AND status='PENDING'""",
                    (src,),
                ) as cur:
                    existing = await cur.fetchone()

                if not existing:
                    period_start = since[:10]
                    period_end   = datetime.now(UTC).date().isoformat()
                    await db.execute(
                        """INSERT INTO alpha_agent_calibration
                           (period_start, period_end, alpha_source, observations,
                            avg_predicted, avg_actual, calibration_error,
                            proposed_multiplier, status, created_at)
                           VALUES (?,?,?,?,?,?,?,?,'PENDING',?)""",
                        (period_start, period_end, src, n,
                         round(avg_pred, 2), round(avg_actual, 2),
                         round(error, 2), proposed_mult,
                         datetime.now(UTC).isoformat()),
                    )
                    proposals_created += 1

        await db.commit()

    await alog.write(
        "calibration_run",
        f"Calibration complete — {len(report)} alpha sources, {proposals_created} new belief update proposals",
        level="info",
        metadata={"report": report, "proposals_created": proposals_created},
    )
    return {
        "status":            "ok",
        "sources_evaluated": len(report),
        "proposals_created": proposals_created,
        "report":            report,
    }


async def apply_calibration(calibration_id: int) -> dict:
    """
    User approved a calibration proposal.
    Multiplies confidence in matching alpha_pattern_memory rows.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_calibration WHERE id=? AND status='PENDING'",
            (calibration_id,),
        ) as cur:
            cal = await cur.fetchone()

    if not cal:
        return {"error": "Calibration record not found or not pending"}

    cal = dict(cal)
    src  = cal["alpha_source"]
    mult = float(cal["proposed_multiplier"] or 1.0)

    async with aiosqlite.connect(DB_PATH) as db:
        # Update all matching pattern memory entries
        async with db.execute(
            "SELECT id, confidence FROM alpha_pattern_memory WHERE alpha_source LIKE ?",
            (f"%{src}%",),
        ) as cur:
            patterns = [dict(r) for r in await cur.fetchall()]

        for p in patterns:
            new_conf = min(95, max(20, round(float(p["confidence"]) * mult, 1)))
            await db.execute(
                "UPDATE alpha_pattern_memory SET confidence=?, last_updated=? WHERE id=?",
                (new_conf, datetime.now(UTC).isoformat(), p["id"]),
            )

        await db.execute(
            "UPDATE alpha_agent_calibration SET status='APPLIED', created_at=? WHERE id=?",
            (datetime.now(UTC).isoformat(), calibration_id),
        )
        await db.commit()

    await alog.write(
        "belief_update_applied",
        f"Belief update applied — {src}: confidence ×{mult:.2f} ({len(patterns)} patterns updated)",
        level="success",
        metadata={"alpha_source": src, "multiplier": mult, "patterns_updated": len(patterns)},
    )
    return {"status": "applied", "alpha_source": src, "multiplier": mult,
            "patterns_updated": len(patterns)}


async def reject_calibration(calibration_id: int) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE alpha_agent_calibration SET status='REJECTED', created_at=? WHERE id=?",
            (datetime.now(UTC).isoformat(), calibration_id),
        )
        await db.commit()
    return {"status": "rejected"}


async def get_calibration_reports(status: str = "") -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if status:
            async with db.execute(
                "SELECT * FROM alpha_agent_calibration WHERE status=? ORDER BY created_at DESC",
                (status.upper(),),
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute(
                "SELECT * FROM alpha_agent_calibration ORDER BY created_at DESC LIMIT 50"
            ) as cur:
                rows = await cur.fetchall()
    return [dict(r) for r in rows]


# ── Prediction Audit Agent ────────────────────────────────────────────────────

async def run_prediction_audit() -> dict | None:
    """
    Runs Sunday evenings. Haiku reads 30 days of prediction vs outcome data,
    detects systematic biases, proposes belief updates.
    Uses Haiku (not Sonnet) to stay within cost budget.
    """
    since = (datetime.now(UTC) - timedelta(days=30)).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT alpha_source, regime_at_entry, theme_at_entry,
                      predicted_alpha_20d, actual_alpha_20d,
                      committee_confidence, entry_date
               FROM alpha_agent_predictions
               WHERE resolved_at IS NOT NULL
                 AND actual_alpha_20d IS NOT NULL
                 AND created_at >= ?
               ORDER BY created_at DESC""",
            (since,),
        ) as cur:
            preds = [dict(r) for r in await cur.fetchall()]

    if len(preds) < 3:
        log.info("prediction_audit: not enough data (%d predictions)", len(preds))
        return None

    pred_summary = json.dumps([
        {
            "alpha_source":      p["alpha_source"],
            "regime":            p["regime_at_entry"],
            "predicted_alpha":   p["predicted_alpha_20d"],
            "actual_alpha":      p["actual_alpha_20d"],
            "error":             round((p["predicted_alpha_20d"] or 0) - (p["actual_alpha_20d"] or 0), 2),
            "confidence":        p["committee_confidence"],
        }
        for p in preds
    ], indent=2)[:2000]

    prompt = f"""You are a prediction accuracy auditor for an AI trading agent.

Below are the last 30 days of trade predictions vs actual outcomes (alpha vs SPY):
{pred_summary}

Total predictions: {len(preds)}

Analyze this data and identify:
1. CALIBRATION: Which alpha source types is the agent most/least accurate on?
2. SYSTEMATIC BIAS: Any consistent pattern of over- or under-estimation?
3. REGIME INSIGHT: Does accuracy vary by market regime?
4. BELIEF UPDATE: What single most important adjustment should be made to improve future predictions?

Return JSON:
{{
  "calibration_summary": "2 sentences on overall accuracy",
  "systematic_bias": "describe the main bias found, or 'none detected'",
  "regime_insight": "does accuracy vary by regime? what pattern?",
  "belief_update": "one concrete actionable change to the prediction model",
  "confidence_in_findings": 0-100
}}"""

    client = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
    try:
        resp = await client.messages.create(
            model=_HAIKU, max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        text = resp.content[0].text.strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        await cost_tracker.log_call(
            "prediction_audit", _HAIKU,
            resp.usage.input_tokens, resp.usage.output_tokens, None,
        )
        audit = json.loads(text.strip())
    except Exception as e:
        log.error("prediction_audit failed: %s", e)
        return None

    # Write to strategy_log as a weekly entry
    week_start = (datetime.now(UTC).date() - timedelta(days=7)).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT OR REPLACE INTO alpha_agent_strategy_log
               (week_start, trades_count, llm_analysis, created_at)
               VALUES (?, ?, ?, ?)""",
            (
                week_start, len(preds),
                f"[PREDICTION AUDIT] {audit.get('calibration_summary', '')} "
                f"Bias: {audit.get('systematic_bias', '')} "
                f"Update: {audit.get('belief_update', '')}",
                datetime.now(UTC).isoformat(),
            ),
        )
        await db.commit()

    await alog.write(
        "prediction_audit_complete",
        f"Prediction audit — {len(preds)} predictions reviewed | "
        f"Bias: {audit.get('systematic_bias', 'none')}",
        level="info",
        metadata=audit,
    )
    return {"predictions_reviewed": len(preds), **audit}


# ── Counterfactual Outcome Resolution ────────────────────────────────────────

async def resolve_counterfactual_outcomes() -> int:
    """
    For all unresolved counterfactuals, fetch current price and compute
    5d / 20d returns + SPY returns over same period.
    Called weekly (or on demand from router).
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT * FROM alpha_agent_counterfactuals
               WHERE return_20d IS NULL
               ORDER BY passed_at ASC"""
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]

    if not rows:
        return 0

    resolved = 0
    # Batch fetch SPY to avoid repeated calls
    spy_hist = None
    try:
        spy_hist = await asyncio.to_thread(lambda: yf.Ticker("SPY").history(period="60d"))
    except Exception:
        pass

    for cf in rows:
        ticker    = cf["ticker"]
        passed_at = cf["passed_at"]
        try:
            pass_date = datetime.fromisoformat(passed_at).date()
        except Exception:
            continue

        days_since = (datetime.now(UTC).date() - pass_date).days
        if days_since < 5:
            continue  # Too early to evaluate 5d return

        try:
            hist = await asyncio.to_thread(
                lambda t=ticker: yf.Ticker(t).history(period="60d")
            )
            if hist.empty:
                continue

            # Find prices at pass date + 5d/20d after
            hist.index = hist.index.tz_localize(None) if hist.index.tzinfo else hist.index
            dates_available = [d.date() for d in hist.index]

            def find_price_near(target_date):
                for offset in range(5):
                    for d in dates_available:
                        if d >= target_date + timedelta(days=offset):
                            idx = dates_available.index(d)
                            return float(hist["Close"].iloc[idx])
                return None

            price_at_pass = cf.get("price_at_pass") or find_price_near(pass_date)
            price_5d  = find_price_near(pass_date + timedelta(days=5))  if days_since >= 5  else None
            price_20d = find_price_near(pass_date + timedelta(days=20)) if days_since >= 20 else None

            ret_5d  = round((price_5d  / price_at_pass - 1) * 100, 2) if price_at_pass and price_5d  else None
            ret_20d = round((price_20d / price_at_pass - 1) * 100, 2) if price_at_pass and price_20d else None

            # SPY over same period
            spy_ret_20d = None
            if spy_hist is not None and not spy_hist.empty and price_at_pass and days_since >= 20:
                spy_dates = [d.date() for d in spy_hist.index.tz_localize(None).to_list()
                             if hasattr(d, 'date')]
                spy_pass  = find_price_near(pass_date) if spy_hist is not None else None
                spy_20d   = find_price_near(pass_date + timedelta(days=20)) if spy_hist is not None else None
                if spy_pass and spy_20d:
                    spy_ret_20d = round((spy_20d / spy_pass - 1) * 100, 2)

            alpha_20d = round(ret_20d - spy_ret_20d, 2) if ret_20d is not None and spy_ret_20d is not None else None

            async with aiosqlite.connect(DB_PATH) as db:
                await db.execute(
                    """UPDATE alpha_agent_counterfactuals
                       SET return_5d=?, return_20d=?, spy_return_20d=?,
                           alpha_20d=?, resolved_at=?
                       WHERE id=?""",
                    (ret_5d, ret_20d, spy_ret_20d, alpha_20d,
                     datetime.now(UTC).isoformat(), cf["id"]),
                )
                await db.commit()
            resolved += 1
        except Exception as e:
            log.debug("resolve_counterfactual failed for %s: %s", ticker, e)

    log.info("counterfactual resolution: %d/%d resolved", resolved, len(rows))
    return resolved


async def get_counterfactual_summary() -> dict:
    """Returns counterfactual portfolio summary with opportunity cost."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM alpha_agent_counterfactuals ORDER BY passed_at DESC LIMIT 50"
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]

    total = len(rows)
    resolved = [r for r in rows if r.get("return_20d") is not None]

    opportunity_cost = 0.0
    if resolved:
        # Opportunity cost = avg(actual_alpha) for resolved counterfactuals
        # In dollar terms: assume $10k portfolio, each counterfactual was ~7% (typical position)
        avg_alpha = sum(r["alpha_20d"] or 0 for r in resolved) / len(resolved)
        opportunity_cost = round(avg_alpha * 0.07 * 10000 / 100 * len(resolved), 2)

    # Detect systematic bias via simple heuristic
    passed_positive = [r for r in resolved if (r.get("alpha_20d") or 0) > 3]
    bias_detected = len(passed_positive) > len(resolved) * 0.6 if resolved else False
    bias_message = (
        f"Consistently passed on opportunities that averaged +{sum(r['alpha_20d'] or 0 for r in passed_positive)/len(passed_positive):.1f}% alpha"
        if bias_detected and passed_positive else ""
    )

    return {
        "total_tracked": total,
        "resolved": len(resolved),
        "opportunity_cost_usd": opportunity_cost,
        "bias_detected": bias_detected,
        "bias_message": bias_message,
        "recent": rows[:10],
    }
