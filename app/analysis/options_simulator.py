"""
Options account management, execution simulation, revaluation, and Greeks aggregation.
All state lives in the options_* SQLite tables.
"""

import json
import logging
from datetime import datetime, UTC
from typing import Any

import aiosqlite

from app.config import DB_PATH
from app.analysis.options_engine import (
    bs_price, bs_greeks, fetch_options_chain, get_underlying_price,
    simulate_fill, scenario_pnl as _scenario_pnl,
    COMMISSION_PER_CONTRACT, MULTIPLIER, RISK_FREE_RATE, _dte_years, _dte,
)

log = logging.getLogger(__name__)


# ── Account helpers ──────────────────────────────────────────────────────────

async def ensure_account(db: aiosqlite.Connection) -> dict:
    """Return the single options account row, seeding it if absent."""
    async with db.execute("SELECT * FROM options_account WHERE id = 1") as cur:
        row = await cur.fetchone()
    if row is None:
        await db.execute(
            "INSERT INTO options_account (id, cash, initial_capital, realized_pnl, total_commissions) "
            "VALUES (1, 10000.0, 10000.0, 0.0, 0.0)"
        )
        await db.commit()
        return {"id": 1, "cash": 10000.0, "initial_capital": 10000.0,
                "realized_pnl": 0.0, "total_commissions": 0.0}
    cols = ["id", "cash", "initial_capital", "realized_pnl", "total_commissions",
            "created_at", "updated_at"]
    return dict(zip(cols, row))


async def get_account(db: aiosqlite.Connection) -> dict:
    acct = await ensure_account(db)
    # net_liq = cash + market value of open legs (not just unrealized P&L change)
    async with db.execute(
        """SELECT COALESCE(SUM(
               CASE WHEN l.action = 'BUY' THEN 1 ELSE -1 END *
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
        (unreal,) = await cur.fetchone()
    acct["unrealized_pnl"] = round(float(unreal or 0), 2)
    acct["net_liq"] = round(acct["cash"] + float(option_mkt_value or 0), 2)
    acct["total_pnl"] = round(acct["net_liq"] - acct["initial_capital"], 2)
    acct["total_return_pct"] = round(
        acct["total_pnl"] / acct["initial_capital"] * 100, 2
    ) if acct["initial_capital"] else 0.0
    return acct


# ── Open position ─────────────────────────────────────────────────────────────

async def open_position(
    db: aiosqlite.Connection,
    ticker: str,
    expiry: str,
    strike: float,
    option_type: str,   # "call" or "put"
    action: str,        # "BUY" or "SELL"
    quantity: int,
    bid: float | None,
    ask: float | None,
    note: str = "",
) -> dict:
    """
    Execute a single-leg option position:
    1. Compute fill price via simulate_fill
    2. Deduct/collect cost from cash account
    3. Compute entry Greeks from contract IV (derived from mid price via chain)
    4. Insert position + leg + transaction records
    """
    acct = await ensure_account(db)

    is_call = option_type.lower() == "call"
    fill = simulate_fill(bid, ask, action)
    if fill <= 0:
        raise ValueError(f"Invalid fill price: bid={bid} ask={ask}")

    commission = COMMISSION_PER_CONTRACT * quantity
    total_cost = fill * MULTIPLIER * quantity + commission  # positive = money out
    if action.upper() == "SELL":
        total_cost = -fill * MULTIPLIER * quantity + commission  # credit received minus commission

    if action.upper() == "BUY" and acct["cash"] < total_cost:
        raise ValueError(
            f"Insufficient cash: need ${total_cost:.2f}, have ${acct['cash']:.2f}"
        )

    # Fetch IV from chain to compute Greeks
    S = get_underlying_price(ticker)
    T = _dte_years(expiry)
    r = RISK_FREE_RATE
    # Use implied IV from mid approximation: solve from mid price (simplified — use mid IV)
    mid = ((bid or 0) + (ask or ask or 0)) / 2.0 if bid and ask else (ask or bid or fill)
    # Best estimate of IV: use provided IV from chain by recomputing from fill
    # For entry Greeks, use 0.30 as fallback; caller should pass iv from chain
    iv = 0.30  # will be overridden in open_position_with_chain

    greeks = bs_greeks(S or strike, strike, T, r, iv, is_call) if S else {}

    now = datetime.now(UTC).isoformat()

    # Deduct cash
    new_cash = acct["cash"] - total_cost
    await db.execute(
        "UPDATE options_account SET cash = ?, total_commissions = total_commissions + ?, updated_at = ? WHERE id = 1",
        (new_cash, commission, now),
    )

    # Insert position
    await db.execute(
        "INSERT INTO options_positions (ticker, strategy_label, status, open_date, total_cost, unrealized_pnl, last_revalued_at) "
        "VALUES (?, 'Single Leg', 'OPEN', ?, ?, 0.0, ?)",
        (ticker.upper(), now, total_cost, now),
    )
    async with db.execute("SELECT last_insert_rowid()") as cur:
        (pos_id,) = await cur.fetchone()

    # Insert leg
    await db.execute(
        """INSERT INTO options_legs
           (position_id, ticker, expiry, strike, option_type, action, quantity,
            fill_price, commission, iv_at_entry, delta_at_entry, gamma_at_entry,
            theta_at_entry, vega_at_entry, rho_at_entry, underlying_at_entry,
            current_price, current_delta, current_gamma, current_theta, current_vega,
            current_iv, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')""",
        (
            pos_id, ticker.upper(), expiry, strike, option_type.lower(), action.upper(),
            quantity, fill, commission,
            round(iv * 100, 2),
            greeks.get("delta"), greeks.get("gamma"), greeks.get("theta"),
            greeks.get("vega"), greeks.get("rho"),
            S,
            fill,  # current_price starts at fill
            greeks.get("delta"), greeks.get("gamma"), greeks.get("theta"),
            greeks.get("vega"),
            round(iv * 100, 2),
        ),
    )
    async with db.execute("SELECT last_insert_rowid()") as cur:
        (leg_id,) = await cur.fetchone()

    # Transaction record
    await db.execute(
        "INSERT INTO options_transactions "
        "(position_id, leg_id, tx_type, ticker, expiry, strike, option_type, action, "
        "quantity, fill_price, premium_total, commission, net_cash_impact, underlying_price, iv_at_fill, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (pos_id, leg_id, "OPEN", ticker.upper(), expiry, strike, option_type.lower(), action.upper(),
         quantity, fill, fill * MULTIPLIER * quantity, commission, -total_cost,
         S, round(iv * 100, 2), now),
    )

    # Trade note
    if note:
        await db.execute(
            "INSERT INTO options_trade_notes (position_id, thesis) VALUES (?, ?)",
            (pos_id, note),
        )

    await db.commit()
    return {
        "position_id": pos_id,
        "leg_id": leg_id,
        "fill_price": fill,
        "commission": commission,
        "total_cost": total_cost,
        "cash_remaining": round(new_cash, 2),
    }


async def open_position_with_chain(
    db: aiosqlite.Connection,
    ticker: str,
    expiry: str,
    strike: float,
    option_type: str,
    action: str,
    quantity: int,
    note: str = "",
) -> dict:
    """
    Fetch live chain, find the matching contract, and open the position.
    """
    chain = fetch_options_chain(ticker, expiry)
    contracts = chain["calls"] if option_type.lower() == "call" else chain["puts"]
    match = next((c for c in contracts if abs(c["strike"] - strike) < 0.001), None)
    if match is None:
        raise ValueError(f"Strike {strike} not found in {ticker} {expiry} chain")

    bid = match.get("bid")
    ask = match.get("ask")
    iv_pct = match.get("iv") or 30.0  # IV as %

    result = await open_position(db, ticker, expiry, strike, option_type, action, quantity, bid, ask, note)

    # Update leg with correct IV and Greeks from chain
    iv = iv_pct / 100.0
    S = chain["underlying"]
    T = _dte_years(expiry)
    r = RISK_FREE_RATE
    is_call = option_type.lower() == "call"
    greeks = bs_greeks(S, strike, T, r, iv, is_call)
    now = datetime.now(UTC).isoformat()
    await db.execute(
        """UPDATE options_legs SET
           iv_at_entry = ?, delta_at_entry = ?, gamma_at_entry = ?, theta_at_entry = ?,
           vega_at_entry = ?, underlying_at_entry = ?,
           current_iv = ?, current_delta = ?, current_gamma = ?, current_theta = ?, current_vega = ?
           WHERE id = ?""",
        (
            iv_pct, greeks["delta"], greeks["gamma"], greeks["theta"], greeks["vega"], S,
            iv_pct, greeks["delta"], greeks["gamma"], greeks["theta"], greeks["vega"],
            result["leg_id"],
        ),
    )
    await db.commit()
    return result


# ── Close position ────────────────────────────────────────────────────────────

async def close_position(db: aiosqlite.Connection, position_id: int, note: str = "") -> dict:
    """Close all open legs of a position at current market prices."""
    async with db.execute(
        "SELECT * FROM options_positions WHERE id = ? AND status = 'OPEN'", (position_id,)
    ) as cur:
        pos = await cur.fetchone()
    if not pos:
        raise ValueError(f"Open position {position_id} not found")

    pos_cols = ["id","ticker","strategy_label","status","open_date","close_date",
                "total_cost","total_proceeds","realized_pnl","unrealized_pnl",
                "last_revalued_at","trade_notes_id","created_at"]
    pos_dict = dict(zip(pos_cols, pos))

    async with db.execute(
        "SELECT * FROM options_legs WHERE position_id = ? AND status = 'OPEN'", (position_id,)
    ) as cur:
        legs = await cur.fetchall()

    if not legs:
        raise ValueError(f"No open legs for position {position_id}")

    leg_cols = ["id","position_id","ticker","expiry","strike","option_type","action",
                "quantity","fill_price","commission","iv_at_entry","delta_at_entry",
                "gamma_at_entry","theta_at_entry","vega_at_entry","rho_at_entry",
                "underlying_at_entry","current_price","current_delta","current_gamma",
                "current_theta","current_vega","current_iv","status","close_price",
                "closed_at","created_at"]

    now = datetime.now(UTC).isoformat()
    total_proceeds = 0.0
    total_commission = 0.0

    for leg_row in legs:
        leg = dict(zip(leg_cols, leg_row))
        ticker = leg["ticker"]
        expiry = leg["expiry"]
        strike = leg["strike"]
        is_call = leg["option_type"] == "call"
        quantity = leg["quantity"]
        original_action = leg["action"]

        # Fetch current chain for close price
        current_underlying = None
        try:
            chain = fetch_options_chain(ticker, expiry)
            current_underlying = chain.get("underlying")
            contracts = chain["calls"] if is_call else chain["puts"]
            match = next((c for c in contracts if abs(c["strike"] - strike) < 0.001), None)
            close_action = "SELL" if original_action == "BUY" else "BUY"
            if match:
                close_price = simulate_fill(
                    match.get("bid"), match.get("ask"), close_action,
                )
                # bid/ask both zero (yfinance stale) — fall back to mid (lastPrice proxy)
                if close_price == 0:
                    mid_fallback = match.get("mid") or 0.0
                    if mid_fallback > 0:
                        close_price = mid_fallback
                    else:
                        # Last resort: BS price from current underlying + IV estimate
                        S = chain.get("underlying") or 0
                        T = _dte_years(expiry)
                        iv = (match.get("iv") or 30.0) / 100.0
                        if S > 0 and T > 0:
                            close_price = bs_price(S, strike, T, RISK_FREE_RATE, iv, is_call)
            else:
                close_price = leg["current_price"] or leg["fill_price"]
        except Exception:
            close_price = leg["current_price"] or leg["fill_price"]

        # Don't charge commission on an option that closes at $0 (expired worthless)
        commission = 0.0 if close_price == 0 else COMMISSION_PER_CONTRACT * quantity
        proceeds = close_price * MULTIPLIER * quantity - commission
        total_proceeds += proceeds
        total_commission += commission

        await db.execute(
            "UPDATE options_legs SET status = 'CLOSED', close_price = ?, closed_at = ? WHERE id = ?",
            (close_price, now, leg["id"]),
        )
        await db.execute(
            "INSERT INTO options_transactions "
            "(position_id, leg_id, tx_type, ticker, expiry, strike, option_type, action, "
            "quantity, fill_price, premium_total, commission, net_cash_impact, underlying_price, created_at) "
            "VALUES (?, ?, 'CLOSE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (position_id, leg["id"], ticker, expiry, strike, leg["option_type"],
             original_action, quantity, close_price, close_price * MULTIPLIER * quantity,
             commission, proceeds, current_underlying, now),
        )

    realized = total_proceeds - pos_dict["total_cost"]
    await db.execute(
        "UPDATE options_positions SET status = 'CLOSED', close_date = ?, total_proceeds = ?, "
        "realized_pnl = ?, unrealized_pnl = 0.0 WHERE id = ?",
        (now, total_proceeds, realized, position_id),
    )
    await db.execute(
        "UPDATE options_account SET cash = cash + ?, realized_pnl = realized_pnl + ?, "
        "total_commissions = total_commissions + ?, updated_at = ? WHERE id = 1",
        (total_proceeds, realized, total_commission, now),
    )
    await db.commit()
    return {"position_id": position_id, "realized_pnl": round(realized, 2),
            "total_proceeds": round(total_proceeds, 2)}


# ── Revaluation (scheduler job) ───────────────────────────────────────────────

async def revalue_all_positions(db: aiosqlite.Connection) -> dict:
    """
    Mark-to-market all open legs using current yfinance prices + BS Greeks.
    Called every 15 min during market hours by APScheduler.
    """
    async with db.execute(
        "SELECT id FROM options_positions WHERE status = 'OPEN'"
    ) as cur:
        pos_ids = [r[0] for r in await cur.fetchall()]

    updated = 0
    errors = 0
    now = datetime.now(UTC).isoformat()

    for pos_id in pos_ids:
        async with db.execute(
            "SELECT * FROM options_legs WHERE position_id = ? AND status = 'OPEN'", (pos_id,)
        ) as cur:
            legs = await cur.fetchall()

        leg_cols = ["id","position_id","ticker","expiry","strike","option_type","action",
                    "quantity","fill_price","commission","iv_at_entry","delta_at_entry",
                    "gamma_at_entry","theta_at_entry","vega_at_entry","rho_at_entry",
                    "underlying_at_entry","current_price","current_delta","current_gamma",
                    "current_theta","current_vega","current_iv","status","close_price",
                    "closed_at","created_at"]

        pos_unrealized = 0.0
        for leg_row in legs:
            leg = dict(zip(leg_cols, leg_row))
            try:
                chain = fetch_options_chain(leg["ticker"], leg["expiry"])
                contracts = chain["calls"] if leg["option_type"] == "call" else chain["puts"]
                match = next(
                    (c for c in contracts if abs(c["strike"] - leg["strike"]) < 0.001), None
                )
                if match:
                    S = chain["underlying"]
                    T = _dte_years(leg["expiry"])
                    iv = (match.get("iv") or 30.0) / 100.0
                    is_call = leg["option_type"] == "call"
                    greeks = bs_greeks(S, leg["strike"], T, RISK_FREE_RATE, iv, is_call)

                    # Prefer BS price over stale lastPrice — BS uses current underlying
                    # so it correctly captures time decay and price moves, unlike yfinance
                    # lastPrice which may be days old.
                    bs_val = bs_price(S, leg["strike"], T, RISK_FREE_RATE, iv, is_call) if T > 0 else None
                    market_mid = match.get("bid") and match.get("ask") and (match["bid"] + match["ask"]) / 2
                    if market_mid and market_mid > 0:
                        curr_price = market_mid          # live bid/ask available — most accurate
                    elif bs_val and bs_val > 0:
                        curr_price = bs_val              # BS from current underlying — better than stale lastPrice
                    else:
                        curr_price = match.get("lastPrice") or leg["current_price"]

                    sign = 1 if leg["action"] == "BUY" else -1
                    unrealized = sign * (curr_price - leg["fill_price"]) * MULTIPLIER * leg["quantity"]
                    pos_unrealized += unrealized

                    await db.execute(
                        """UPDATE options_legs SET
                           current_price = ?, current_iv = ?, current_delta = ?,
                           current_gamma = ?, current_theta = ?, current_vega = ?
                           WHERE id = ?""",
                        (curr_price, match.get("iv"), greeks["delta"], greeks["gamma"],
                         greeks["theta"], greeks["vega"], leg["id"]),
                    )
                    # Greeks history
                    await db.execute(
                        """INSERT INTO options_greeks_history
                           (leg_id, snapshot_at, underlying_price, option_price,
                            delta, gamma, theta, vega, rho, iv, days_to_expiry, unrealized_pnl)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (leg["id"], now, S, curr_price,
                         greeks["delta"], greeks["gamma"], greeks["theta"],
                         greeks["vega"], greeks["rho"],
                         match.get("iv"), _dte(leg["expiry"]), unrealized),
                    )
                    updated += 1
            except Exception as e:
                log.warning("revalue leg %d: %s", leg["id"], e)
                errors += 1

        await db.execute(
            "UPDATE options_positions SET unrealized_pnl = ?, last_revalued_at = ? WHERE id = ?",
            (round(pos_unrealized, 2), now, pos_id),
        )

    # Portfolio-level Greeks snapshot
    await _save_risk_snapshot(db, now)
    await db.commit()
    return {"updated_legs": updated, "errors": errors, "timestamp": now}


async def _save_risk_snapshot(db: aiosqlite.Connection, now: str):
    async with db.execute(
        "SELECT COALESCE(SUM(current_delta * quantity), 0), COALESCE(SUM(current_gamma * quantity), 0), "
        "COALESCE(SUM(current_theta * quantity), 0), COALESCE(SUM(current_vega * quantity), 0) "
        "FROM options_legs WHERE status = 'OPEN'"
    ) as cur:
        row = await cur.fetchone()
    nd, ng, nt, nv = (float(x or 0) for x in row)

    async with db.execute(
        "SELECT COALESCE(SUM(unrealized_pnl), 0) FROM options_positions WHERE status = 'OPEN'"
    ) as cur:
        (unreal,) = await cur.fetchone()

    async with db.execute(
        "SELECT cash, realized_pnl FROM options_account WHERE id = 1"
    ) as cur:
        acct_row = await cur.fetchone()
    cash, realized = (float(x or 0) for x in (acct_row or (10000, 0)))

    # Use market value of open legs (not unrealized P&L change) for correct net_liq
    async with db.execute(
        """SELECT COALESCE(SUM(
               CASE WHEN l.action = 'BUY' THEN 1 ELSE -1 END *
               COALESCE(l.current_price, l.fill_price) * 100 * l.quantity
           ), 0)
           FROM options_legs l
           JOIN options_positions p ON l.position_id = p.id
           WHERE p.status = 'OPEN' AND l.status = 'OPEN'"""
    ) as cur:
        (mkt_value,) = await cur.fetchone()

    async with db.execute(
        "SELECT COUNT(*) FROM options_positions WHERE status = 'OPEN'"
    ) as cur:
        (cnt,) = await cur.fetchone()

    net_liq = cash + float(mkt_value or 0)
    await db.execute(
        """INSERT INTO options_risk_snapshots
           (snapshot_at, net_delta, net_gamma, net_theta, net_vega, net_rho,
            total_unrealized_pnl, total_realized_pnl, open_position_count, cash, net_liq)
           VALUES (?, ?, ?, ?, ?, 0.0, ?, ?, ?, ?, ?)""",
        (now, nd, ng, nt, nv, float(unreal or 0), realized, int(cnt), cash, net_liq),
    )


# ── Positions list ────────────────────────────────────────────────────────────

async def list_positions(db: aiosqlite.Connection, status: str = "OPEN") -> list[dict]:
    async with db.execute(
        "SELECT * FROM options_positions WHERE status = ? ORDER BY open_date DESC", (status,)
    ) as cur:
        rows = await cur.fetchall()
    cols = ["id","ticker","strategy_label","status","open_date","close_date",
            "total_cost","total_proceeds","realized_pnl","unrealized_pnl",
            "last_revalued_at","trade_notes_id","created_at"]

    result = []
    for row in rows:
        pos = dict(zip(cols, row))
        # Attach legs
        async with db.execute(
            "SELECT * FROM options_legs WHERE position_id = ?", (pos["id"],)
        ) as lcur:
            leg_rows = await lcur.fetchall()
        leg_cols = ["id","position_id","ticker","expiry","strike","option_type","action",
                    "quantity","fill_price","commission","iv_at_entry","delta_at_entry",
                    "gamma_at_entry","theta_at_entry","vega_at_entry","rho_at_entry",
                    "underlying_at_entry","current_price","current_delta","current_gamma",
                    "current_theta","current_vega","current_iv","status","close_price",
                    "closed_at","created_at"]
        pos["legs"] = [dict(zip(leg_cols, lr)) for lr in leg_rows]
        result.append(pos)
    return result


# ── Scenario P&L (pass-through with DB context) ──────────────────────────────

async def get_scenario_pnl(
    leg_id: int,
    db: aiosqlite.Connection,
    price_range_pct: float = 0.20,
    steps: int = 11,
) -> list[dict]:
    leg_cols = ["id","position_id","ticker","expiry","strike","option_type","action",
                "quantity","fill_price","commission","iv_at_entry","delta_at_entry",
                "gamma_at_entry","theta_at_entry","vega_at_entry","rho_at_entry",
                "underlying_at_entry","current_price","current_delta","current_gamma",
                "current_theta","current_vega","current_iv","status","close_price",
                "closed_at","created_at"]
    async with db.execute("SELECT * FROM options_legs WHERE id = ?", (leg_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise ValueError(f"Leg {leg_id} not found")
    leg = dict(zip(leg_cols, row))

    S0 = leg["underlying_at_entry"] or leg["fill_price"]
    K  = leg["strike"]
    T  = _dte_years(leg["expiry"])
    iv = (leg["current_iv"] or leg["iv_at_entry"] or 30.0) / 100.0
    is_call = leg["option_type"] == "call"
    action = leg["action"]
    fill = leg["fill_price"]
    qty = leg["quantity"]

    return _scenario_pnl(S0, K, T, RISK_FREE_RATE, iv, is_call, action, fill, qty,
                         price_range_pct, steps)


# ── Multi-leg position ────────────────────────────────────────────────────────

async def open_multi_leg_position(
    db: aiosqlite.Connection,
    ticker: str,
    expiry: str,
    strategy_label: str,
    legs_spec: list[dict],  # [{strike, option_type, action, quantity}, ...]
    note: str = "",
) -> dict:
    """
    Execute a multi-leg strategy atomically (spreads, straddles, strangles).
    All legs must be on the same underlying and expiry.
    """
    acct = await ensure_account(db)

    # Fetch chain once for all legs
    chain = fetch_options_chain(ticker.upper(), expiry)
    S = chain["underlying"]
    T = _dte_years(expiry)

    total_cost = 0.0
    total_commission = 0.0
    leg_details = []

    for spec in legs_spec:
        strike = float(spec["strike"])
        is_call = spec["option_type"].lower() == "call"
        action = spec["action"].upper()
        quantity = int(spec.get("quantity", 1))

        contracts = chain["calls"] if is_call else chain["puts"]
        match = next((c for c in contracts if abs(c["strike"] - strike) < 0.001), None)
        if match is None:
            raise ValueError(f"Strike {strike} not found for {ticker} {expiry} {spec['option_type']}")

        bid = match.get("bid")
        ask = match.get("ask")
        fill = simulate_fill(bid, ask, action)
        if fill <= 0:
            raise ValueError(f"Zero fill for {ticker} {strike} {spec['option_type']}")

        commission = COMMISSION_PER_CONTRACT * quantity
        leg_cost = fill * MULTIPLIER * quantity if action == "BUY" else -fill * MULTIPLIER * quantity
        leg_cost += commission
        total_cost += leg_cost
        total_commission += commission

        iv = (match.get("iv") or 30.0) / 100.0
        greeks = bs_greeks(S, strike, T, RISK_FREE_RATE, iv, is_call)

        leg_details.append({
            "strike": strike, "option_type": spec["option_type"].lower(),
            "action": action, "quantity": quantity,
            "fill_price": fill, "commission": commission, "leg_cost": leg_cost,
            "bid": bid, "ask": ask, "iv_pct": match.get("iv"),
            "greeks": greeks, "S": S,
        })

    if total_cost > 0 and acct["cash"] < total_cost:
        raise ValueError(
            f"Insufficient cash: need ${total_cost:.2f}, have ${acct['cash']:.2f}"
        )

    now = datetime.now(UTC).isoformat()
    new_cash = acct["cash"] - total_cost

    await db.execute(
        "UPDATE options_account SET cash = ?, total_commissions = total_commissions + ?, updated_at = ? WHERE id = 1",
        (new_cash, total_commission, now),
    )

    await db.execute(
        "INSERT INTO options_positions (ticker, strategy_label, status, open_date, total_cost, unrealized_pnl, last_revalued_at) "
        "VALUES (?, ?, 'OPEN', ?, ?, 0.0, ?)",
        (ticker.upper(), strategy_label, now, total_cost, now),
    )
    async with db.execute("SELECT last_insert_rowid()") as cur:
        (pos_id,) = await cur.fetchone()

    leg_ids = []
    for ld in leg_details:
        g = ld["greeks"]
        await db.execute(
            """INSERT INTO options_legs
               (position_id, ticker, expiry, strike, option_type, action, quantity,
                fill_price, commission, iv_at_entry, delta_at_entry, gamma_at_entry,
                theta_at_entry, vega_at_entry, rho_at_entry, underlying_at_entry,
                current_price, current_delta, current_gamma, current_theta, current_vega,
                current_iv, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')""",
            (
                pos_id, ticker.upper(), expiry, ld["strike"], ld["option_type"],
                ld["action"], ld["quantity"], ld["fill_price"], ld["commission"],
                ld.get("iv_pct"), g.get("delta"), g.get("gamma"), g.get("theta"),
                g.get("vega"), g.get("rho"), ld["S"],
                ld["fill_price"], g.get("delta"), g.get("gamma"), g.get("theta"), g.get("vega"),
                ld.get("iv_pct"),
            ),
        )
        async with db.execute("SELECT last_insert_rowid()") as cur:
            (leg_id,) = await cur.fetchone()
        leg_ids.append(leg_id)

        await db.execute(
            "INSERT INTO options_transactions "
            "(position_id, leg_id, tx_type, ticker, expiry, strike, option_type, action, "
            "quantity, fill_price, premium_total, commission, net_cash_impact, underlying_price, iv_at_fill, created_at) "
            "VALUES (?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (pos_id, leg_id, "OPEN", ticker.upper(), expiry, ld["strike"], ld["option_type"],
             ld["action"], ld["quantity"], ld["fill_price"],
             ld["fill_price"] * MULTIPLIER * ld["quantity"],
             ld["commission"], -ld["leg_cost"], ld["S"], ld.get("iv_pct"), now),
        )

    if note:
        await db.execute(
            "INSERT INTO options_trade_notes (position_id, thesis) VALUES (?, ?)", (pos_id, note)
        )

    await db.commit()
    return {
        "position_id": pos_id,
        "leg_ids": leg_ids,
        "strategy_label": strategy_label,
        "total_cost": round(total_cost, 2),
        "total_commission": round(total_commission, 2),
        "cash_remaining": round(new_cash, 2),
        "legs": len(leg_details),
    }


# ── Position alerts ───────────────────────────────────────────────────────────

async def get_position_alerts(db: aiosqlite.Connection) -> list[dict]:
    """
    Check all open positions for actionable alerts:
    - DTE ≤ 7 (approaching expiry)
    - DTE ≤ 21 (time-decay accelerating — heads-up)
    - Unrealized loss ≥ 50% of cost
    - Unrealized gain ≥ 100% of cost (double — consider taking profit)
    - Theta draining > 5% of cost per day
    """
    positions = await list_positions(db, "OPEN")
    alerts = []
    for pos in positions:
        for leg in pos.get("legs", []):
            if leg["status"] != "OPEN":
                continue
            dte = _dte(leg["expiry"])
            cost = abs(pos["total_cost"])

            if dte <= 7:
                alerts.append({
                    "position_id": pos["id"],
                    "ticker": pos["ticker"],
                    "level": "danger",
                    "type": "expiry",
                    "message": f"{pos['ticker']} {leg['strike']} {leg['option_type'].upper()} expires in {dte} day{'s' if dte != 1 else ''} — consider closing or rolling.",
                })
            elif dte <= 21:
                alerts.append({
                    "position_id": pos["id"],
                    "ticker": pos["ticker"],
                    "level": "warning",
                    "type": "expiry",
                    "message": f"{pos['ticker']} {leg['strike']} {leg['option_type'].upper()} has {dte} DTE — theta decay accelerating.",
                })

            unreal = pos.get("unrealized_pnl") or 0
            if cost > 0:
                pnl_pct = unreal / cost * 100
                if pnl_pct <= -50:
                    alerts.append({
                        "position_id": pos["id"],
                        "ticker": pos["ticker"],
                        "level": "danger",
                        "type": "loss",
                        "message": f"{pos['ticker']} position down {pnl_pct:.0f}% (${unreal:.0f}). Consider cutting the loss.",
                    })
                elif pnl_pct >= 100:
                    alerts.append({
                        "position_id": pos["id"],
                        "ticker": pos["ticker"],
                        "level": "info",
                        "type": "profit",
                        "message": f"{pos['ticker']} position up {pnl_pct:.0f}% (${unreal:.0f}). Consider taking profit.",
                    })

            theta = leg.get("current_theta") or leg.get("theta_at_entry")
            if theta and cost > 0:
                daily_theta_pct = abs(theta) * MULTIPLIER * leg["quantity"] / cost * 100
                if daily_theta_pct > 5:
                    alerts.append({
                        "position_id": pos["id"],
                        "ticker": pos["ticker"],
                        "level": "warning",
                        "type": "theta",
                        "message": f"{pos['ticker']} burning ${abs(theta)*MULTIPLIER*leg['quantity']:.2f}/day in theta ({daily_theta_pct:.1f}% of cost).",
                    })

    return alerts


# ── Equity curve (performance over time) ────────────────────────────────────

async def get_performance_curve(db: aiosqlite.Connection, days: int = 30) -> list[dict]:
    """Return daily net_liq snapshots for the equity curve chart."""
    async with db.execute(
        """SELECT date(snapshot_at) as day,
                  AVG(net_liq) as net_liq,
                  AVG(total_unrealized_pnl) as unrealized,
                  AVG(total_realized_pnl) as realized,
                  MAX(snapshot_at) as last_snap
           FROM options_risk_snapshots
           WHERE snapshot_at >= datetime('now', ?)
           GROUP BY date(snapshot_at)
           ORDER BY day""",
        (f"-{days} days",),
    ) as cur:
        rows = await cur.fetchall()
    return [
        {
            "date": r[0], "net_liq": round(float(r[1] or 10000), 2),
            "unrealized": round(float(r[2] or 0), 2),
            "realized": round(float(r[3] or 0), 2),
        }
        for r in rows
    ]
