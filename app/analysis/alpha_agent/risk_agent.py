"""
Risk Agent — reads all rules from alpha_agent_config, applies VIX regime gate,
sizes the position using conviction-weighted 2% rule, sets stops and targets.
"""

import os, json, logging
import aiosqlite
import anthropic
from app.config import DB_PATH
from app.analysis.alpha_agent import cost_tracker

log = logging.getLogger(__name__)
MODEL = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")

# VIX regime thresholds
REGIMES = [
    (35, "CRISIS"),
    (25, "CAUTION"),
    (15, "NORMAL"),
    (0,  "BULL"),
]


async def _load_config() -> dict:
    """Load all alpha_agent_config keys into a dict."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT key, value FROM alpha_agent_config") as cur:
            rows = await cur.fetchall()
    return {k: v for k, v in rows}


async def _get_vix() -> float:
    """Get the latest VIX reading from vix_history, default 20 (NORMAL) if unavailable."""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT vix FROM vix_history ORDER BY date DESC LIMIT 1"
            ) as cur:
                row = await cur.fetchone()
        return float(row[0]) if row else 20.0
    except Exception:
        return 20.0


def _determine_regime(vix: float) -> str:
    for threshold, name in REGIMES:
        if vix > threshold:
            return name
    return "BULL"


def _regime_rules(regime: str, cfg: dict) -> dict:
    """Return the stop % and max deployment % for the current regime."""
    prefix = regime.lower()
    return {
        "max_deployed_pct": float(cfg.get(f"{prefix}_max_deployed_pct",
                                          cfg.get("max_deployed_pct", "60"))),
        "hard_stop_pct":    float(cfg.get(f"{prefix}_hard_stop_pct",
                                          cfg.get("hard_stop_pct", "8"))),
    }


async def _get_current_deployed_pct(portfolio_value: float, current_cash: float) -> float:
    if portfolio_value <= 0:
        return 0.0
    return round((portfolio_value - current_cash) / portfolio_value * 100, 1)


async def run(
    ticker: str,
    research: dict,
    bull: dict,
    bear: dict,
    portfolio_value: float = 10000.0,
    current_cash: float = 10000.0,
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

    await _emit(f"Loading risk rules and market regime for {ticker}…")

    cfg     = await _load_config()
    vix     = await _get_vix()
    regime  = _determine_regime(vix)

    # Only apply regime gate if enabled
    if cfg.get("regime_gate_enabled", "1") == "1":
        rules = _regime_rules(regime, cfg)
    else:
        rules = {
            "max_deployed_pct": float(cfg.get("max_deployed_pct", "60")),
            "hard_stop_pct":    float(cfg.get("hard_stop_pct", "8")),
        }

    # Portfolio-level checks
    deployed_pct   = await _get_current_deployed_pct(portfolio_value, current_cash)
    max_deployed   = rules["max_deployed_pct"]
    hard_stop      = rules["hard_stop_pct"]
    cash_floor_pct = float(cfg.get("cash_floor_pct", "25"))
    min_pos        = float(cfg.get("min_position_pct", "3"))
    med_pos        = float(cfg.get("med_position_pct", "7"))
    max_pos        = float(cfg.get("max_position_pct", "12"))
    take_profit    = float(cfg.get("default_take_profit_pct", "18"))
    time_stop      = int(cfg.get("time_stop_days", "21"))

    # CRISIS regime: no new trades
    if regime == "CRISIS":
        await _emit("CRISIS regime (VIX > 35) — no new positions. Holding cash.", confidence=0)
        return {
            "ticker": ticker, "recommended_action": "PASS",
            "position_size_pct": 0, "position_size_usd": 0, "shares": 0,
            "entry_price": 0, "stop_price": 0, "stop_pct": -hard_stop,
            "target_price": 0, "target_pct": take_profit, "time_stop_days": time_stop,
            "risk_reward_ratio": 0, "max_loss_usd": 0, "portfolio_impact_pct": 0,
            "regime": regime, "vix": vix,
            "sizing_rationale": f"CRISIS regime (VIX {vix:.1f}) — no new positions until VIX drops below 35.",
        }

    # Already at max deployment
    if deployed_pct >= max_deployed:
        await _emit(f"Already at max deployment ({deployed_pct:.0f}% ≥ {max_deployed:.0f}%) — PASS.", confidence=0)
        return {
            "ticker": ticker, "recommended_action": "PASS",
            "position_size_pct": 0, "position_size_usd": 0, "shares": 0,
            "entry_price": 0, "stop_price": 0, "stop_pct": -hard_stop,
            "target_price": 0, "target_pct": take_profit, "time_stop_days": time_stop,
            "risk_reward_ratio": 0, "max_loss_usd": 0, "portfolio_impact_pct": 0,
            "regime": regime, "vix": vix,
            "sizing_rationale": f"Portfolio already {deployed_pct:.0f}% deployed (limit {max_deployed:.0f}% in {regime} regime).",
        }

    prices      = research.get("_raw", {}).get("yfinance", {}).get("prices", {})
    current_px  = prices.get("current_price", 0)
    bull_conf   = bull.get("confidence", 50)
    bear_conf   = bear.get("confidence", 50)

    await _emit(f"Regime: {regime} (VIX {vix:.1f}) | Stop: -{hard_stop}% | Max deployed: {max_deployed}%")

    prompt = f"""You are the Risk Agent for an AI portfolio manager.

MARKET REGIME: {regime} (VIX: {vix:.1f})
PORTFOLIO STATE:
- Total value: ${portfolio_value:,.2f}
- Available cash: ${current_cash:,.2f}
- Currently deployed: {deployed_pct:.1f}% (limit: {max_deployed:.0f}%)
- Open positions: {len(open_positions)}
- Cash floor: {cash_floor_pct:.0f}% must remain in cash always

CONVICTION SIGNALS:
- Bull confidence: {bull_conf}/100
- Bear confidence: {bear_conf}/100
- Bull expected return: {bull.get('expected_return_pct', 0)}%
- Bear downside: {bear.get('downside_scenario', 'Unknown')}

RISK RULES FOR {regime} REGIME:
- Hard stop: -{hard_stop}% from entry (absolute maximum)
- Position sizing by conviction:
  * Low (bull_conf < 60):    {min_pos}% of portfolio
  * Medium (bull_conf 60-75): {med_pos}% of portfolio
  * High (bull_conf > 75):   {max_pos}% of portfolio
- Cash floor: {cash_floor_pct}% must always remain
- If bear_conf > 70: reduce chosen size by 30%
- Risk/reward must be ≥ 1.5:1 to proceed
- 2% portfolio risk rule: size so that stop-hit = max 2% portfolio loss

Current price of {ticker}: ${current_px:.2f}

Return JSON only:
{{
  "ticker": "{ticker}",
  "recommended_action": "BUY|SHORT|PASS",
  "position_size_pct": number,
  "position_size_usd": number,
  "shares": number,
  "entry_price": {current_px:.2f},
  "stop_price": number,
  "stop_pct": negative number,
  "target_price": number,
  "target_pct": positive number,
  "time_stop_days": {time_stop},
  "risk_reward_ratio": number,
  "max_loss_usd": number,
  "portfolio_impact_pct": number,
  "regime": "{regime}",
  "vix": {vix:.1f},
  "sizing_rationale": "one sentence"
}}"""

    client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
    try:
        response = await client.messages.create(
            model=MODEL, max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text.strip()
        await cost_tracker.log_call("risk", MODEL,
                                    response.usage.input_tokens,
                                    response.usage.output_tokens, run_id)
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        result = json.loads(text)
    except Exception as e:
        log.warning("risk_agent LLM failed: %s", e)
        result = {
            "ticker": ticker, "recommended_action": "PASS",
            "position_size_pct": 0, "position_size_usd": 0, "shares": 0,
            "entry_price": current_px, "stop_price": 0, "stop_pct": -hard_stop,
            "target_price": 0, "target_pct": take_profit, "time_stop_days": time_stop,
            "risk_reward_ratio": 0, "max_loss_usd": 0, "portfolio_impact_pct": 0,
            "regime": regime, "vix": vix,
            "sizing_rationale": "Risk analysis failed — defaulting to PASS",
        }

    await _emit(
        f"Risk plan: {result.get('recommended_action')} {ticker} @ "
        f"{result.get('position_size_pct', 0):.0f}% | "
        f"Stop -{abs(result.get('stop_pct', hard_stop)):.1f}% | "
        f"R/R {result.get('risk_reward_ratio', 0):.1f}:1"
    )
    return result
