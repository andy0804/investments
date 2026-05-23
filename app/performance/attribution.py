"""
app/performance/attribution.py

Self-improvement feedback loop for the SOTD pipeline.

Three jobs:
  1. get_performance_series()     → time-series for the dashboard charts
                                    (rolling win rate + cumulative alpha vs SPY)
  2. compute_weekly_attribution() → weekly snapshot stored in performance_attribution
  3. auto_generate_proposals()    → scans for drift patterns and writes correction_proposals

Correction proposals are surfaced in the UI for human approval before anything changes.
"""

import json
import logging
from datetime import date, datetime, timedelta, UTC

import aiosqlite

from app.config import DB_PATH

logger = logging.getLogger(__name__)


# ── Performance time-series for charts ───────────────────────────────────────

async def get_performance_series() -> dict:
    """
    Return pick-by-pick time-series data for:
      - rolling_win_rate  (8-pick rolling window)
      - cumulative_alpha  (running sum of alpha_14d for evaluated picks)
    Also returns the raw per-pick rows for the table.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT
                 se.pick_date, se.ticker, se.confidence_score, se.tier,
                 se.signal_type, se.regime,
                 so.entry_price, so.return_7d, so.return_14d,
                 so.alpha_7d, so.alpha_14d, so.outcome, so.evaluated_at
               FROM signal_events se
               LEFT JOIN signal_outcomes so ON so.signal_event_id = se.id
               ORDER BY se.pick_date ASC"""
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]

    evaluated = [r for r in rows if r.get("outcome") is not None]

    # ── Rolling 8-pick win rate ───────────────────────────────────────────────
    win_rate_series = []
    for i in range(len(evaluated)):
        window = evaluated[max(0, i - 7): i + 1]
        wins   = sum(1 for r in window if r["outcome"] == "win")
        win_rate_series.append({
            "date":      evaluated[i]["pick_date"],
            "ticker":    evaluated[i]["ticker"],
            "win_rate":  round(wins / len(window), 3),
            "window":    len(window),
        })

    # ── Cumulative alpha vs SPY ───────────────────────────────────────────────
    alpha_series = []
    cum = 0.0
    for r in evaluated:
        alpha = r.get("alpha_14d") or r.get("alpha_7d") or 0.0
        cum   = round(cum + alpha, 2)
        alpha_series.append({
            "date":           r["pick_date"],
            "ticker":         r["ticker"],
            "alpha":          r.get("alpha_14d") or r.get("alpha_7d"),
            "cumulative":     cum,
            "outcome":        r["outcome"],
        })

    # ── Summary stats ─────────────────────────────────────────────────────────
    wins   = [r for r in evaluated if r["outcome"] == "win"]
    losses = [r for r in evaluated if r["outcome"] == "loss"]

    def _avg(vals):
        vals = [v for v in vals if v is not None]
        return round(sum(vals) / len(vals), 2) if vals else None

    overall_win_rate = round(len(wins) / len(evaluated), 3) if evaluated else None
    rolling_8w       = win_rate_series[-1]["win_rate"] if win_rate_series else None

    return {
        "win_rate_series": win_rate_series,
        "alpha_series":    alpha_series,
        "summary": {
            "total_evaluated":  len(evaluated),
            "total_pending":    len(rows) - len(evaluated),
            "overall_win_rate": overall_win_rate,
            "rolling_8pick_win_rate": rolling_8w,
            "total_alpha":      cum,
            "avg_alpha_14d":    _avg([r.get("alpha_14d") for r in evaluated]),
            "wins":             len(wins),
            "losses":           len(losses),
        },
    }


# ── Weekly attribution snapshot ───────────────────────────────────────────────

async def compute_weekly_attribution() -> dict:
    """
    Compute this week's attribution snapshot and upsert into performance_attribution.
    Called by the Sunday scheduler job.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Load all evaluated outcomes
        async with db.execute(
            """SELECT
                 se.pick_date, se.ticker, se.confidence_score, se.tier,
                 se.signal_type, se.regime,
                 so.alpha_14d, so.alpha_7d, so.return_14d, so.return_7d, so.outcome
               FROM signal_events se
               JOIN signal_outcomes so ON so.signal_event_id = se.id
               WHERE so.outcome IS NOT NULL
               ORDER BY se.pick_date ASC"""
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]

    if not rows:
        return {"status": "no_data"}

    # This week's picks (last 7 calendar days)
    cutoff = (date.today() - timedelta(days=7)).isoformat()
    week_rows = [r for r in rows if r["pick_date"] >= cutoff]

    def _alpha(r):
        return r.get("alpha_14d") or r.get("alpha_7d") or 0.0

    def _avg(vals):
        vals = [v for v in vals if v is not None]
        return round(sum(vals) / len(vals), 2) if vals else None

    def _regime_stats(subset):
        out = {}
        for regime in ("BULL", "BEAR", "CHOP"):
            rs = [r for r in subset if r.get("regime") == regime]
            if rs:
                w = [r for r in rs if r["outcome"] == "win"]
                out[regime] = {
                    "count":       len(rs),
                    "win_rate":    round(len(w) / len(rs), 3),
                    "avg_alpha":   _avg([_alpha(r) for r in rs]),
                }
        return out

    def _tier_stats(subset):
        out = {}
        for tier in ("Stock of the Day", "Watchlist Candidate", "Best Available"):
            ts = [r for r in subset if r.get("tier") == tier]
            if ts:
                w = [r for r in ts if r["outcome"] == "win"]
                out[tier] = {
                    "count":     len(ts),
                    "win_rate":  round(len(w) / len(ts), 3),
                    "avg_alpha": _avg([_alpha(r) for r in ts]),
                }
        return out

    wins_week   = [r for r in week_rows if r["outcome"] == "win"]
    week_start  = cutoff

    # Rolling 8-pick win rate (last 8 evaluated regardless of date)
    last8       = rows[-8:]
    wins_8      = [r for r in last8 if r["outcome"] == "win"]
    rolling_8   = round(len(wins_8) / len(last8), 3) if last8 else None

    # Cumulative alpha
    cum_alpha   = round(sum(_alpha(r) for r in rows), 2)

    record = {
        "week_start":          week_start,
        "picks_count":         len(week_rows),
        "wins":                len(wins_week),
        "losses":              len([r for r in week_rows if r["outcome"] == "loss"]),
        "win_rate":            round(len(wins_week) / len(week_rows), 3) if week_rows else None,
        "avg_alpha_14d":       _avg([_alpha(r) for r in week_rows]),
        "cumulative_alpha":    cum_alpha,
        "by_regime_json":      json.dumps(_regime_stats(rows)),
        "by_tier_json":        json.dumps(_tier_stats(rows)),
        "rolling_8w_win_rate": rolling_8,
    }

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT OR REPLACE INTO performance_attribution
               (week_start, picks_count, wins, losses, win_rate, avg_alpha_14d,
                cumulative_alpha, by_regime_json, by_tier_json, rolling_8w_win_rate, computed_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                record["week_start"], record["picks_count"], record["wins"],
                record["losses"],     record["win_rate"],    record["avg_alpha_14d"],
                record["cumulative_alpha"], record["by_regime_json"], record["by_tier_json"],
                record["rolling_8w_win_rate"], datetime.now(UTC).isoformat(),
            ),
        )
        await db.commit()

    logger.info("Weekly attribution computed: win_rate=%.3f rolling_8=%s",
                record["win_rate"] or 0, rolling_8)
    return {**record, "by_regime": json.loads(record["by_regime_json"]),
            "by_tier": json.loads(record["by_tier_json"])}


# ── Auto-generate correction proposals ───────────────────────────────────────

async def auto_generate_proposals() -> list[dict]:
    """
    Analyze pick history for drift patterns and write correction_proposals when
    the system is consistently underperforming in a detectable way.

    Rules (each generates at most one pending proposal):
      A) Rolling 8-pick win rate < 40%  → propose raising conviction threshold by 5
      B) CHOP-regime win rate < 30% (≥5 picks) → propose disabling CHOP picks
      C) Watchlist Candidate win rate < 25% (≥4 picks) → propose raising watchlist bar
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        async with db.execute(
            """SELECT
                 se.pick_date, se.tier, se.regime, se.confidence_score,
                 so.alpha_14d, so.alpha_7d, so.outcome
               FROM signal_events se
               JOIN signal_outcomes so ON so.signal_event_id = se.id
               WHERE so.outcome IS NOT NULL
               ORDER BY se.pick_date ASC"""
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]

        # Current pending proposals (avoid duplicates)
        async with db.execute(
            "SELECT trigger_reason FROM correction_proposals WHERE status = 'pending'"
        ) as cur:
            pending_triggers = {r[0] for r in await cur.fetchall()}

        # Current conviction threshold
        async with db.execute(
            "SELECT value FROM agent_config WHERE key = 'sotd_conviction_threshold'"
        ) as cur:
            row = await cur.fetchone()
            current_threshold = int(row[0]) if row else 65

    if len(rows) < 8:
        return []  # Not enough history to draw conclusions

    def _alpha(r):
        return r.get("alpha_14d") or r.get("alpha_7d") or 0.0

    proposals_created = []

    # Rule A: Low rolling 8-pick win rate
    last8      = rows[-8:]
    wins_8     = [r for r in last8 if r["outcome"] == "win"]
    rolling_wr = len(wins_8) / len(last8)

    if rolling_wr < 0.40 and "low_rolling_win_rate" not in pending_triggers:
        proposal = await _write_proposal(
            trigger_reason="low_rolling_win_rate",
            description=(
                f"Rolling 8-pick win rate is {rolling_wr:.0%} — below the 40% floor. "
                f"The system is not outperforming SPY by >2% consistently enough."
            ),
            metric_snapshot={
                "rolling_8_win_rate":  round(rolling_wr, 3),
                "picks_evaluated":     len(rows),
                "last_8_picks":        [r["pick_date"] for r in last8],
            },
            proposed_changes={
                "sotd_conviction_threshold": {
                    "from": current_threshold,
                    "to":   current_threshold + 5,
                    "rationale": f"Raise entry bar by 5 points to filter weaker setups. Current: {current_threshold}",
                }
            },
            current_values={"sotd_conviction_threshold": current_threshold},
        )
        proposals_created.append(proposal)

    # Rule B: CHOP regime consistently loses
    chop_rows = [r for r in rows if r.get("regime") == "CHOP"]
    if len(chop_rows) >= 5:
        chop_wins = [r for r in chop_rows if r["outcome"] == "win"]
        chop_wr   = len(chop_wins) / len(chop_rows)
        if chop_wr < 0.30 and "chop_regime_low_win_rate" not in pending_triggers:
            proposal = await _write_proposal(
                trigger_reason="chop_regime_low_win_rate",
                description=(
                    f"CHOP-regime picks win rate is {chop_wr:.0%} across {len(chop_rows)} picks. "
                    f"Momentum setups in sideways markets are generating consistent losses."
                ),
                metric_snapshot={
                    "chop_win_rate":    round(chop_wr, 3),
                    "chop_picks_count": len(chop_rows),
                    "avg_alpha_chop":   round(sum(_alpha(r) for r in chop_rows) / len(chop_rows), 2),
                },
                proposed_changes={
                    "skip_picks_in_chop": {
                        "from": False,
                        "to":   True,
                        "rationale": "Pause SOTD picks when regime = CHOP. Resume in BULL/BEAR.",
                    }
                },
                current_values={"skip_picks_in_chop": False},
            )
            proposals_created.append(proposal)

    # Rule C: Watchlist tier consistently underperforms
    wl_rows = [r for r in rows if r.get("tier") in ("Watchlist Candidate", "Best Available")]
    if len(wl_rows) >= 4:
        wl_wins = [r for r in wl_rows if r["outcome"] == "win"]
        wl_wr   = len(wl_wins) / len(wl_rows)
        if wl_wr < 0.25 and "watchlist_low_win_rate" not in pending_triggers:
            proposal = await _write_proposal(
                trigger_reason="watchlist_low_win_rate",
                description=(
                    f"Watchlist / Best-Available picks win rate is {wl_wr:.0%} across {len(wl_rows)} picks. "
                    f"Below-threshold picks are generating losses without meaningful upside."
                ),
                metric_snapshot={
                    "watchlist_win_rate":    round(wl_wr, 3),
                    "watchlist_picks_count": len(wl_rows),
                },
                proposed_changes={
                    "suppress_watchlist_alerts": {
                        "from": False,
                        "to":   True,
                        "rationale": "Stop surfacing Watchlist / Best-Available picks. SOTD-tier only.",
                    }
                },
                current_values={"suppress_watchlist_alerts": False},
            )
            proposals_created.append(proposal)

    return proposals_created


async def _write_proposal(
    trigger_reason: str,
    description: str,
    metric_snapshot: dict,
    proposed_changes: dict,
    current_values: dict,
) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO correction_proposals
               (status, trigger_reason, metric_snapshot_json, proposed_changes_json,
                current_values_json, generated_at)
               VALUES ('pending', ?, ?, ?, ?, ?)""",
            (
                description,
                json.dumps(metric_snapshot),
                json.dumps(proposed_changes),
                json.dumps(current_values),
                datetime.now(UTC).isoformat(),
            ),
        )
        await db.commit()
        async with db.execute(
            "SELECT id FROM correction_proposals ORDER BY id DESC LIMIT 1"
        ) as cur:
            row = await cur.fetchone()
            proposal_id = row[0] if row else None

    logger.info("Correction proposal created: id=%s trigger=%s", proposal_id, trigger_reason)
    return {"id": proposal_id, "trigger_reason": trigger_reason, "description": description}


# ── Proposal CRUD ─────────────────────────────────────────────────────────────

async def get_correction_proposals(status: str = "all") -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if status == "all":
            async with db.execute(
                "SELECT * FROM correction_proposals ORDER BY generated_at DESC"
            ) as cur:
                rows = [dict(r) for r in await cur.fetchall()]
        else:
            async with db.execute(
                "SELECT * FROM correction_proposals WHERE status = ? ORDER BY generated_at DESC",
                (status,),
            ) as cur:
                rows = [dict(r) for r in await cur.fetchall()]

    for r in rows:
        for field in ("metric_snapshot_json", "proposed_changes_json", "current_values_json"):
            try:
                r[field.replace("_json", "")] = json.loads(r[field] or "{}")
            except Exception:
                r[field.replace("_json", "")] = {}
    return rows


async def apply_correction_proposal(proposal_id: int) -> dict:
    """
    Mark a proposal as approved and apply the proposed config changes to agent_config.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM correction_proposals WHERE id = ?", (proposal_id,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return {"error": "Proposal not found"}
        if dict(row)["status"] != "pending":
            return {"error": f"Proposal is already {dict(row)['status']}"}

        changes = json.loads(dict(row)["proposed_changes_json"] or "{}")

        # Apply changes that map to agent_config keys
        config_keys = {"sotd_conviction_threshold"}
        for key, change in changes.items():
            if key in config_keys:
                new_val = str(change["to"])
                await db.execute(
                    "UPDATE agent_config SET value = ?, updated_at = ? WHERE key = ?",
                    (new_val, datetime.now(UTC).isoformat(), key),
                )
                logger.info("Config updated by proposal %d: %s = %s", proposal_id, key, new_val)

        await db.execute(
            "UPDATE correction_proposals SET status = 'approved', resolved_at = ?, resolution = 'Changes applied' WHERE id = ?",
            (datetime.now(UTC).isoformat(), proposal_id),
        )
        await db.commit()

    return {"status": "approved", "changes_applied": list(changes.keys())}


async def reject_correction_proposal(proposal_id: int, reason: str = "") -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE correction_proposals SET status = 'rejected', resolved_at = ?, resolution = ? WHERE id = ?",
            (datetime.now(UTC).isoformat(), reason or "Rejected by user", proposal_id),
        )
        await db.commit()
    return {"status": "rejected", "id": proposal_id}
