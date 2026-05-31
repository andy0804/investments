"""
ARIA — Adaptive Risk Intelligence Agent.
Analyzes the same ticker a user just traded and makes its own independent decision.
Checks open positions for exits every revaluation cycle.
"""

import asyncio
import json
import logging
import math
from datetime import datetime, UTC

import aiosqlite
import anthropic

from app.config import DB_PATH, ANTHROPIC_API_KEY, ANTHROPIC_MODEL_SONNET, ANTHROPIC_MODEL_HAIKU
from app.analysis.options_engine import (
    fetch_options_chain, get_expirations, bs_greeks, bs_price,
    simulate_fill, COMMISSION_PER_CONTRACT, MULTIPLIER, RISK_FREE_RATE,
    _dte_years, _dte,
)
from app.analysis.technicals import compute_technicals
from app.analysis.macro import get_macro_snapshot

log = logging.getLogger(__name__)
_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

# ARIA risk parameters
ARIA_MAX_POSITION_COST  = 500.0   # never risk more than $500 per trade
ARIA_PROFIT_TARGET_PCT  = 100.0   # retail investors let winners run — target 100% on risk
ARIA_STOP_LOSS_PCT      = -35.0   # default stop-loss
ARIA_MIN_DTE_TO_HOLD    = 7       # exit if DTE falls below this
ARIA_HIGH_IV_THRESHOLD  = 60      # prefer spreads when IV rank above this %
ARIA_MIN_HOLD_HOURS     = 48      # don't run Haiku exit check within first 48h of entry
ARIA_MIN_HAIKU_PROFIT   = 20.0    # skip Haiku exit if profitable but below this % (let winners grow)
ARIA_ENTRY_MIN_DTE      = 21      # target expiry DTE lower bound for independent entries
ARIA_ENTRY_MAX_DTE      = 50      # target expiry DTE upper bound for independent entries


# ── Account helpers ───────────────────────────────────────────────────────────

async def _ensure_aria_account(db: aiosqlite.Connection) -> dict:
    async with db.execute("SELECT * FROM aria_account WHERE id = 1") as cur:
        row = await cur.fetchone()
    if row is None:
        now = datetime.now(UTC).isoformat()
        await db.execute(
            "INSERT INTO aria_account (id, cash, initial_capital, realized_pnl, "
            "total_commissions, trade_count, win_count, created_at, updated_at) "
            "VALUES (1, 10000.0, 10000.0, 0.0, 0.0, 0, 0, ?, ?)", (now, now)
        )
        await db.commit()
        return {"id": 1, "cash": 10000.0, "initial_capital": 10000.0,
                "realized_pnl": 0.0, "total_commissions": 0.0,
                "trade_count": 0, "win_count": 0}
    cols = ["id", "cash", "initial_capital", "realized_pnl", "total_commissions",
            "trade_count", "win_count", "created_at", "updated_at"]
    return dict(zip(cols, row))


async def get_aria_account(db: aiosqlite.Connection) -> dict:
    acct = await _ensure_aria_account(db)
    async with db.execute(
        "SELECT COALESCE(SUM(unrealized_pnl), 0) FROM aria_positions WHERE status = 'OPEN'"
    ) as cur:
        (unreal,) = await cur.fetchone()
    acct["unrealized_pnl"] = round(float(unreal or 0), 2)
    acct["net_liq"] = round(acct["cash"] + acct["unrealized_pnl"], 2)
    acct["total_pnl"] = round(acct["realized_pnl"] + acct["unrealized_pnl"], 2)
    acct["total_return_pct"] = round(
        acct["total_pnl"] / acct["initial_capital"] * 100, 2
    ) if acct["initial_capital"] else 0.0
    acct["win_rate"] = round(
        acct["win_count"] / acct["trade_count"] * 100, 1
    ) if acct["trade_count"] > 0 else 0.0
    return acct


# ── Log cost to analysis_log ──────────────────────────────────────────────────

async def _log_cost(db, job_name, model, tokens_in, tokens_out):
    rates = {
        ANTHROPIC_MODEL_SONNET: {"input": 3.0, "output": 15.0},
        ANTHROPIC_MODEL_HAIKU:  {"input": 1.0, "output": 5.0},
    }
    r = rates.get(model, rates[ANTHROPIC_MODEL_HAIKU])
    cost = (tokens_in * r["input"] + tokens_out * r["output"]) / 1_000_000
    await db.execute(
        "INSERT INTO analysis_log (job_name, model, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,?,?)",
        (job_name, model, tokens_in, tokens_out, cost),
    )
    return cost, tokens_in, tokens_out


# ── Build context for Sonnet prompt ──────────────────────────────────────────

def _summarise_chain(calls, puts, S, top_n=5):
    """Return a compact chain summary for the Sonnet prompt."""
    def _atm_rows(contracts, is_call):
        ranked = sorted(contracts, key=lambda c: abs(c["strike"] - S))[:top_n]
        return [
            f"  Strike={c['strike']} {'CALL' if is_call else 'PUT'} bid={c.get('bid',0):.2f} "
            f"ask={c.get('ask',0):.2f} IV={c.get('iv',0):.1f}% delta={c.get('delta') or 0:.2f} "
            f"theta={c.get('theta') or 0:.3f} OI={c.get('openInterest',0)}"
            for c in ranked
        ]
    lines = [f"Underlying: ${S:.2f}", "--- ATM CALLS ---"]
    lines.extend(_atm_rows(calls, True))
    lines.append("--- ATM PUTS ---")
    lines.extend(_atm_rows(puts, False))
    return "\n".join(lines)


def _summarise_technicals(t):
    if not t:
        return "Technicals unavailable."
    return (
        f"RSI={t.get('rsi', 0):.1f} | MACD={'bullish' if t.get('macd_signal') == 'bullish' else 'bearish'} | "
        f"Above SMA50={'Yes' if t.get('above_sma_50') else 'No'} | "
        f"BB position={t.get('bb_position','unknown')} | Volume ratio={t.get('volume_ratio', 1):.2f}x"
    )


def _summarise_user_legs(user_legs):
    if not user_legs:
        return "Unknown"
    parts = []
    for leg in user_legs:
        parts.append(
            f"{leg.get('action','?')} {leg.get('quantity',1)}x "
            f"{leg.get('option_type','?').upper()} @ strike {leg.get('strike','?')}"
        )
    return " + ".join(parts)


# ── Main entry-point: analyze and trade ──────────────────────────────────────

async def analyze_and_trade(
    user_position_id: int,
    ticker: str,
    expiry: str,
    user_legs: list[dict],
    db: aiosqlite.Connection,
) -> dict:
    """
    ARIA analyzes the ticker and decides whether to trade and what to trade.
    Called as a background task immediately after the user opens a position.
    Returns a summary dict with ARIA's decision.
    """
    now = datetime.now(UTC).isoformat()
    acct = await _ensure_aria_account(db)

    # ── Gather context ────────────────────────────────────────────────────────
    try:
        chain = fetch_options_chain(ticker.upper(), expiry)
        S = chain["underlying"]
        dte = chain["dte"]
        expected_move = chain["expected_move"]
        chain_summary = _summarise_chain(chain["calls"], chain["puts"], S)
    except Exception as e:
        log.warning("ARIA: chain fetch failed for %s: %s", ticker, e)
        await _log_pass(db, user_position_id, ticker, now,
                        f"Could not fetch options chain: {e}", user_legs)
        return {"decision": "PASS", "reason": "chain_fetch_failed"}

    try:
        tech = await compute_technicals(ticker.upper())
    except Exception:
        tech = None

    try:
        macro = await get_macro_snapshot()
    except Exception:
        macro = {}

    user_summary = _summarise_user_legs(user_legs)
    tech_summary = _summarise_technicals(tech)
    macro_summary = (
        f"Regime={macro.get('regime','unknown')} VIX={macro.get('vix',0):.1f} "
        f"SPY 10d return={macro.get('spy_10d',0):.1f}%"
    ) if macro else "Macro data unavailable."

    max_qty = max(1, int(ARIA_MAX_POSITION_COST / (S * 0.03 * MULTIPLIER + COMMISSION_PER_CONTRACT)))
    max_qty = min(max_qty, 5)

    prompt = f"""You are ARIA, an expert options trader AI agent.
A human trader just opened this options position on {ticker}:
  {user_summary}
  Expiry: {expiry} ({dte} DTE)
  Account cash available: ${acct['cash']:.2f}

You must now decide whether to trade {ticker} yourself (same expiry, your own strategy).
You are NOT required to mirror the human's trade — you should make the best independent decision.

MARKET DATA:
{chain_summary}
Expected move: ±${expected_move:.2f}

TECHNICALS:
{tech_summary}

MACRO:
{macro_summary}

ARIA RISK RULES (you must follow these):
- Max cost per trade: ${ARIA_MAX_POSITION_COST:.0f}
- Max quantity per leg: {max_qty} contracts
- Prefer defined-risk strategies (spreads) when IV on ATM options > 35%
- Never buy options with < 14 DTE remaining
- If VIX > 28, reduce size and prefer spreads

Respond with ONLY valid JSON (no markdown, no explanation outside the JSON):
{{
  "decision": "TRADE" or "PASS",
  "pass_reason": "string if PASS, else null",
  "strategy_label": "e.g. Bull Call Spread / Long Call / Long Straddle",
  "legs": [
    {{"strike": number, "option_type": "call" or "put", "action": "BUY" or "SELL", "quantity": number}}
  ],
  "entry_thesis": "2-3 sentence explanation of WHY you are making this trade based on the data",
  "divergence_note": "1-2 sentences on how/why your trade differs from the human's (or confirm you agree)",
  "user_trade_rating": "Strong / Fair / Risky / Poor",
  "user_trade_comment": "1 sentence honest assessment of the human's trade",
  "confidence_score": integer 1-10,
  "exit_conditions": {{
    "profit_target_pct": number,
    "stop_loss_pct": number,
    "thesis_decay_signals": "brief description of what would invalidate the thesis"
  }}
}}"""

    # ── Call Sonnet ───────────────────────────────────────────────────────────
    try:
        resp = _client.messages.create(
            model=ANTHROPIC_MODEL_SONNET,
            max_tokens=700,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = resp.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        decision = json.loads(raw)
        cost, t_in, t_out = await _log_cost(
            db, "aria_entry", ANTHROPIC_MODEL_SONNET,
            resp.usage.input_tokens, resp.usage.output_tokens
        )
    except Exception as e:
        log.error("ARIA: Sonnet call failed: %s", e)
        await _log_pass(db, user_position_id, ticker, now,
                        f"Sonnet failed: {e}", user_legs)
        return {"decision": "PASS", "reason": "llm_error"}

    if decision.get("decision") != "TRADE":
        await _log_decision(
            db, None, user_position_id, ticker, "PASS", now,
            decision.get("pass_reason", "No trade"),
            user_summary, None, None, decision.get("confidence_score", 5),
            ANTHROPIC_MODEL_SONNET, t_in, t_out, cost,
        )
        await db.commit()
        log.info("ARIA: PASS on %s — %s", ticker, decision.get("pass_reason", ""))
        return {"decision": "PASS", "reason": decision.get("pass_reason")}

    # ── Validate and execute ARIA's legs ─────────────────────────────────────
    legs = decision.get("legs", [])
    if not legs:
        await _log_pass(db, user_position_id, ticker, now,
                        "LLM returned TRADE but no legs", user_legs)
        return {"decision": "PASS", "reason": "no_legs"}

    total_cost = 0.0
    total_commission = 0.0
    leg_details = []

    try:
        for leg_spec in legs:
            strike = float(leg_spec["strike"])
            is_call = leg_spec["option_type"].lower() == "call"
            action = leg_spec["action"].upper()
            quantity = min(int(leg_spec.get("quantity", 1)), max_qty)

            contracts = chain["calls"] if is_call else chain["puts"]
            match = next((c for c in contracts if abs(c["strike"] - strike) < 0.01), None)
            if match is None:
                match = min(contracts, key=lambda c: abs(c["strike"] - strike), default=None)
            if match is None:
                raise ValueError(f"No contract found near strike {strike}")

            fill = simulate_fill(match.get("bid"), match.get("ask"), action)
            if fill <= 0:
                raise ValueError(f"Zero fill for strike {strike}")

            commission = COMMISSION_PER_CONTRACT * quantity
            leg_cost = fill * MULTIPLIER * quantity if action == "BUY" else -fill * MULTIPLIER * quantity
            leg_cost += commission
            total_cost += leg_cost
            total_commission += commission

            T = _dte_years(expiry)
            iv = (match.get("iv") or 30.0) / 100.0
            greeks = bs_greeks(S, strike, T, RISK_FREE_RATE, iv, is_call)
            leg_details.append({
                "strike": strike, "option_type": leg_spec["option_type"].lower(),
                "action": action, "quantity": quantity,
                "fill_price": fill, "commission": commission, "leg_cost": leg_cost,
                "iv_pct": match.get("iv"), "greeks": greeks,
            })
    except Exception as e:
        log.warning("ARIA: leg execution failed: %s", e)
        await _log_pass(db, user_position_id, ticker, now,
                        f"Leg execution error: {e}", user_legs)
        return {"decision": "PASS", "reason": f"execution_error: {e}"}

    if total_cost > acct["cash"]:
        log.warning("ARIA: insufficient cash (need %.2f have %.2f)", total_cost, acct["cash"])
        await _log_pass(db, user_position_id, ticker, now,
                        f"Insufficient cash ${acct['cash']:.2f}", user_legs)
        return {"decision": "PASS", "reason": "insufficient_cash"}

    # ── Write to DB ───────────────────────────────────────────────────────────
    new_cash = acct["cash"] - total_cost
    await db.execute(
        "UPDATE aria_account SET cash = ?, total_commissions = total_commissions + ?, "
        "trade_count = trade_count + 1, updated_at = ? WHERE id = 1",
        (new_cash, total_commission, now),
    )

    exit_json = json.dumps(decision.get("exit_conditions", {
        "profit_target_pct": ARIA_PROFIT_TARGET_PCT,
        "stop_loss_pct": ARIA_STOP_LOSS_PCT,
        "thesis_decay_signals": "Major trend reversal",
    }))

    first = leg_details[0]
    strategy = decision.get("strategy_label", "ARIA Trade")
    if len(leg_details) > 1:
        strikes_str = "+".join(str(l["strike"]) for l in leg_details)
        display_strike = float(first["strike"])
    else:
        display_strike = float(first["strike"])

    await db.execute(
        """INSERT INTO aria_positions
           (user_position_id, ticker, strategy_label, status, open_date, expiry,
            strike, option_type, action, quantity, fill_price, commission,
            total_cost, current_price, unrealized_pnl,
            entry_thesis, divergence_note, user_trade_summary,
            confidence_score, exit_conditions_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            user_position_id, ticker.upper(), strategy, "OPEN", now, expiry,
            display_strike, first["option_type"], first["action"],
            first["quantity"], first["fill_price"], total_commission,
            total_cost, first["fill_price"], 0.0,
            decision.get("entry_thesis", ""),
            decision.get("divergence_note", ""),
            user_summary,
            decision.get("confidence_score", 5),
            exit_json,
        ),
    )
    async with db.execute("SELECT last_insert_rowid()") as cur:
        (pos_id,) = await cur.fetchone()

    aria_action_str = f"{strategy}: " + " + ".join(
        f"{l['action']} {l['quantity']}x {l['option_type'].upper()} @{l['strike']}" for l in leg_details
    )

    await _log_decision(
        db, pos_id, user_position_id, ticker, "ENTRY", now,
        decision.get("entry_thesis", ""),
        user_summary, aria_action_str,
        None, decision.get("confidence_score", 5),
        ANTHROPIC_MODEL_SONNET, t_in, t_out, cost,
    )
    await db.commit()

    log.info("ARIA: TRADE on %s — %s (cost $%.2f, confidence %d)",
             ticker, strategy, total_cost, decision.get("confidence_score", 5))
    return {
        "decision": "TRADE",
        "position_id": pos_id,
        "strategy": strategy,
        "total_cost": round(total_cost, 2),
        "confidence": decision.get("confidence_score", 5),
        "entry_thesis": decision.get("entry_thesis", ""),
        "divergence_note": decision.get("divergence_note", ""),
        "user_trade_rating": decision.get("user_trade_rating", ""),
        "user_trade_comment": decision.get("user_trade_comment", ""),
    }


# ── Helpers for independent entries ──────────────────────────────────────────

async def _get_todays_sotd_ticker(db: aiosqlite.Connection) -> tuple[str | None, dict]:
    """Return today's SOTD ticker and its full cached result dict."""
    from datetime import date
    today = date.today().isoformat()
    try:
        async with db.execute(
            "SELECT symbol, signal_json FROM stock_picks WHERE pick_date = ?", (today,)
        ) as cur:
            row = await cur.fetchone()
        if row and row[0]:
            data = json.loads(row[1]) if row[1] else {}
            return row[0], data
    except Exception as e:
        log.warning("ARIA: SOTD fetch failed: %s", e)
    return None, {}


def _pick_expiry(ticker: str) -> str | None:
    """Return the nearest expiry within ARIA_ENTRY_MIN_DTE–ARIA_ENTRY_MAX_DTE range."""
    from datetime import date
    today = date.today()
    for exp_str in get_expirations(ticker):
        dte_val = (_dte(exp_str))
        if ARIA_ENTRY_MIN_DTE <= dte_val <= ARIA_ENTRY_MAX_DTE:
            return exp_str
    return None


# ── Independent entry (no user position required) ────────────────────────────

async def independent_scan_and_trade(db: aiosqlite.Connection) -> dict:
    """
    ARIA independently opens a position using the Options Scanner's top setup.
    Only fires when ARIA has no open positions and sufficient capital.
    Sends a Telegram notification before executing.
    """
    now = datetime.now(UTC).isoformat()

    async def _skip(ticker: str | None, reason: str) -> dict:
        """Log a free skip (no LLM call) to the decision diary and return."""
        t = ticker or "—"
        await _log_decision(
            db, None, None, t, "INDEPENDENT_SKIP", now,
            reason, None, None, None, 0,
            "none", 0, 0, 0.0,
        )
        await db.commit()
        log.info("ARIA independent: skip %s — %s", t, reason)
        return {"action": "skipped", "reason": reason}

    # Guard: only trade if no open positions
    async with db.execute(
        "SELECT COUNT(*) FROM aria_positions WHERE status = 'OPEN'"
    ) as cur:
        (open_count,) = await cur.fetchone()
    if open_count > 0:
        return {"action": "skipped", "reason": "has_open_positions"}

    acct = await _ensure_aria_account(db)
    if acct["cash"] < ARIA_MAX_POSITION_COST:
        return await _skip(None, f"Insufficient cash (${acct['cash']:.0f} < ${ARIA_MAX_POSITION_COST:.0f} required). Waiting for capital to free up.")

    # Get top Options Scanner setup for today
    from datetime import date as _date
    today = _date.today().isoformat()
    async with db.execute(
        "SELECT full_context_json FROM options_scanner_cache "
        "WHERE scan_date = ? ORDER BY conviction_score DESC LIMIT 1", (today,)
    ) as cur:
        row = await cur.fetchone()

    if not row or not row[0]:
        log.info("ARIA independent: no scanner setup available today — falling back to SOTD")
        # Fallback: use SOTD if scanner hasn't run yet
        ticker, sotd_data = await _get_todays_sotd_ticker(db)
        if not ticker or sotd_data.get("no_trade_day"):
            return await _skip(None, "No setup available today — scanner hasn't run yet and SOTD returned no trade signal. Will retry on next revalue cycle.")
        setup = None
    else:
        import json as _json
        setup = _json.loads(row[0])
        ticker = setup["ticker"]

    # Determine expiry: use scanner's recommendation, or pick one
    if setup and setup.get("rec_expiry"):
        expiry = setup["rec_expiry"]
    else:
        expiry = await asyncio.to_thread(_pick_expiry, ticker)
    if not expiry:
        return await _skip(ticker, f"No valid expiry found for {ticker} in the {ARIA_ENTRY_MIN_DTE}–{ARIA_ENTRY_MAX_DTE} DTE window. Options chain may be unavailable or market is closed.")

    # Fetch chain + technicals
    try:
        chain = fetch_options_chain(ticker.upper(), expiry)
        S = chain["underlying"]
        dte_val = chain["dte"]
        expected_move = chain["expected_move"]
        chain_summary = _summarise_chain(chain["calls"], chain["puts"], S)
    except Exception as e:
        log.warning("ARIA independent: chain fetch failed for %s: %s", ticker, e)
        return await _skip(ticker, f"Options chain fetch failed for {ticker}: {e}. This is usually a temporary data provider issue.")

    try:
        tech = await compute_technicals(ticker.upper())
    except Exception:
        tech = None
    tech_summary = _summarise_technicals(tech)

    max_qty = max(1, int(ARIA_MAX_POSITION_COST / (S * 0.03 * MULTIPLIER + COMMISSION_PER_CONTRACT)))
    max_qty = min(max_qty, 5)

    # Build scanner context for the prompt
    if setup:
        scanner_context = (
            f"Options Scanner Analysis:\n"
            f"  Direction: {setup['direction']} | Conviction: {setup['conviction_score']}/100\n"
            f"  Strategy recommended: {setup['strategy_label']}\n"
            f"  IV: {setup.get('iv_current', '?')}% ATM vs {setup.get('iv_30d_hv', '?')}% realized (regime: {setup.get('iv_regime', '?')})\n"
            f"  Skew: risk-reversal {setup.get('risk_reversal', '?')} ({setup.get('skew_direction', '?')})\n"
            f"  OI: max-pain ${setup.get('max_pain', '?')} | call wall ${setup.get('call_wall', '?')} | put wall ${setup.get('put_wall', '?')}\n"
            f"  Signal: {setup.get('signal_summary', '')}"
        )
        pre_rec = (
            f"  Pre-built legs: " +
            " + ".join(
                f"{l['action']} {l['option_type'].upper()} @${l['strike']:.0f} (Δ {l.get('delta', '?'):.2f})"
                for l in (setup.get("rec_legs") or [])
            ) if setup.get("rec_legs") else "  No pre-built legs."
        )
        scanner_context += f"\n{pre_rec}"
    else:
        scanner_context = "Scanner not yet run today — using SOTD as fallback."

    prompt = f"""You are ARIA, an autonomous options trading agent with the patience and risk appetite of a confident retail investor.

You have NO open positions and ${acct['cash']:.2f} available to deploy.

TICKER: {ticker} | Current price: ${S:.2f} | Expiry target: {expiry} ({dte_val} DTE)

{scanner_context}

LIVE OPTIONS CHAIN (ATM ±5 strikes):
{chain_summary}
Expected move: ±${expected_move:.2f}

TECHNICALS:
{tech_summary}

ARIA RISK RULES:
- Max cost per trade: ${ARIA_MAX_POSITION_COST:.0f} | Max legs per contract: {max_qty}
- Prefer spreads when ATM IV > 35% — they cap your vega exposure
- Never buy options with < 14 DTE
- You hold for days to weeks — short-term noise is expected
- Profit target: 80–150% of risk | Hard stop: -35%

Use the scanner's recommended strategy and legs as your starting point. You may adjust strikes by ±1 step if the live chain shows better fills, or PASS if the setup has deteriorated.

Respond ONLY with valid JSON (no markdown):
{{
  "decision": "TRADE" or "PASS",
  "pass_reason": "string if PASS, else null",
  "strategy_label": "e.g. Long Call / Bull Call Spread / Long Put",
  "legs": [
    {{"strike": number, "option_type": "call" or "put", "action": "BUY" or "SELL", "quantity": number}}
  ],
  "entry_thesis": "2-3 sentence explanation",
  "confidence_score": integer 1-10,
  "exit_conditions": {{
    "profit_target_pct": number,
    "stop_loss_pct": number,
    "thesis_decay_signals": "what would invalidate the thesis"
  }}
}}"""

    now = datetime.now(UTC).isoformat()

    try:
        resp = _client.messages.create(
            model=ANTHROPIC_MODEL_SONNET,
            max_tokens=700,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = resp.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        decision = json.loads(raw)
        cost, t_in, t_out = await _log_cost(
            db, "aria_independent_entry", ANTHROPIC_MODEL_SONNET,
            resp.usage.input_tokens, resp.usage.output_tokens,
        )
    except Exception as e:
        log.error("ARIA independent: Sonnet call failed: %s", e)
        return {"action": "skipped", "reason": f"llm_error: {e}"}

    if decision.get("decision") != "TRADE":
        log.info("ARIA independent: PASS on %s — %s", ticker, decision.get("pass_reason", ""))
        await _log_decision(
            db, None, None, ticker, "INDEPENDENT_PASS", now,
            decision.get("pass_reason", "No trade"),
            f"SOTD: {ticker}", None, None, decision.get("confidence_score", 5),
            ANTHROPIC_MODEL_SONNET, t_in, t_out, cost,
        )
        await db.commit()
        return {"action": "pass", "ticker": ticker, "reason": decision.get("pass_reason")}

    legs_spec = decision.get("legs", [])
    if not legs_spec:
        return {"action": "skipped", "reason": "no_legs"}

    # Execute legs (same validation path as analyze_and_trade)
    total_cost = 0.0
    total_commission = 0.0
    leg_details = []

    try:
        for leg_spec in legs_spec:
            strike = float(leg_spec["strike"])
            is_call = leg_spec["option_type"].lower() == "call"
            action = leg_spec["action"].upper()
            quantity = min(int(leg_spec.get("quantity", 1)), max_qty)

            contracts = chain["calls"] if is_call else chain["puts"]
            match = next((c for c in contracts if abs(c["strike"] - strike) < 0.01), None)
            if match is None:
                match = min(contracts, key=lambda c: abs(c["strike"] - strike), default=None)
            if match is None:
                raise ValueError(f"No contract near strike {strike}")

            fill = simulate_fill(match.get("bid"), match.get("ask"), action)
            if fill <= 0:
                raise ValueError(f"Zero fill for strike {strike}")

            commission = COMMISSION_PER_CONTRACT * quantity
            leg_cost = fill * MULTIPLIER * quantity if action == "BUY" else -fill * MULTIPLIER * quantity
            leg_cost += commission
            total_cost += leg_cost
            total_commission += commission

            T = _dte_years(expiry)
            iv = (match.get("iv") or 30.0) / 100.0
            greeks = bs_greeks(S, strike, T, RISK_FREE_RATE, iv, is_call)
            leg_details.append({
                "strike": strike, "option_type": leg_spec["option_type"].lower(),
                "action": action, "quantity": quantity,
                "fill_price": fill, "commission": commission, "leg_cost": leg_cost,
                "iv_pct": match.get("iv"), "greeks": greeks,
            })
    except Exception as e:
        log.warning("ARIA independent: leg execution failed: %s", e)
        return {"action": "skipped", "reason": f"execution_error: {e}"}

    if total_cost > acct["cash"]:
        return {"action": "skipped", "reason": "insufficient_cash"}

    # ── Telegram notification — send BEFORE writing to DB ────────────────────
    strategy = decision.get("strategy_label", "ARIA Trade")
    legs_str = " + ".join(
        f"{l['action']} {l['quantity']}x {l['option_type'].upper()} @${l['strike']:.0f}"
        for l in leg_details
    )
    tg_msg = (
        f"🤖 *ARIA — Opening Position*\n\n"
        f"*{ticker}* | {strategy}\n"
        f"{legs_str}\n"
        f"Expiry: {expiry} ({dte_val} DTE)\n"
        f"Cost: ${total_cost:.2f} | Confidence: {decision.get('confidence_score', '?')}/10\n\n"
        f"_{decision.get('entry_thesis', '')}_\n\n"
        f"Cash after: ${acct['cash'] - total_cost:.2f}"
    )
    try:
        from app.notifications.telegram_bot import send_message as _tg
        await _tg(tg_msg, force=True)
    except Exception as e:
        log.warning("ARIA independent: Telegram notification failed: %s", e)

    # ── Write position to DB ──────────────────────────────────────────────────
    new_cash = acct["cash"] - total_cost
    await db.execute(
        "UPDATE aria_account SET cash = ?, total_commissions = total_commissions + ?, "
        "trade_count = trade_count + 1, updated_at = ? WHERE id = 1",
        (new_cash, total_commission, now),
    )

    exit_json = json.dumps(decision.get("exit_conditions", {
        "profit_target_pct": ARIA_PROFIT_TARGET_PCT,
        "stop_loss_pct": ARIA_STOP_LOSS_PCT,
        "thesis_decay_signals": "Major trend reversal",
    }))

    first = leg_details[0]
    await db.execute(
        """INSERT INTO aria_positions
           (user_position_id, ticker, strategy_label, status, open_date, expiry,
            strike, option_type, action, quantity, fill_price, commission,
            total_cost, current_price, unrealized_pnl,
            entry_thesis, divergence_note, user_trade_summary,
            confidence_score, exit_conditions_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            None, ticker.upper(), strategy, "OPEN", now, expiry,
            first["strike"], first["option_type"], first["action"],
            first["quantity"], first["fill_price"], total_commission,
            total_cost, first["fill_price"], 0.0,
            decision.get("entry_thesis", ""),
            "ARIA independent entry — no user position to mirror.",
            f"SOTD: {ticker}",
            decision.get("confidence_score", 5),
            exit_json,
        ),
    )
    async with db.execute("SELECT last_insert_rowid()") as cur:
        (pos_id,) = await cur.fetchone()

    await _log_decision(
        db, pos_id, None, ticker, "INDEPENDENT_ENTRY", now,
        decision.get("entry_thesis", ""),
        f"SOTD: {ticker}", f"{strategy}: {legs_str}",
        None, decision.get("confidence_score", 5),
        ANTHROPIC_MODEL_SONNET, t_in, t_out, cost,
    )
    await db.commit()

    log.info("ARIA independent: TRADE on %s — %s (cost $%.2f, conf %d)",
             ticker, strategy, total_cost, decision.get("confidence_score", 5))
    return {
        "action": "trade",
        "position_id": pos_id,
        "ticker": ticker,
        "strategy": strategy,
        "total_cost": round(total_cost, 2),
        "confidence": decision.get("confidence_score", 5),
    }


# ── Exit check (runs each revaluation cycle) ─────────────────────────────────

async def check_aria_exits(db: aiosqlite.Connection) -> dict:
    """
    For each open ARIA position, check if exit conditions are met.
    Uses Haiku for cheap hold/exit decisions, Sonnet only when actually exiting.
    """
    async with db.execute("SELECT * FROM aria_positions WHERE status = 'OPEN'") as cur:
        rows = await cur.fetchall()

    cols = ["id","user_position_id","ticker","strategy_label","status","open_date",
            "close_date","expiry","strike","option_type","action","quantity",
            "fill_price","commission","total_cost","current_price","unrealized_pnl",
            "realized_pnl","close_price","entry_thesis","divergence_note",
            "user_trade_summary","confidence_score","exit_conditions_json",
            "exit_reasoning","created_at"]

    exited = 0
    held = 0
    now = datetime.now(UTC).isoformat()

    for row in rows:
        pos = dict(zip(cols, row))
        try:
            await _check_single_exit(db, pos, now)
            exited += 1 if pos.get("_exited") else 0
            held += 1 if not pos.get("_exited") else 0
        except Exception as e:
            log.warning("ARIA exit check pos %d: %s", pos["id"], e)

    # After processing exits: attempt independent entry if no positions remain open
    independent_result: dict = {}
    try:
        async with db.execute(
            "SELECT COUNT(*) FROM aria_positions WHERE status = 'OPEN'"
        ) as cur:
            (remaining,) = await cur.fetchone()
        if remaining == 0:
            independent_result = await independent_scan_and_trade(db)
            if independent_result.get("action") == "trade":
                log.info("ARIA: independent entry triggered — %s", independent_result)
    except Exception as e:
        log.warning("ARIA independent scan error: %s", e)

    return {"exited": exited, "held": held, "independent": independent_result}


async def _check_single_exit(db: aiosqlite.Connection, pos: dict, now: str):
    """Check exit conditions for one ARIA position and exit if warranted."""
    ticker = pos["ticker"]
    expiry = pos["expiry"]
    strike = pos["strike"]
    is_call = pos["option_type"] == "call"
    quantity = pos["quantity"]
    fill_price = pos["fill_price"]
    action = pos["action"]
    total_cost = pos["total_cost"]

    dte = _dte(expiry)
    exit_conds = json.loads(pos.get("exit_conditions_json") or "{}")
    profit_target = float(exit_conds.get("profit_target_pct", ARIA_PROFIT_TARGET_PCT))
    stop_loss = float(exit_conds.get("stop_loss_pct", ARIA_STOP_LOSS_PCT))

    # Hard rules — no LLM needed
    if dte <= ARIA_MIN_DTE_TO_HOLD:
        await _do_exit(db, pos, now, "HARD_RULE",
                       f"DTE fell to {dte} (min {ARIA_MIN_DTE_TO_HOLD}). Exiting to avoid expiry risk.")
        pos["_exited"] = True
        return

    # Refresh current price
    try:
        chain = fetch_options_chain(ticker, expiry)
        contracts = chain["calls"] if is_call else chain["puts"]
        match = next((c for c in contracts if abs(c["strike"] - strike) < 0.01), None)
        curr_price = (match.get("mid") or match.get("lastPrice") or fill_price) if match else fill_price
    except Exception:
        curr_price = pos.get("current_price") or fill_price

    sign = 1 if action == "BUY" else -1
    unrealized = sign * (curr_price - fill_price) * MULTIPLIER * quantity
    pnl_pct = (unrealized / abs(total_cost) * 100) if total_cost else 0

    # Update current price in DB
    await db.execute(
        "UPDATE aria_positions SET current_price = ?, unrealized_pnl = ? WHERE id = ?",
        (curr_price, round(unrealized, 2), pos["id"]),
    )

    # Hard P&L rules — always enforced regardless of hold time
    if pnl_pct >= profit_target:
        await _do_exit(db, pos, now, "PROFIT_TARGET",
                       f"Profit target hit: +{pnl_pct:.1f}% (target was +{profit_target:.0f}%). "
                       f"Taking gains — ${unrealized:.2f} realized.")
        pos["_exited"] = True
        return

    if pnl_pct <= stop_loss:
        await _do_exit(db, pos, now, "STOP_LOSS",
                       f"Stop-loss triggered: {pnl_pct:.1f}% (limit was {stop_loss:.0f}%). "
                       f"Cutting loss — ${unrealized:.2f}.")
        pos["_exited"] = True
        return

    # Min hold time guard — no Haiku noise within first 48h
    open_dt = datetime.fromisoformat(pos["open_date"].replace("Z", "+00:00"))
    hours_open = (datetime.now(UTC) - open_dt).total_seconds() / 3600
    if hours_open < ARIA_MIN_HOLD_HOURS:
        await _log_decision(
            db, pos["id"], pos.get("user_position_id"), ticker, "HOLD", now,
            f"Min hold time not reached ({hours_open:.1f}h < {ARIA_MIN_HOLD_HOURS}h). Holding.",
            None, None, round(unrealized, 2), pos.get("confidence_score", 5),
            None, 0, 0, 0.0,
        )
        return

    # Min profit gate — don't exit small winners via Haiku; let them grow
    if 0 < pnl_pct < ARIA_MIN_HAIKU_PROFIT:
        await _log_decision(
            db, pos["id"], pos.get("user_position_id"), ticker, "HOLD", now,
            f"Position profitable (+{pnl_pct:.1f}%) but below min Haiku gate ({ARIA_MIN_HAIKU_PROFIT:.0f}%). Holding for larger gain.",
            None, None, round(unrealized, 2), pos.get("confidence_score", 5),
            None, 0, 0, 0.0,
        )
        return

    # Soft check via Haiku (cheap)
    thesis_decay = exit_conds.get("thesis_decay_signals", "")
    try:
        tech = await compute_technicals(ticker)
        tech_str = _summarise_technicals(tech)
    except Exception:
        tech_str = "Unavailable"

    haiku_prompt = f"""You are ARIA's exit monitor for a patient retail options investor with medium-high risk appetite.

Position: {action} {quantity}x {pos['option_type'].upper()} @{strike} on {ticker}
Expiry: {expiry} | DTE remaining: {dte} | Open for: {int(hours_open)}h
Entry thesis: {pos.get('entry_thesis','unknown')}
Thesis decay signals to watch: {thesis_decay}
Current P&L: {pnl_pct:+.1f}% (${unrealized:+.2f})
Current technicals: {tech_str}

Holding philosophy: patient retail investor. Short-term price noise, minor dips, and choppy action are NORMAL and NOT exit signals.
Recommend EXIT only if the original thesis has fundamentally reversed — e.g. a breakout failed and price is now back below entry support, a key catalyst was cancelled, or momentum has completely collapsed over multiple sessions.
Small losses or flat performance are NOT reasons to exit.

Reply with ONLY this JSON:
{{"action": "HOLD" or "EXIT", "reason": "one sentence"}}"""

    try:
        resp = _client.messages.create(
            model=ANTHROPIC_MODEL_HAIKU,
            max_tokens=80,
            messages=[{"role": "user", "content": haiku_prompt}],
        )
        raw = resp.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        result = json.loads(raw)
        await _log_cost(db, "aria_exit_check", ANTHROPIC_MODEL_HAIKU,
                        resp.usage.input_tokens, resp.usage.output_tokens)

        if result.get("action") == "EXIT":
            # Write proper exit note with Sonnet
            exit_reason = await _write_exit_note(db, pos, pnl_pct, unrealized, dte, result["reason"])
            await _do_exit(db, pos, now, "AI_EXIT", exit_reason)
            pos["_exited"] = True
        else:
            await _log_decision(
                db, pos["id"], pos.get("user_position_id"), ticker, "HOLD", now,
                result.get("reason", "Holding"),
                None, None, round(unrealized, 2), pos.get("confidence_score", 5),
                ANTHROPIC_MODEL_HAIKU,
                resp.usage.input_tokens, resp.usage.output_tokens, 0.0,
            )
    except Exception as e:
        log.warning("ARIA Haiku check failed pos %d: %s", pos["id"], e)


async def _write_exit_note(db, pos, pnl_pct, unrealized, dte, haiku_reason) -> str:
    """Brief Sonnet call to write a quality exit post-mortem."""
    prompt = f"""Write a concise options trade exit post-mortem (3-4 sentences) for ARIA's decision log.

Trade: {pos['action']} {pos['quantity']}x {pos['option_type'].upper()} @{pos['strike']} on {pos['ticker']}
Entry thesis: {pos.get('entry_thesis','')}
P&L: {pnl_pct:+.1f}% (${unrealized:+.2f}) | DTE remaining: {dte}
Exit signal: {haiku_reason}

Cover: what happened, whether the thesis played out, and one lesson for next time. Be direct and specific."""

    try:
        resp = _client.messages.create(
            model=ANTHROPIC_MODEL_SONNET,
            max_tokens=200,
            messages=[{"role": "user", "content": prompt}],
        )
        await _log_cost(db, "aria_exit_note", ANTHROPIC_MODEL_SONNET,
                        resp.usage.input_tokens, resp.usage.output_tokens)
        return resp.content[0].text.strip()
    except Exception:
        return haiku_reason


async def _do_exit(db: aiosqlite.Connection, pos: dict, now: str,
                   exit_type: str, exit_reasoning: str):
    """Close the ARIA position and update account cash."""
    ticker = pos["ticker"]
    expiry = pos["expiry"]
    strike = pos["strike"]
    is_call = pos["option_type"] == "call"
    quantity = pos["quantity"]
    fill_price = pos["fill_price"]
    action = pos["action"]
    total_cost = pos["total_cost"]

    # Get close price
    try:
        chain = fetch_options_chain(ticker, expiry)
        contracts = chain["calls"] if is_call else chain["puts"]
        match = next((c for c in contracts if abs(c["strike"] - strike) < 0.01), None)
        close_action = "SELL" if action == "BUY" else "BUY"
        from app.analysis.options_engine import simulate_fill as _fill
        close_price = _fill(
            match.get("bid") if match else None,
            match.get("ask") if match else None,
            close_action,
        ) if match else (pos.get("current_price") or fill_price)
    except Exception:
        close_price = pos.get("current_price") or fill_price

    sign = 1 if action == "BUY" else -1
    realized = sign * (close_price - fill_price) * MULTIPLIER * quantity
    commission = COMMISSION_PER_CONTRACT * quantity
    realized -= commission
    # For multi-leg spreads, total_cost is the net debit/credit, not the full long leg value.
    # proceeds = net capital returned to cash = net entry premium + P&L
    # (entry commission is already consumed from cash at open, so subtract it here)
    entry_commission = pos["commission"]
    proceeds = realized + (total_cost - entry_commission)

    is_win = realized > 0
    await db.execute(
        "UPDATE aria_positions SET status = 'CLOSED', close_date = ?, close_price = ?, "
        "realized_pnl = ?, unrealized_pnl = 0.0, exit_reasoning = ? WHERE id = ?",
        (now, close_price, round(realized, 2), exit_reasoning, pos["id"]),
    )
    await db.execute(
        "UPDATE aria_account SET cash = cash + ?, realized_pnl = realized_pnl + ?, "
        "total_commissions = total_commissions + ?, "
        f"win_count = win_count + {1 if is_win else 0}, updated_at = ? WHERE id = 1",
        (proceeds, realized, commission, now),
    )
    await _log_decision(
        db, pos["id"], pos.get("user_position_id"), ticker, f"EXIT_{exit_type}", now,
        exit_reasoning, None,
        f"Closed @ ${close_price:.3f} | P&L ${realized:+.2f}",
        round(realized, 2), pos.get("confidence_score", 5),
        None, 0, 0, 0.0,
    )
    await db.commit()
    log.info("ARIA: EXIT %s pos %d — %s P&L $%.2f", exit_type, pos["id"], ticker, realized)


# ── DB helpers ────────────────────────────────────────────────────────────────

async def _log_pass(db, user_pos_id, ticker, now, reason, user_legs):
    user_summary = _summarise_user_legs(user_legs)
    await _log_decision(db, None, user_pos_id, ticker, "PASS", now,
                        reason, user_summary, None, None, 0, None, 0, 0, 0.0)
    await db.commit()


async def _log_decision(db, pos_id, user_pos_id, ticker, dtype, now,
                        reasoning, user_summary, aria_action,
                        pnl, confidence, model, t_in, t_out, cost):
    await db.execute(
        """INSERT INTO aria_decisions
           (position_id, user_position_id, ticker, decision_type, decision_at,
            reasoning, user_trade_summary, aria_action, pnl_at_decision,
            confidence, model_used, tokens_in, tokens_out, cost_usd)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (pos_id, user_pos_id, ticker, dtype, now, reasoning,
         user_summary, aria_action, pnl, confidence, model, t_in, t_out, cost),
    )


# ── Position list ─────────────────────────────────────────────────────────────

async def list_aria_positions(db: aiosqlite.Connection, status: str = "OPEN") -> list[dict]:
    async with db.execute(
        "SELECT * FROM aria_positions WHERE status = ? ORDER BY open_date DESC", (status,)
    ) as cur:
        rows = await cur.fetchall()
    cols = ["id","user_position_id","ticker","strategy_label","status","open_date",
            "close_date","expiry","strike","option_type","action","quantity",
            "fill_price","commission","total_cost","current_price","unrealized_pnl",
            "realized_pnl","close_price","entry_thesis","divergence_note",
            "user_trade_summary","confidence_score","exit_conditions_json",
            "exit_reasoning","created_at"]
    return [dict(zip(cols, r)) for r in rows]


async def list_aria_decisions(db: aiosqlite.Connection, limit: int = 50) -> list[dict]:
    async with db.execute(
        "SELECT * FROM aria_decisions ORDER BY decision_at DESC LIMIT ?", (limit,)
    ) as cur:
        rows = await cur.fetchall()
    cols = ["id","position_id","user_position_id","ticker","decision_type",
            "decision_at","reasoning","user_trade_summary","aria_action",
            "pnl_at_decision","confidence","model_used","tokens_in","tokens_out","cost_usd"]
    return [dict(zip(cols, r)) for r in rows]


async def get_scoreboard(db: aiosqlite.Connection) -> dict:
    """Head-to-head metrics: ARIA vs User."""
    aria_acct = await get_aria_account(db)

    async with db.execute(
        "SELECT cash, initial_capital, realized_pnl, total_commissions FROM options_account WHERE id = 1"
    ) as cur:
        row = await cur.fetchone()
    if row:
        user_cash, user_init, user_real, user_comm = (float(x or 0) for x in row)
    else:
        user_cash, user_init, user_real, user_comm = 10000, 10000, 0, 0

    # Market value of open legs (current_price * 100 * qty).
    # Can't use unrealized_pnl alone — cash was debited by the full premium at open,
    # so net_liq = cash + market_value, not cash + pnl_change.
    async with db.execute(
        """SELECT COALESCE(SUM(
               COALESCE(l.current_price, l.fill_price) * 100 * l.quantity
           ), 0)
           FROM options_legs l
           JOIN options_positions p ON l.position_id = p.id
           WHERE p.status = 'OPEN' AND l.status = 'OPEN'"""
    ) as cur:
        (option_mkt_value,) = await cur.fetchone()

    async with db.execute(
        "SELECT COALESCE(SUM(unrealized_pnl), 0) FROM options_positions WHERE status = 'OPEN'"
    ) as cur:
        (user_unreal,) = await cur.fetchone()

    user_net_liq = user_cash + float(option_mkt_value or 0)
    user_total_pnl = user_net_liq - user_init

    # Count all positions (open + closed); wins from closed only
    async with db.execute(
        "SELECT COUNT(*) FROM options_positions"
    ) as cur:
        (user_trades,) = await cur.fetchone()
    async with db.execute(
        "SELECT COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END), 0) FROM options_positions WHERE status = 'CLOSED'"
    ) as cur:
        (user_wins,) = await cur.fetchone()
    user_trades, user_wins = int(user_trades or 0), int(user_wins or 0)
    user_win_rate = round(user_wins / user_trades * 100, 1) if user_trades > 0 else 0.0

    return {
        "user": {
            "net_liq": round(user_net_liq, 2),
            "total_pnl": round(user_total_pnl, 2),
            "total_return_pct": round(user_total_pnl / user_init * 100, 2) if user_init else 0,
            "realized_pnl": round(user_real, 2),
            "unrealized_pnl": round(float(user_unreal or 0), 2),
            "trade_count": user_trades,
            "win_rate": user_win_rate,
            "commissions": round(user_comm, 2),
        },
        "aria": {
            "net_liq": aria_acct["net_liq"],
            "total_pnl": aria_acct["total_pnl"],
            "total_return_pct": aria_acct["total_return_pct"],
            "realized_pnl": aria_acct["realized_pnl"],
            "unrealized_pnl": aria_acct["unrealized_pnl"],
            "trade_count": aria_acct["trade_count"],
            "win_rate": aria_acct["win_rate"],
            "commissions": round(aria_acct["total_commissions"], 2),
        },
        "leader": "aria" if aria_acct["net_liq"] > user_net_liq else ("user" if user_net_liq > aria_acct["net_liq"] else "tie"),
        "edge": round(abs(aria_acct["net_liq"] - user_net_liq), 2),
    }
