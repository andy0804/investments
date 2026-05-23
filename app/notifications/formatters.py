from datetime import datetime


def _safe(text: str, max_len: int = 300) -> str:
    """Strip Markdown special chars that break Telegram ParseMode.MARKDOWN."""
    for ch in ['_', '*', '`', '[', ']']:
        text = text.replace(ch, '')
    return text[:max_len]


def fmt_morning_brief(brief: dict) -> str:
    health_emoji = {"good": "✅", "caution": "⚠️", "warning": "🚨"}.get(
        brief.get("portfolio_health", "good"), "📊"
    )
    watches = "\n".join(f"• {w}" for w in brief.get("key_watches", [])[:3])
    actions = "\n".join(f"• {a}" for a in brief.get("immediate_actions", [])[:2])

    msg = (
        f"*Morning Brief — {datetime.now().strftime('%a %b %d')}*\n"
        f"{health_emoji} _{brief.get('headline', 'Portfolio update')}_\n\n"
        f"{brief.get('market_context', '')}\n\n"
    )
    if watches:
        msg += f"*Watch today:*\n{watches}\n\n"
    if actions:
        msg += f"*Actions:*\n{actions}\n\n"
    msg += "Reply /positions for full holdings"
    return msg[:4096]


def fmt_signal_alert(signal: dict) -> str:
    sym = signal.get("symbol", "?")
    score = signal.get("score", 5)
    sig_type = signal.get("signal", "watch").upper()
    score_bar = "█" * score + "░" * (10 - score)

    return (
        f"*Signal: {sym}* — {sig_type}\n"
        f"Score: [{score_bar}] {score}/10\n"
        f"_{signal.get('reasoning', '')[:200]}_\n\n"
        f"Action: {signal.get('suggested_action', 'Monitor')}\n\n"
        f"Reply /analyse {sym} for deep dive"
    )[:4096]


def fmt_stop_trigger(symbol: str, gain_pct: float, cost_basis: float, live_price: float) -> str:
    return (
        f"🚨 *STOP LOSS — {symbol}*\n"
        f"Down {abs(gain_pct):.1f}% from cost basis\n"
        f"Cost basis: ${cost_basis:.2f} | Live: ${live_price:.2f}\n\n"
        f"Your −8% stop threshold has been hit.\n"
        f"Reply /analyse {symbol} for full analysis"
    )[:4096]


def fmt_target_hit(symbol: str, gain_pct: float, target_num: int) -> str:
    return (
        f"🎯 *TARGET {target_num} HIT — {symbol}*\n"
        f"Up {gain_pct:.1f}% from your cost basis\n\n"
        f"Consider taking partial profits or tightening your stop.\n"
        f"Reply /analyse {symbol} for deep dive"
    )[:4096]


def fmt_earnings_prep(prep: dict) -> str:
    sym = prep.get("symbol", "?")
    dt = prep.get("earnings_date", "upcoming")
    risk = prep.get("risk_level", "medium")
    risk_label = {"low": "🟢 Low", "medium": "🟡 Medium", "high": "🔴 High"}.get(risk, risk)

    metrics = "\n".join(f"• {m}" for m in prep.get("key_metrics_to_watch", [])[:3])
    return (
        f"*Earnings Prep — {sym}*\n"
        f"Date: {dt} | Risk: {risk_label}\n\n"
        f"_{prep.get('summary', '')[:200]}_\n\n"
        f"*Watch:*\n{metrics}\n\n"
        f"Reply /analyse {sym} for full analysis"
    )[:4096]


def fmt_event_alert(event: dict, analysis: dict) -> str:
    impact = analysis.get("impact", "neutral")
    emoji = {"positive": "📈", "negative": "📉", "neutral": "ℹ️", "uncertain": "❓"}.get(impact, "ℹ️")
    affected = ", ".join(analysis.get("affected_holdings", [])[:3])

    return (
        f"{emoji} *Market Event*\n"
        f"_{event.get('title', 'Unknown event')[:150]}_\n\n"
        f"{analysis.get('explanation', '')[:200]}\n\n"
        f"Holdings affected: {affected or 'None directly'}\n"
        f"Reply /event for full feed"
    )[:4096]


def fmt_ytd_coach(coaching: dict) -> str:
    grade = coaching.get("portfolio_grade", "B")
    return (
        f"*Weekly Portfolio Review*\n"
        f"Grade: *{grade}*\n\n"
        f"_{coaching.get('coaching_message', '')[:300]}_\n\n"
        f"Reply /coach for full report"
    )[:4096]


def fmt_sotd_telegram(result: dict) -> str:
    """
    Full SOTD alert matching the dashboard output.
    Uses the direct output of run_sotd_pipeline().
    """
    sotd = result.get("stock_of_the_day") or {}
    mkt  = result.get("market_context") or {}

    if not sotd:
        return f"*SOTD Pipeline* — No pick today\nReason: {result.get('no_trade_reason', 'unknown')}"

    tier   = sotd.get("tier", "Best Available")
    ticker = sotd.get("ticker", "?")
    score  = sotd.get("confidence_score", 0)
    regime = mkt.get("regime", "CHOP")
    vix    = mkt.get("vix", "—")
    spy    = mkt.get("spy_10d", 0)
    spy_s  = f"{spy:+.1f}%"

    tier_icon = "🟢" if tier == "Stock of the Day" else "🟡" if tier == "Watchlist Candidate" else "🔵"
    sig_type  = (sotd.get("signal_type") or "momentum").upper()

    # Header
    lines = [
        f"{tier_icon} *{tier}: {ticker}*",
        f"_{_safe(sotd.get('company_name', ''), 60)}_",
        f"{_safe(sotd.get('sector', ''), 40)}",
        "",
        f"Score: *{score}/100* | {regime} | VIX {vix} | SPY {spy_s}",
        f"Signal: {sig_type}",
        "",
    ]

    # Summary (the LLM rationale — most important part)
    summary = _safe(sotd.get("summary", ""), 400)
    if summary:
        lines += [f"_{summary}_", ""]

    # Score breakdown
    bd = sotd.get("score_breakdown") or {}
    if bd:
        lines += [
            "*Score Breakdown*",
            f"Momentum {bd.get('momentum',0)}/25  |  Volume {bd.get('volume',0)}/20",
            f"Setup {bd.get('setup',0)}/19  |  Market {bd.get('market',0)}/15  |  Conv {bd.get('conviction',0)}/10",
        ]
        if bd.get("penalty", 0) != 0:
            lines.append(f"Penalty: {bd['penalty']}")
        lines.append("")

    # Key drivers
    drivers = sotd.get("key_drivers") or []
    if drivers:
        lines.append("*Why Selected*")
        for d in drivers[:4]:
            lines.append(f"+ {_safe(d, 120)}")
        lines.append("")

    # Risk factors
    risks = sotd.get("risk_factors") or []
    if risks:
        lines.append("*Risk Factors*")
        for r in risks[:3]:
            lines.append(f"! {_safe(r, 120)}")
        lines.append("")

    # Other considered (top 3 from all_candidates)
    others = sorted(
        [c for c in result.get("all_candidates", [])
         if c.get("passed_filter") and c.get("ticker") != ticker],
        key=lambda x: -(x.get("score") or 0)
    )[:3]
    if others:
        others_str = "  ".join(f"{c['ticker']} ({c.get('score','?')})" for c in others)
        lines.append(f"_Also considered: {others_str}_")
        lines.append("")

    lines.append(f"Generated {result.get('generated_at','')[:16].replace('T',' ')} UTC")

    return "\n".join(lines)[:4096]


def fmt_portfolio_intelligence_telegram(data: dict) -> str:
    """
    Portfolio intelligence brief for Telegram.
    Uses the direct output of generate_portfolio_intelligence().
    """
    if data.get("error"):
        return f"*Portfolio Intelligence*\n_{data['error']}_"

    intel   = data.get("intelligence") or {}
    regime  = data.get("regime", "CHOP")
    value   = data.get("portfolio_value", 0)
    ret_pct = data.get("portfolio_return_pct", 0)
    spy_ret = data.get("spy_10d_return", 0)
    alpha   = round(ret_pct - spy_ret, 1)

    ret_icon   = "📈" if ret_pct >= 0 else "📉"
    alpha_icon = "✅" if alpha >= 0 else "⚠️"

    lines = [
        f"💼 *Portfolio Intelligence — {datetime.now().strftime('%a %b %d')}*",
        f"Regime: *{regime}* | Value: *${value:,.0f}*",
        f"{ret_icon} Return: {ret_pct:+.1f}%  |  {alpha_icon} Alpha vs SPY: {alpha:+.1f}%",
        "",
    ]

    # AI summary
    summary = _safe(intel.get("summary", ""), 350)
    if summary:
        lines += [f"_{summary}_", ""]

    # Action suggestions (max 4)
    actions = intel.get("action_suggestions") or []
    if actions:
        lines.append("*Actions*")
        action_icons = {"trim": "✂️", "hold": "🔒", "review": "🔍", "watch": "👁"}
        for s in actions[:4]:
            icon = action_icons.get(s.get("action",""), "•")
            lines.append(f"{icon} *{s.get('type') or s.get('action','?').upper()}* {s.get('symbol','')} — {_safe(s.get('reason',''), 100)}")
        lines.append("")

    # Risk flags
    flags = intel.get("risk_flags") or []
    if flags:
        lines.append("*Risk Flags*")
        for f in flags[:3]:
            lines.append(f"⚠️ {_safe(f, 120)}")
        lines.append("")

    # Top contributors / detractors
    perf = data.get("performance_attribution") or {}
    contribs = perf.get("top_contributors") or []
    detractors = perf.get("top_detractors") or []
    if contribs:
        c_str = "  ".join(f"{h['symbol']} ({h.get('total_gain_loss_pct',0):+.1f}%)" for h in contribs[:3])
        lines.append(f"🟢 Top: {c_str}")
    if detractors:
        d_str = "  ".join(f"{h['symbol']} ({h.get('total_gain_loss_pct',0):+.1f}%)" for h in detractors[:3])
        lines.append(f"🔴 Lagging: {d_str}")

    return "\n".join(lines)[:4096]


def fmt_regime_shift(old_regime: str, new_regime: str, mkt: dict) -> str:
    icons = {"BULL": "📈", "BEAR": "📉", "CHOP": "↔️"}
    vix   = mkt.get("vix", "—")
    spy   = mkt.get("spy_10d", 0)
    return (
        f"🔄 *REGIME SHIFT*\n"
        f"{icons.get(old_regime,'?')} {old_regime} → {icons.get(new_regime,'?')} *{new_regime}*\n\n"
        f"VIX: {vix} | SPY 10d: {spy:+.1f}%\n\n"
        f"_Review your positions for regime alignment. "
        f"BULL favors growth, BEAR favors defensives/cash, CHOP favors patience._"
    )[:4096]


def fmt_top_performers(data: dict) -> str:
    """Top Performers of the Day — 3-section close recap."""
    dt = data.get("date", "today")
    lines = [f"🏆 *Top Performers — {dt}*", ""]

    # Section 1: SOTD candidates
    leaders = data.get("candidates_leaders") or []
    if leaders:
        lines.append("*From Today's SOTD Candidates*")
        for p in leaders[:5]:
            icon = "📈" if p["change_pct"] > 0 else "📉"
            lines.append(f"{icon} *{p['ticker']}*  {p['change_pct']:+.2f}%  (open ${p['open']} → close ${p['close']})")
        lines.append("")

    # Section 2: FinViz top gainers
    gainers = data.get("finviz_gainers") or []
    if gainers:
        lines.append("*Market Top Gainers (Mid+ Cap)*")
        for g in gainers[:5]:
            lines.append(f"📈 *{g['ticker']}*  {g['change_pct']:+.2f}%  _{_safe(g.get('company',''), 40)}_")
        lines.append("")

    # Section 3: SOTD pick tracking
    st = data.get("sotd_tracking") or {}
    if st.get("ticker"):
        outcome_icon = "✅" if st.get("outcome") == "win" else "❌" if st.get("outcome") == "loss" else "❓"
        ret   = st.get("return_pct")
        spy   = st.get("spy_pct")
        alpha = st.get("alpha")
        lines.append("*Morning Pick Scorecard*")
        lines.append(f"{outcome_icon} *{st['ticker']}*: {ret:+.2f}% vs SPY {spy:+.2f}%")
        if alpha is not None:
            lines.append(f"Alpha today: {alpha:+.2f}%")

    return "\n".join(lines)[:4096]


def fmt_weekly_summary(positions: list[dict], macro: dict) -> str:
    total = sum(p.get("current_value") or 0 for p in positions)
    total_gl = sum(p.get("total_gain_loss_dollar") or 0 for p in positions)
    vix = macro.get("vix", "N/A")

    return (
        f"*Sunday Portfolio Summary*\n"
        f"Total: ${total:,.0f} | P&L: ${total_gl:+,.0f}\n"
        f"VIX: {vix} — {macro.get('vix_signal', '')[:80]}\n\n"
        f"Reply /brief for today's analysis or /coach for weekly coaching"
    )[:4096]


def fmt_virtual_portfolio_update(actions: list) -> str:
    lines = ["📊 *AI PORTFOLIO UPDATE*", ""]
    buys  = [a for a in actions if a["action"] == "BUY"]
    sells = [a for a in actions if a["action"] == "SELL"]
    holds = [a for a in actions if a["action"] == "HOLD"]

    if buys:
        lines.append("*New Positions*")
        for a in buys:
            exp = a.get("explanation", {})
            lines.append(f"🟢 BUY *{a['ticker']}* @ ${a.get('price', 0):.2f}")
            lines.append(f"   _{exp.get('rationale', '')}_ ")
    if sells:
        lines.append("\n*Exits*")
        for a in sells:
            exp = a.get("explanation", {})
            ret = a.get("return_pct", 0)
            icon = "✅" if ret >= 0 else "🔴"
            lines.append(f"{icon} SELL *{a['ticker']}*  {ret:+.1f}%")
            lines.append(f"   _{a.get('reason', '')}_ ")
    if holds:
        lines.append(f"\n*Holds ({len(holds)})*: " + ", ".join(a["ticker"] for a in holds))

    if not buys and not sells and not holds:
        lines.append("No positions to evaluate today.")

    return "\n".join(lines)[:4096]


def fmt_strategy_refresh(label: str, sotd_result: dict, strategy_picks: dict[str, dict]) -> str:
    """
    Intraday strategy refresh alert — sent at 9:45 AM, 1:30 PM, 3:45 PM ET.
    label: 'Open', 'Afternoon', or 'Close'
    strategy_picks: {strategy_name: pick_row_dict} from strategy_forward_picks
    """
    icon_map  = {"Open": "🔔", "Afternoon": "🌤", "Close": "🔔"}
    icon      = icon_map.get(label, "📊")
    mkt       = sotd_result.get("market_context") or {}
    sotd      = sotd_result.get("stock_of_the_day") or {}
    regime    = mkt.get("regime", "—")
    vix       = mkt.get("vix", "—")
    spy       = mkt.get("spy_10d")
    spy_s     = f"{spy:+.1f}%" if spy is not None else "—"

    lines = [
        f"{icon} *SOTD {label} Refresh*",
        f"Regime: *{regime}*  |  VIX {vix}  |  SPY {spy_s}",
        "",
    ]

    # Main SOTD pick
    if sotd:
        ticker = sotd.get("ticker", "?")
        score  = sotd.get("confidence_score", "—")
        lines += [
            f"*Main Pick: {ticker}* — {_safe(sotd.get('company_name', ''), 40)}",
            f"Score {score}/100",
            "",
        ]

    # All 5 strategy picks
    lines.append("*Strategy Picks*")
    short_map = {
        "SOTD Default":    "Default",
        "High Conviction": "Hi-Conv",
        "Momentum":        "Momentum",
        "Recovery":        "Recovery",
        "Composite":       "Composite",
    }
    for strategy, pick in strategy_picks.items():
        short = short_map.get(strategy, strategy)
        if not pick or pick.get("no_pick"):
            reason = (pick.get("no_pick_reason") or "No pick") if pick else "No pick"
            lines.append(f"• {short}: _No pick_ — {_safe(reason, 60)}")
        else:
            ticker  = pick.get("ticker", "?")
            score   = pick.get("score", "—")
            metrics = pick.get("metrics") or {}
            rsi     = metrics.get("rsi")
            vol     = metrics.get("vol_ratio")
            details = f"Score {score}"
            if rsi  is not None: details += f"  RSI {rsi:.0f}"
            if vol  is not None: details += f"  Vol {vol:.1f}x"
            # Mark fallback picks
            reason = pick.get("no_pick_reason") or ""
            fb = " _(fallback)_" if reason and "Fallback" in reason else ""
            lines.append(f"• {short}: *{ticker}* — {details}{fb}")

    # Consensus check
    tickers = [p.get("ticker") for p in strategy_picks.values() if p and not p.get("no_pick") and p.get("ticker")]
    if tickers:
        from collections import Counter
        top_t, top_n = Counter(tickers).most_common(1)[0]
        if top_n >= 3:
            lines += ["", f"⚡ *Consensus: {top_t}* — {top_n}/5 strategies agree"]
        elif top_n == 2:
            lines += ["", f"📊 Moderate agreement on *{top_t}* ({top_n}/5)"]

    return "\n".join(lines)[:4096]
