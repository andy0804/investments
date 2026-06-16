"""
Risk Agent — Phase 4 rewrite.

Changes from Phase 1-3:
  - Dynamic position sizing replaces static 3/7/12% conviction tiers.
    Size = Kelly half-fraction of expected alpha / stop, adjusted for:
    conviction, bear penalty, regime multiplier, correlation to existing positions.
  - New regime taxonomy from macro_intelligence (EVENT_DRIVEN/RISK_ON/NORMAL/RISK_OFF/CRISIS)
    drives deployment limits. EVENT_DRIVEN allows the highest deployment (75%).
  - Correlation gate: checks existing open positions' alpha_source + theme via
    alpha_agent_predictions. If thesis exposure >= 25% → no new position.
  - Full sizing breakdown returned for Zone 3 UI display.
"""

import os, json, logging
import aiosqlite
import anthropic
from app.config import DB_PATH
from app.analysis.alpha_agent import cost_tracker

log = logging.getLogger(__name__)
MODEL = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")

# New Phase 1 regime taxonomy → deployment limits
MACRO_REGIME_LIMITS = {
    "EVENT_DRIVEN": {"max_deployed_pct": 75.0, "size_multiplier": 1.2},
    "RISK_ON":      {"max_deployed_pct": 70.0, "size_multiplier": 1.0},
    "NORMAL":       {"max_deployed_pct": 60.0, "size_multiplier": 0.9},
    "RISK_OFF":     {"max_deployed_pct": 35.0, "size_multiplier": 0.6},
    "CRISIS":       {"max_deployed_pct": 10.0, "size_multiplier": 0.0},
}

# VIX-based stop tightening (unchanged from Phase 1)
VIX_STOP_RULES = [
    (35, "CRISIS",  5.0),
    (25, "CAUTION", 6.0),
    (15, "NORMAL",  8.0),
    (0,  "BULL",   10.0),
]

THESIS_EXPOSURE_CAP = 25.0   # % of portfolio in same thesis → block
THESIS_EXPOSURE_REDUCE = 15.0  # % → reduce size by 40%
MIN_ALPHA_FOR_KELLY = 0.5    # % — below this Kelly gives unreliably small sizes


async def _load_config() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT key, value FROM alpha_agent_config") as cur:
            rows = await cur.fetchall()
    return {k: v for k, v in rows}


async def _get_vix() -> float:
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT value FROM vix_history ORDER BY date DESC LIMIT 1"
            ) as cur:
                row = await cur.fetchone()
            if not row:
                async with db.execute(
                    "SELECT vix FROM vix_history ORDER BY date DESC LIMIT 1"
                ) as cur:
                    row = await cur.fetchone()
        return float(row[0]) if row else 20.0
    except Exception:
        return 20.0


async def _get_macro_regime() -> str:
    """Gets the Phase 1 macro regime from the latest market narrative."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT regime FROM alpha_agent_market_narrative ORDER BY scan_at DESC LIMIT 1"
            ) as cur:
                row = await cur.fetchone()
        return row[0] if row and row[0] else "NORMAL"
    except Exception:
        return "NORMAL"


def _vix_stop(vix: float) -> tuple[str, float]:
    """Returns (vix_regime, hard_stop_pct) based on VIX."""
    for threshold, name, stop in VIX_STOP_RULES:
        if vix > threshold:
            return name, stop
    return "BULL", 10.0


async def _get_thesis_exposure(
    open_positions: list[dict],
    new_alpha_source: str,
    new_theme: str,
) -> tuple[float, list[str]]:
    """
    Checks how much portfolio % is already in the same macro thesis.
    Returns (thesis_exposure_pct, list_of_tickers_in_same_thesis).
    """
    if not open_positions or not new_alpha_source:
        return 0.0, []

    # Fetch prediction records for open positions
    pos_ids = [p["id"] for p in open_positions if p.get("id")]
    if not pos_ids:
        return 0.0, []

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        placeholders = ",".join("?" * len(pos_ids))
        async with db.execute(
            f"SELECT position_id, alpha_source, theme_at_entry FROM alpha_agent_predictions "
            f"WHERE position_id IN ({placeholders})",
            pos_ids,
        ) as cur:
            pred_rows = {r["position_id"]: dict(r) for r in await cur.fetchall()}

    matching_tickers = []
    thesis_exposure  = 0.0

    for pos in open_positions:
        pred = pred_rows.get(pos["id"])
        if not pred:
            continue
        # Match on same alpha_source (not exact theme — themes vary in wording)
        same_thesis = pred.get("alpha_source") == new_alpha_source
        if same_thesis:
            matching_tickers.append(pos["ticker"])
            thesis_exposure += float(pos.get("size_pct", 0))

    return round(thesis_exposure, 1), matching_tickers


def _compute_dynamic_size(
    expected_alpha: float,
    bull_conf: float,
    bear_conf: float,
    hard_stop: float,
    regime_mult: float,
    thesis_exposure: float,
    min_pos: float,
    max_pos: float,
    has_sufficient_evidence: bool,
) -> tuple[float, dict]:
    """
    Kelly half-fraction with adjustments.
    Returns (final_size_pct, breakdown_dict).
    """
    # Kelly half-fraction: F/2 = (edge / hard_stop) / 2
    alpha_for_kelly = max(expected_alpha, MIN_ALPHA_FOR_KELLY)
    kelly_full = alpha_for_kelly / hard_stop      # raw Kelly fraction (0-∞)
    kelly_half = kelly_full / 2.0                 # half-Kelly (more conservative)
    kelly_pct  = min(kelly_half * 100, max_pos)   # as portfolio %

    # Conviction adjustment
    if bull_conf >= 75:
        conviction_mult = 1.2
    elif bull_conf >= 60:
        conviction_mult = 1.0
    else:
        conviction_mult = 0.75

    # Bear penalty
    bear_mult = 0.70 if bear_conf > 70 else 1.0

    # Insufficient evidence penalty
    evidence_mult = 0.75 if not has_sufficient_evidence else 1.0

    # Composite
    adjusted = kelly_pct * conviction_mult * bear_mult * regime_mult * evidence_mult

    # Correlation gate
    corr_note = ""
    if thesis_exposure >= THESIS_EXPOSURE_CAP:
        adjusted = 0.0
        corr_note = f"Thesis exposure {thesis_exposure:.0f}% ≥ {THESIS_EXPOSURE_CAP:.0f}% cap → blocked"
    elif thesis_exposure > THESIS_EXPOSURE_REDUCE:
        adjusted *= 0.6
        corr_note = f"Thesis exposure {thesis_exposure:.0f}% > {THESIS_EXPOSURE_REDUCE:.0f}% → reduced 40%"

    final = round(max(min_pos, min(adjusted, max_pos)) if adjusted > 0 else 0.0, 1)

    breakdown = {
        "kelly_base_pct":    round(kelly_pct, 1),
        "conviction_mult":   conviction_mult,
        "bear_mult":         bear_mult,
        "regime_mult":       regime_mult,
        "evidence_mult":     evidence_mult,
        "thesis_exposure":   thesis_exposure,
        "correlation_note":  corr_note,
        "final_pct":         final,
    }
    return final, breakdown


async def run(
    ticker: str,
    research: dict,
    bull: dict,
    bear: dict,
    portfolio_value: float = 10000.0,
    current_cash: float   = 10000.0,
    open_positions: list[dict] = [],
    run_id: int | None = None,
    emit=None,
) -> dict:
    async def _emit(msg, confidence=None):
        if emit:
            try:
                await emit({"stage": "risk", "status": "running",
                            "message": msg, "confidence": confidence})
            except Exception:
                pass

    await _emit(f"Loading risk rules and sizing for {ticker}…")

    cfg          = await _load_config()
    vix          = await _get_vix()
    vix_regime, hard_stop = _vix_stop(vix)
    macro_regime = await _get_macro_regime()

    # Deployment limits from Phase 1 macro regime
    regime_limits = MACRO_REGIME_LIMITS.get(macro_regime, MACRO_REGIME_LIMITS["NORMAL"])
    max_deployed  = regime_limits["max_deployed_pct"]
    regime_mult   = regime_limits["size_multiplier"]

    # Cash floor and position bounds from config
    cash_floor_pct = float(cfg.get("cash_floor_pct",  "25"))
    min_pos        = float(cfg.get("min_position_pct", "3"))
    max_pos        = float(cfg.get("max_position_pct", "12"))
    take_profit    = float(cfg.get("default_take_profit_pct", "18"))
    time_stop      = int(cfg.get("time_stop_days", "21"))

    # Current deployment
    deployed_pct = round((portfolio_value - current_cash) / portfolio_value * 100, 1) if portfolio_value > 0 else 0.0

    # CRISIS: no new trades
    if macro_regime == "CRISIS" or vix_regime == "CRISIS":
        msg = f"CRISIS regime (VIX {vix:.1f} / macro {macro_regime}) — preserving cash, no new positions"
        await _emit(msg, confidence=0)
        return _pass_result(ticker, hard_stop, take_profit, time_stop, vix, macro_regime, msg)

    # Max deployment check
    if deployed_pct >= max_deployed:
        msg = f"Max deployment reached: {deployed_pct:.0f}% ≥ {max_deployed:.0f}% ({macro_regime} regime)"
        await _emit(msg, confidence=0)
        return _pass_result(ticker, hard_stop, take_profit, time_stop, vix, macro_regime, msg)

    # Thesis correlation check
    bull_alpha_source = bull.get("alpha_source", "")
    bull_theme        = bull.get("theme", "")
    thesis_exposure, thesis_tickers = await _get_thesis_exposure(
        open_positions, bull_alpha_source, bull_theme
    )

    bull_conf    = float(bull.get("confidence", 50))
    bear_conf    = float(bear.get("confidence", 50))
    expected_alpha = float(bull.get("expected_alpha_pct", 0) or
                           bull.get("expected_return_pct", 0) or 3.0)
    has_evidence = bool(bull.get("historical_observations", 0) or 0 >= 10)

    await _emit(
        f"Regime: {macro_regime} (VIX {vix:.1f}, {vix_regime}) | "
        f"Stop: -{hard_stop}% | Max deployed: {max_deployed}% | "
        f"Thesis exposure: {thesis_exposure:.0f}%"
    )

    # Dynamic position size
    final_pct, sizing_breakdown = _compute_dynamic_size(
        expected_alpha   = expected_alpha,
        bull_conf        = bull_conf,
        bear_conf        = bear_conf,
        hard_stop        = hard_stop,
        regime_mult      = regime_mult,
        thesis_exposure  = thesis_exposure,
        min_pos          = min_pos,
        max_pos          = max_pos,
        has_sufficient_evidence = has_evidence,
    )

    # Correlation gate blocked
    if final_pct == 0.0 and thesis_exposure >= THESIS_EXPOSURE_CAP:
        msg = f"Correlation gate: {thesis_exposure:.0f}% already in {bull_alpha_source} thesis (cap {THESIS_EXPOSURE_CAP:.0f}%)"
        await _emit(msg, confidence=0)
        return _pass_result(ticker, hard_stop, take_profit, time_stop, vix, macro_regime, msg,
                            sizing_breakdown=sizing_breakdown)

    prices     = research.get("_raw", {}).get("yfinance", {}).get("prices", {})
    current_px = float(prices.get("current_price", 0) or 0)

    position_usd = portfolio_value * final_pct / 100
    shares       = position_usd / current_px if current_px > 0 else 0
    stop_price   = round(current_px * (1 - hard_stop / 100), 2)
    target_price = round(current_px * (1 + take_profit / 100), 2)
    max_loss_usd = round(position_usd * hard_stop / 100, 2)
    rr_ratio     = round(take_profit / hard_stop, 2)

    sizing_rationale = (
        f"Kelly {sizing_breakdown['kelly_base_pct']:.1f}% base × "
        f"conviction {sizing_breakdown['conviction_mult']:.1f}× × "
        f"regime({macro_regime}) {sizing_breakdown['regime_mult']:.1f}× = {final_pct:.1f}% | "
        f"Stop -{hard_stop}% | R/R {rr_ratio:.1f}:1"
    )

    await _emit(
        f"Size: {final_pct:.1f}% (${position_usd:,.0f}) | "
        f"Stop ${stop_price:.2f} | Target ${target_price:.2f} | R/R {rr_ratio:.1f}:1",
        confidence=int(bull_conf),
    )

    return {
        "ticker":               ticker,
        "recommended_action":   "BUY" if final_pct > 0 else "PASS",
        "position_size_pct":    final_pct,
        "position_size_usd":    round(position_usd, 2),
        "shares":               round(shares, 4),
        "entry_price":          current_px,
        "stop_price":           stop_price,
        "stop_pct":             -hard_stop,
        "target_price":         target_price,
        "target_pct":           take_profit,
        "time_stop_days":       time_stop,
        "risk_reward_ratio":    rr_ratio,
        "max_loss_usd":         max_loss_usd,
        "portfolio_impact_pct": round(deployed_pct + final_pct, 1),
        "regime":               macro_regime,
        "vix_regime":           vix_regime,
        "vix":                  vix,
        "sizing_rationale":     sizing_rationale,
        # Phase 4 extras for Zone 3 UI
        "sizing_breakdown":     sizing_breakdown,
        "thesis_tickers":       thesis_tickers,
        "macro_regime_limits":  regime_limits,
        "deployed_pct":         deployed_pct,
        "max_deployed_pct":     max_deployed,
    }


def _pass_result(ticker, hard_stop, take_profit, time_stop, vix, regime, msg, sizing_breakdown=None):
    return {
        "ticker": ticker, "recommended_action": "PASS",
        "position_size_pct": 0, "position_size_usd": 0, "shares": 0,
        "entry_price": 0, "stop_price": 0, "stop_pct": -hard_stop,
        "target_price": 0, "target_pct": take_profit, "time_stop_days": time_stop,
        "risk_reward_ratio": 0, "max_loss_usd": 0, "portfolio_impact_pct": 0,
        "regime": regime, "vix": vix,
        "sizing_rationale": msg,
        "sizing_breakdown": sizing_breakdown or {},
        "thesis_tickers": [], "macro_regime_limits": {},
        "deployed_pct": 0, "max_deployed_pct": 0,
    }
