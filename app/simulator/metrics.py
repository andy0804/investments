"""
app/simulator/metrics.py

Compute all strategy performance metrics from portfolio value series + trade log.
All metrics are risk-adjusted. Composite score uses weighted normalization.
"""
import math
from typing import Optional


def compute_metrics(
    portfolio_values: list[tuple],
    trades: list[dict],
    initial_capital: float = 10000.0,
    regime_by_date: Optional[dict] = None,
) -> dict:
    """
    Args:
        portfolio_values: [(date_str, total_value), ...] sorted ascending
        trades: list of trade dicts with action, return_pct, date fields
        initial_capital: starting cash
        regime_by_date: {date_str: 'BULL'|'BEAR'|'CHOP'} for regime breakdown

    Returns full metrics dict.
    """
    if not portfolio_values:
        return _empty_metrics(initial_capital)

    dates = [pv[0] for pv in portfolio_values]
    values = [pv[1] for pv in portfolio_values]
    n_days = len(values)
    final_value = values[-1]

    # ── 1. Total Return ──────────────────────────────────────────────────────
    total_return_pct = round((final_value / initial_capital - 1) * 100, 2)

    # ── 2. CAGR ──────────────────────────────────────────────────────────────
    trading_days = max(n_days, 1)
    cagr_pct = round(((final_value / initial_capital) ** (252 / trading_days) - 1) * 100, 2)

    # ── 3. Daily returns ─────────────────────────────────────────────────────
    daily_returns = []
    for i in range(1, len(values)):
        if values[i - 1] > 0:
            daily_returns.append((values[i] / values[i - 1]) - 1)
        else:
            daily_returns.append(0.0)

    # ── 4. Volatility (annualized) ───────────────────────────────────────────
    vol_pct = 0.0
    if len(daily_returns) > 1:
        mean_r = sum(daily_returns) / len(daily_returns)
        variance = sum((r - mean_r) ** 2 for r in daily_returns) / (len(daily_returns) - 1)
        vol_pct = round(math.sqrt(variance) * math.sqrt(252) * 100, 2)

    # ── 5. Sharpe Ratio ──────────────────────────────────────────────────────
    sharpe = 0.0
    if vol_pct > 0 and daily_returns:
        mean_daily = sum(daily_returns) / len(daily_returns)
        std_daily  = math.sqrt(sum((r - mean_daily) ** 2 for r in daily_returns) / len(daily_returns))
        sharpe = round((mean_daily / std_daily) * math.sqrt(252), 3) if std_daily > 0 else 0.0

    # ── 6. Max Drawdown ──────────────────────────────────────────────────────
    max_dd_pct = 0.0
    peak = values[0]
    for v in values:
        if v > peak:
            peak = v
        dd = (peak - v) / peak if peak > 0 else 0
        if dd > max_dd_pct:
            max_dd_pct = dd
    max_dd_pct = round(max_dd_pct * 100, 2)

    # ── 7. Trade-level metrics ───────────────────────────────────────────────
    sell_trades = [t for t in trades if t.get("action") == "SELL"]
    total_trades = len(sell_trades)
    wins = [t for t in sell_trades if t.get("return_pct", 0) > 0]
    losses = [t for t in sell_trades if t.get("return_pct", 0) <= 0]

    win_rate_pct = round(len(wins) / total_trades * 100, 1) if total_trades > 0 else 0.0

    total_gain = sum(t.get("return_pct", 0) for t in wins)
    total_loss = abs(sum(t.get("return_pct", 0) for t in losses))
    profit_factor = round(total_gain / total_loss, 3) if total_loss > 0 else (999.0 if total_gain > 0 else 0.0)

    avg_trade_return = round(
        sum(t.get("return_pct", 0) for t in sell_trades) / total_trades, 2
    ) if total_trades > 0 else 0.0

    trade_frequency = round(total_trades / (trading_days / 30), 2) if trading_days > 0 else 0.0

    # ── 8. Regime breakdown ──────────────────────────────────────────────────
    regime_breakdown = {}
    if regime_by_date:
        regime_breakdown = _compute_regime_breakdown(
            portfolio_values, sell_trades, regime_by_date, initial_capital
        )

    return {
        "total_return_pct":    total_return_pct,
        "cagr_pct":            cagr_pct,
        "volatility_pct":      vol_pct,
        "sharpe":              sharpe,
        "max_drawdown_pct":    max_dd_pct,
        "win_rate_pct":        win_rate_pct,
        "profit_factor":       profit_factor,
        "avg_trade_return_pct": avg_trade_return,
        "trade_frequency":     trade_frequency,
        "total_trades":        total_trades,
        "winning_trades":      len(wins),
        "losing_trades":       len(losses),
        "initial_capital":     initial_capital,
        "final_value":         round(final_value, 2),
        "regime_breakdown":    regime_breakdown,
    }


def _compute_regime_breakdown(
    portfolio_values: list[tuple],
    sell_trades: list[dict],
    regime_by_date: dict,
    initial_capital: float,
) -> dict:
    """Compute win rate and avg return segmented by BULL/BEAR/CHOP."""
    breakdown: dict = {}
    pv_by_date = {pv[0]: pv[1] for pv in portfolio_values}

    for regime in ("BULL", "BEAR", "CHOP"):
        regime_trades = [t for t in sell_trades if regime_by_date.get(t.get("date", ""), "") == regime]
        if not regime_trades:
            breakdown[regime] = {"trades": 0, "win_rate_pct": 0.0, "avg_return_pct": 0.0}
            continue
        wins = [t for t in regime_trades if t.get("return_pct", 0) > 0]
        breakdown[regime] = {
            "trades":          len(regime_trades),
            "win_rate_pct":    round(len(wins) / len(regime_trades) * 100, 1),
            "avg_return_pct":  round(sum(t.get("return_pct", 0) for t in regime_trades) / len(regime_trades), 2),
        }
    return breakdown


def _empty_metrics(initial_capital: float) -> dict:
    return {
        "total_return_pct": 0.0, "cagr_pct": 0.0, "volatility_pct": 0.0,
        "sharpe": 0.0, "max_drawdown_pct": 0.0, "win_rate_pct": 0.0,
        "profit_factor": 0.0, "avg_trade_return_pct": 0.0, "trade_frequency": 0.0,
        "total_trades": 0, "winning_trades": 0, "losing_trades": 0,
        "initial_capital": initial_capital, "final_value": initial_capital,
        "regime_breakdown": {},
    }


def compute_composite_scores(results: list[dict]) -> list[dict]:
    """
    Normalize metrics across all strategies, compute composite score, assign ranks.
    Mutates and returns results list with 'composite_score' and 'rank' fields.

    Score = 0.30 * norm_sharpe
          + 0.20 * norm_return
          + 0.20 * (1 - norm_drawdown)
          + 0.15 * norm_profit_factor
          + 0.15 * norm_win_rate
    """
    if not results:
        return results

    def _norm(values: list[float]) -> list[float]:
        mn, mx = min(values), max(values)
        if mx == mn:
            return [0.5] * len(values)
        return [(v - mn) / (mx - mn) for v in values]

    sharpes  = [r["metrics"]["sharpe"]            for r in results]
    returns  = [r["metrics"]["total_return_pct"]  for r in results]
    ddowns   = [r["metrics"]["max_drawdown_pct"]  for r in results]
    pfs      = [r["metrics"]["profit_factor"]     for r in results]
    wrs      = [r["metrics"]["win_rate_pct"]       for r in results]

    # Cap profit_factor at 10 to avoid outlier dominance
    pfs_capped = [min(pf, 10.0) for pf in pfs]

    ns = _norm(sharpes)
    nr = _norm(returns)
    nd = _norm(ddowns)
    np_ = _norm(pfs_capped)
    nw = _norm(wrs)

    for i, r in enumerate(results):
        score = (0.30 * ns[i] + 0.20 * nr[i] + 0.20 * (1 - nd[i]) + 0.15 * np_[i] + 0.15 * nw[i])
        r["composite_score"] = round(score, 4)

    results.sort(key=lambda x: x["composite_score"], reverse=True)
    for rank, r in enumerate(results, 1):
        r["rank"] = rank

    return results


def compute_stability_score(returns_across_seeds: list[float]) -> float:
    """stability = 1 / (1 + std_dev_returns). Used for multi-seed aggregation."""
    if len(returns_across_seeds) < 2:
        return 1.0
    mean = sum(returns_across_seeds) / len(returns_across_seeds)
    std = math.sqrt(sum((r - mean) ** 2 for r in returns_across_seeds) / len(returns_across_seeds))
    return round(1 / (1 + std), 4)
