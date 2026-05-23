"""
Stock of the Day — V1 vs V2 Pipeline Comparison
Runs both scoring algorithms on identical data and shows a diff.

V2 improvements over V1:
  1. Market Regime Classifier  — gates strategy selection
  2. Market Alignment fix       — pure relative return (removes double-count)
  3. Sector as setup multiplier — strength/weakness amplifies setup quality
  4. Regime-adjusted momentum   — momentum penalised in Bear/Chop
  5. Tighter LLM prompt         — evidence-only, no subjective language

Usage:
    source venv/bin/activate && python test_sotd_v2.py
"""

import os, json, sys, warnings
warnings.filterwarnings("ignore")

import pandas as pd
import yfinance as yf
from ta.momentum import RSIIndicator
from ta.trend   import ADXIndicator, SMAIndicator
from ta.volatility import BollingerBands
from dotenv import load_dotenv
from finvizfinance.screener.overview import Overview

load_dotenv()
ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY")
HAIKU_MODEL   = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")

PORTFOLIO = {
    "NVDA","TSLA","NFLX","WDC","WMT","PLTR","VRT","AMZN","AAPL","NBIS",
    "MSFT","COST","APP","CRWV","ORLY","SOFI","APLD","CAVA","HIMS","CMG",
    "AXON","GOOGL","SPY","QQQ","FNILX","LLY","FSPSX","BRKB",
}
SECTOR_ETF = {
    "Technology":"XLK","Financial Services":"XLF","Healthcare":"XLV",
    "Consumer Cyclical":"XLY","Communication Services":"XLC",
    "Industrials":"XLI","Consumer Defensive":"XLP","Energy":"XLE",
    "Utilities":"XLU","Real Estate":"XLRE","Basic Materials":"XLB",
}
SEP = "─" * 65


# ── Helpers ───────────────────────────────────────────────────────────────────

def scalar(val):
    """Safely convert any pandas scalar/Series to a Python float."""
    if hasattr(val, "item"):
        return val.item()
    if hasattr(val, "iloc"):
        v = val.iloc[0]
        return v.item() if hasattr(v, "item") else float(v)
    return float(val)


def fetch_candidates(limit=40) -> list[dict]:
    print(f"\n{SEP}\nSTEP 1  Screener\n{SEP}")
    fov = Overview()
    fov.set_filter(filters_dict={
        "Country": "USA", "Market Cap.": "+Small (over $300mln)",
        "Average Volume": "Over 500K", "Performance": "Week Up",
        "RSI (14)": "Not Overbought (<60)",
    })
    try:
        df = fov.screener_view()
    except Exception as e:
        print(f"  [warn] {e} — retrying broader filter")
        fov.set_filter(filters_dict={
            "Country": "USA", "Market Cap.": "+Small (over $300mln)",
            "Average Volume": "Over 500K", "Performance": "Week Up",
        })
        df = fov.screener_view()

    print(f"  Raw: {len(df)}  →  ", end="")
    out = []
    for _, row in df.head(limit).iterrows():
        t = str(row.get("Ticker","")).strip()
        if t and t not in PORTFOLIO:
            out.append({"ticker": t, "company": str(row.get("Company", t)),
                        "sector": str(row.get("Sector","Unknown"))})
    print(f"{len(out)} after excluding portfolio")
    return out


def fetch_market_data(tickers: list[str]) -> dict[str, pd.DataFrame]:
    print(f"\n{SEP}\nSTEP 2  Market data (60d)\n{SEP}")
    all_t = tickers + ["SPY", "^VIX"] + list(SECTOR_ETF.values())
    unique = list(dict.fromkeys(all_t))
    raw = yf.download(unique, period="60d", auto_adjust=True, progress=False)
    out = {}
    for t in unique:
        try:
            if isinstance(raw.columns, pd.MultiIndex):
                df = pd.DataFrame({
                    "Open": raw["Open"][t], "High": raw["High"][t],
                    "Low":  raw["Low"][t],  "Close": raw["Close"][t],
                    "Volume": raw["Volume"][t] if t != "^VIX" else 0,
                }).dropna()
            else:
                df = raw.copy()
            if len(df) >= 20:
                out[t] = df
        except Exception:
            pass
    print(f"  Downloaded {len(out)} tickers")
    return out


def compute_indicators(df: pd.DataFrame) -> dict:
    close, volume = df["Close"], df["Volume"]
    rsi   = scalar(RSIIndicator(close, window=14).rsi().iloc[-1])
    sma20 = SMAIndicator(close, window=20).sma_indicator()
    sma50 = SMAIndicator(close, window=min(50, len(df))).sma_indicator()
    bb    = BollingerBands(close, window=20, window_dev=2)
    adx   = scalar(ADXIndicator(df["High"], df["Low"], close, window=14).adx().iloc[-1])

    p_now  = scalar(close.iloc[-1])
    p_3d   = scalar(close.iloc[-4])  if len(df) >= 4  else p_now
    p_5d   = scalar(close.iloc[-6])  if len(df) >= 6  else p_now
    p_10d  = scalar(close.iloc[-11]) if len(df) >= 11 else p_now

    vol_avg   = scalar(volume.iloc[-21:-1].mean()) if len(volume) >= 21 else scalar(volume.mean())
    vol_today = scalar(volume.iloc[-1])
    vol_ratio = vol_today / vol_avg if vol_avg > 0 else 0

    bb_w_now = (scalar(bb.bollinger_hband().iloc[-1]) - scalar(bb.bollinger_lband().iloc[-1])) / p_now
    bb_w_5d  = (scalar(bb.bollinger_hband().iloc[-6]) - scalar(bb.bollinger_lband().iloc[-6])) / p_5d if len(df) >= 6 else bb_w_now
    bb_squeeze    = bb_w_now < bb_w_5d * 0.85
    above_upper   = p_now > scalar(bb.bollinger_hband().iloc[-1])
    above_sma20   = p_now > scalar(sma20.iloc[-1])
    above_sma50   = p_now > scalar(sma50.iloc[-1])
    rsi_5d_ago    = scalar(RSIIndicator(close, window=14).rsi().iloc[-6]) if len(df) >= 20 else rsi
    rsi_recovering = (rsi_5d_ago < 40) and (rsi > 48)

    return {
        "price": p_now, "rsi": round(rsi, 1), "adx": round(adx, 1),
        "vol_ratio": round(vol_ratio, 2), "avg_volume": int(vol_avg),
        "return_3d": round((p_now/p_3d - 1)*100, 2),
        "return_5d": round((p_now/p_5d - 1)*100, 2),
        "return_10d": round((p_now/p_10d - 1)*100, 2),
        "above_sma20": bool(above_sma20), "above_sma50": bool(above_sma50),
        "bb_squeeze": bool(bb_squeeze), "above_upper_bb": bool(above_upper),
        "rsi_recovering": bool(rsi_recovering),
    }


def apply_hard_filters(ticker: str, ind: dict) -> tuple[bool, str]:
    if ind["rsi"] > 78:             return False, f"RSI {ind['rsi']} > 78 (overbought)"
    if ind["return_3d"] > 18:       return False, f"3d move {ind['return_3d']}% > 18% (overextended)"
    if ind["avg_volume"] < 500_000: return False, f"avg vol {ind['avg_volume']:,} < 500K (illiquid)"
    if ind["return_5d"] > 10 and ind["vol_ratio"] < 1.2:
        return False, f"+{ind['return_5d']}% 5d on weak vol ({ind['vol_ratio']}x) — noise"
    if ind["adx"] < 15 and not ind["bb_squeeze"] and ind["return_10d"] < 2:
        return False, f"ADX {ind['adx']} + no squeeze + flat 10d — no structure"
    return True, "passed"


# ── V1 Scorer ─────────────────────────────────────────────────────────────────

def score_v1(ind: dict, spy_10d: float, sector_10d: float) -> dict:
    r10 = ind["return_10d"]
    momentum = 25 if r10>=8 else 20 if r10>=5 else 15 if r10>=3 else 8 if r10>=1 else 3
    vr = ind["vol_ratio"]
    volume   = 20 if vr>=2.0 else 15 if vr>=1.5 else 8 if vr>=1.2 else 0
    if   ind["bb_squeeze"] and ind["above_upper_bb"]: setup = 19
    elif ind["rsi_recovering"] and ind["above_sma20"]: setup = 16
    elif ind["above_sma20"] and 50<=ind["rsi"]<=65:   setup = 12
    elif ind["above_sma20"]:                           setup = 7
    else:                                              setup = 2
    rel = ind["return_10d"] - spy_10d          # V1: uses absolute+relative mix
    market = 15 if rel>=3 else 10 if rel>=1 else 7 if rel>=-1 else 2
    sector = 10 if sector_10d>=3 else 7 if sector_10d>=1 else 4 if sector_10d>=0 else 1
    penalty = 0
    if ind["adx"] < 20:       penalty -= 3
    if ind["return_3d"] > 10: penalty -= 4
    if ind["vol_ratio"] < 1.5 and ind["above_upper_bb"]: penalty -= 3
    total = max(0, min(100, momentum + volume + setup + market + sector + penalty))
    return {"momentum":momentum,"volume":volume,"setup":setup,"market":market,
            "sector":sector,"penalty":penalty,"total":total,"regime_penalty":0}


# ── V2 Scorer ─────────────────────────────────────────────────────────────────

def classify_regime(spy_df: pd.DataFrame, vix: float) -> str:
    close    = spy_df["Close"]
    sma50    = scalar(SMAIndicator(close, window=min(50,len(close))).sma_indicator().iloc[-1])
    spy_10d  = (scalar(close.iloc[-1]) / scalar(close.iloc[-11]) - 1) * 100 if len(close)>=11 else 0
    above50  = scalar(close.iloc[-1]) > sma50
    if vix < 20 and above50 and spy_10d > 0:  return "BULL"
    if vix > 25 or (not above50 and spy_10d < -2): return "BEAR"
    return "CHOP"


def sector_multiplier(sector_10d: float, spy_10d: float) -> float:
    rel = sector_10d - spy_10d
    if rel > 5:   return 1.25
    if rel > 2:   return 1.10
    if rel > -2:  return 1.00
    if sector_10d < 0: return 0.75
    return 0.90


def score_v2(ind: dict, spy_10d: float, sector_10d: float,
             regime: str, is_momentum_setup: bool) -> dict:
    # 1. Momentum — regime-adjusted
    r10 = ind["return_10d"]
    raw_mom = 25 if r10>=8 else 20 if r10>=5 else 15 if r10>=3 else 8 if r10>=1 else 3
    regime_mult = 1.0 if regime=="BULL" else 0.85 if regime=="CHOP" else 0.65
    if regime=="BEAR" and is_momentum_setup and not ind["rsi_recovering"]:
        regime_mult = 0.50   # momentum in bear with no reversal signal = low quality
    momentum = int(raw_mom * regime_mult)

    # 2. Volume — unchanged
    vr = ind["vol_ratio"]
    volume = 20 if vr>=2.0 else 15 if vr>=1.5 else 8 if vr>=1.2 else 0

    # 3. Setup × sector multiplier (FIX: sector strength amplifies setup quality)
    if   ind["bb_squeeze"] and ind["above_upper_bb"]: raw_setup = 19
    elif ind["rsi_recovering"] and ind["above_sma20"]: raw_setup = 16
    elif ind["above_sma20"] and 50<=ind["rsi"]<=65:   raw_setup = 12
    elif ind["above_sma20"]:                           raw_setup = 7
    else:                                              raw_setup = 2
    s_mult = sector_multiplier(sector_10d, spy_10d)
    setup  = int(raw_setup * s_mult)

    # 4. Market Alignment — pure relative only (FIX: removes double-count with momentum)
    rel = ind["return_10d"] - spy_10d
    market = 15 if rel>=5 else 11 if rel>=2 else 7 if rel>=0 else 3 if rel>=-3 else 0

    # 5. Trend conviction (replaces flat sector score) — ADX-based
    conviction = 10 if ind["adx"]>=30 else 7 if ind["adx"]>=20 else 3

    # 6. Penalty
    penalty = 0
    if ind["adx"] < 20:       penalty -= 3
    if ind["return_3d"] > 10: penalty -= 4
    if ind["vol_ratio"] < 1.5 and ind["above_upper_bb"]: penalty -= 3
    regime_pen = -5 if (regime=="BEAR" and is_momentum_setup and not ind["rsi_recovering"]) else 0
    penalty += regime_pen

    total = max(0, min(100, momentum + volume + setup + market + conviction + penalty))
    return {"momentum":momentum,"volume":volume,"setup":setup,"market":market,
            "sector":conviction,"penalty":penalty,"total":total,"regime_penalty":regime_pen}


def threshold_for_regime(regime: str) -> int:
    return 85 if regime=="CHOP" else 80  # BEAR same threshold but fewer pass strategy gate


# ── LLM Explainer ─────────────────────────────────────────────────────────────

def call_llm(candidates: list[dict], version: str, regime: str = "") -> dict:
    import anthropic
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    regime_ctx = f"\nMARKET REGIME: {regime}\n" if regime else ""
    prompt = f"""You are a disciplined quantitative analyst. Pre-scored stocks are provided below.{regime_ctx}
Your ONLY job: interpret the scores, select the best pick, explain using evidence from the data.

STRICT RULES:
- Do NOT use subjective language ("clean play", "strong opportunity", "compelling setup")
- Use only: "scores indicate", "metrics show", "data suggests", "quantitatively qualifies"
- Do NOT recalculate scores or invent data not in the input
- Score ≥80 = "Stock of the Day" | Score 65-79 = "Best Watchlist Candidate"
- If top score < 65: set no_trade_day = true

CANDIDATES:
{json.dumps(candidates, indent=2)}

Return ONLY valid JSON:
{{
  "no_trade_day": false,
  "stock_of_the_day": {{
    "ticker": "...",
    "company_name": "...",
    "confidence_score": 0-100,
    "tier": "Stock of the Day | Best Watchlist Candidate",
    "signal_type": "breakout | reversal | continuation | momentum",
    "summary": "2-3 sentences citing specific score components and metric values",
    "key_drivers": ["cite score component and metric value", "..."],
    "risk_factors": ["specific risk with data point", "..."]
  }},
  "other_considered": [
    {{"ticker": "...", "score": 0, "reason_not_selected": "specific score/metric reason"}}
  ]
}}"""

    resp = client.messages.create(
        model=HAIKU_MODEL, max_tokens=1024,
        messages=[{"role":"user","content":prompt}]
    )
    raw = resp.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"): raw = raw[4:]
    return json.loads(raw.strip())


def build_llm_input(candidates: list[dict], use_v2_scores: bool) -> list[dict]:
    score_key = "score_v2" if use_v2_scores else "score_v1"
    qualified = [c for c in candidates if c[score_key]["total"] >= 65]
    qualified.sort(key=lambda x: -x[score_key]["total"])
    out = []
    for c in qualified[:8]:
        sc = c[score_key]
        out.append({
            "ticker": c["ticker"], "company_name": c["company"],
            "sector": c["sector"], "final_score": sc["total"],
            "score_breakdown": sc,
            "tags": c["tags"],
            "metrics": {
                "rsi": c["ind"]["rsi"], "adx": c["ind"]["adx"],
                "return_10d": c["ind"]["return_10d"],
                "return_5d":  c["ind"]["return_5d"],
                "volume_ratio": c["ind"]["vol_ratio"],
                "above_sma20":    c["ind"]["above_sma20"],
                "bb_squeeze":     c["ind"]["bb_squeeze"],
                "rsi_recovering": c["ind"]["rsi_recovering"],
            },
        })
    return out


# ── Pretty printers ───────────────────────────────────────────────────────────

def print_llm_result(result: dict, label: str):
    print(f"\n  ┌─ {label} " + "─"*(52-len(label)) + "┐")
    if result.get("no_trade_day"):
        print("  │  NO TRADE DAY                                      │")
        print("  └" + "─"*54 + "┘")
        return
    p = result.get("stock_of_the_day", {})
    score = p.get("confidence_score", 0)
    bar = "█"*int(score/5) + "░"*(20-int(score/5))
    print(f"  │  {p.get('tier','').upper()}")
    print(f"  │  {p.get('ticker')} — {p.get('company_name')}")
    print(f"  │  Signal: {p.get('signal_type','').upper()}")
    print(f"  │  Score:  [{bar}] {score}/100")
    print(f"  │")
    summary = p.get("summary","")
    for i in range(0, len(summary), 70):
        print(f"  │  {summary[i:i+70]}")
    print(f"  │")
    for d in p.get("key_drivers",[]):
        line = f"  │  + {d}"
        print(line[:74])
    print(f"  │")
    for r in p.get("risk_factors",[]):
        line = f"  │  ! {r}"
        print(line[:74])
    others = result.get("other_considered",[])
    if others:
        print(f"  │")
        for o in others:
            line = f"  │  {o.get('ticker'):6s}({o.get('score')}) — {o.get('reason_not_selected','')}"
            print(line[:74])
    print("  └" + "─"*54 + "┘")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print(f"\n{'═'*65}")
    print("  STOCK OF THE DAY — V1 vs V2 Pipeline Comparison")
    print(f"{'═'*65}")

    candidates = fetch_candidates(limit=40)
    tickers    = [c["ticker"] for c in candidates]
    mdata      = fetch_market_data(tickers)

    # VIX
    vix_df  = mdata.get("^VIX")
    vix_val = scalar(vix_df["Close"].iloc[-1]) if vix_df is not None else 18.0

    # SPY
    spy_df  = mdata.get("SPY")
    spy_10d = ((scalar(spy_df["Close"].iloc[-1]) / scalar(spy_df["Close"].iloc[-11])) - 1)*100 \
              if spy_df is not None and len(spy_df)>=11 else 0.0

    # Sector returns
    sector_returns: dict[str,float] = {}
    for name, etf in SECTOR_ETF.items():
        df = mdata.get(etf)
        if df is not None and len(df)>=11:
            sector_returns[name] = ((scalar(df["Close"].iloc[-1])/scalar(df["Close"].iloc[-11]))-1)*100
        else:
            sector_returns[name] = 0.0

    # V2: classify regime
    regime   = classify_regime(spy_df, vix_val) if spy_df is not None else "CHOP"
    thresh_v2 = threshold_for_regime(regime)

    print(f"\n  Market Context")
    print(f"  {'─'*40}")
    print(f"  VIX:         {vix_val:.1f}")
    print(f"  SPY 10d:     {spy_10d:+.1f}%")
    print(f"  V2 Regime:   {regime}  (V2 threshold: {thresh_v2})")
    print(f"\n  Top sectors: ", end="")
    top = sorted(sector_returns.items(), key=lambda x: -x[1])[:3]
    print("  |  ".join(f"{s}: {r:+.1f}%" for s,r in top))

    # Compute indicators + both scores
    print(f"\n{SEP}\nSTEP 3–5  Filters + Dual Scoring\n{SEP}")
    results, rejected = [], []

    for c in candidates:
        t  = c["ticker"]
        df = mdata.get(t)
        if df is None or len(df) < 20:
            rejected.append((t, "insufficient history"))
            continue

        ind = compute_indicators(df)
        ok, reason = apply_hard_filters(t, ind)
        if not ok:
            rejected.append((t, reason))
            continue

        sec_10d = sector_returns.get(c["sector"], 0.0)
        is_momentum = not ind["rsi_recovering"]  # true if not a reversal setup

        sv1 = score_v1(ind, spy_10d, sec_10d)
        sv2 = score_v2(ind, spy_10d, sec_10d, regime, is_momentum)

        tags = (
            (["breakout"]        if ind["bb_squeeze"] and ind["above_upper_bb"] else []) +
            (["reversal"]        if ind["rsi_recovering"] else []) +
            (["volume_confirmed"] if ind["vol_ratio"]>=1.5 else []) +
            (["above_sma20"]     if ind["above_sma20"] else [])
        )
        results.append({**c, "ind":ind, "score_v1":sv1, "score_v2":sv2, "tags":tags})

    # Sort by V2 score for display
    results.sort(key=lambda x: -(x["score_v2"]["total"]))

    # ── Comparison table ──
    print(f"\n  {'Ticker':<8} {'V1':>4} {'V2':>4}  {'Δ':>4}  Key V2 change")
    print(f"  {'─'*8} {'─'*4} {'─'*4}  {'─'*4}  {'─'*38}")

    for s in results:
        v1t = s["score_v1"]["total"]
        v2t = s["score_v2"]["total"]
        delta = v2t - v1t

        # Identify the biggest score driver change
        changes = []
        mkt_diff = s["score_v2"]["market"] - s["score_v1"]["market"]
        if abs(mkt_diff) >= 2: changes.append(f"mkt_align {mkt_diff:+d} (relative-only fix)")
        setup_diff = s["score_v2"]["setup"] - s["score_v1"]["setup"]
        if abs(setup_diff) >= 2: changes.append(f"setup {setup_diff:+d} (sector×{sector_multiplier(sector_returns.get(s['sector'],0), spy_10d):.2f})")
        mom_diff = s["score_v2"]["momentum"] - s["score_v1"]["momentum"]
        if abs(mom_diff) >= 2: changes.append(f"momentum {mom_diff:+d} (regime {regime})")
        if s["score_v2"]["regime_penalty"] != 0: changes.append(f"regime_pen {s['score_v2']['regime_penalty']:+d}")
        conv_diff = s["score_v2"]["sector"] - s["score_v1"]["sector"]
        if abs(conv_diff) >= 2: changes.append(f"conviction {conv_diff:+d} (ADX-based)")

        v1_star = "★" if v1t>=80 else ("◆" if v1t>=65 else " ")
        v2_star = "★" if v2t>=thresh_v2 else ("◆" if v2t>=65 else " ")
        delta_s = f"{delta:+d}"
        change_str = changes[0] if changes else "—"

        print(f"  {v1_star}{s['ticker']:<6}  {v1t:>3}{v2_star} {v2t:>3}  {delta_s:>4}  {change_str}")

    print(f"\n  ★ ≥80 (V1) | ★ ≥{thresh_v2} (V2 {regime} regime) | ◆ 65–79")

    # ── Which stocks qualify? ──
    v1_qualified = [s for s in results if s["score_v1"]["total"] >= 65]
    v2_qualified = [s for s in results if s["score_v2"]["total"] >= 65]

    v1_pick = max(v1_qualified, key=lambda x: x["score_v1"]["total"]) if v1_qualified else None
    v2_pick = max(v2_qualified, key=lambda x: x["score_v2"]["total"]) if v2_qualified else None

    print(f"\n  V1 qualified: {len(v1_qualified)} | V2 qualified: {len(v2_qualified)}")
    print(f"  V1 top pick:  {v1_pick['ticker'] if v1_pick else 'NONE'} ({v1_pick['score_v1']['total'] if v1_pick else '—'})")
    print(f"  V2 top pick:  {v2_pick['ticker'] if v2_pick else 'NONE'} ({v2_pick['score_v2']['total'] if v2_pick else '—'})")
    same_pick = (v1_pick and v2_pick and v1_pick["ticker"] == v2_pick["ticker"])
    print(f"  Same pick?    {'YES — scores differ' if same_pick else 'NO — different picks'}")

    # ── LLM stage ──
    print(f"\n{SEP}\nSTEP 6  LLM Explainer — calling Haiku for both pipelines\n{SEP}")

    llm_in_v1 = build_llm_input(results, use_v2_scores=False)
    llm_in_v2 = build_llm_input(results, use_v2_scores=True)

    if not llm_in_v1 and not llm_in_v2:
        print("\n  Both pipelines: NO TRADE DAY (nothing scored ≥65)")
        return

    print(f"  V1 sending {len(llm_in_v1)} candidates to Haiku...")
    res_v1 = call_llm(llm_in_v1, "V1") if llm_in_v1 else {"no_trade_day": True}
    print(f"  V2 sending {len(llm_in_v2)} candidates to Haiku...")
    res_v2 = call_llm(llm_in_v2, "V2", regime=regime) if llm_in_v2 else {"no_trade_day": True}

    # ── Final comparison ──
    print(f"\n{'═'*65}")
    print("  FINAL OUTPUT — Side by Side")
    print(f"{'═'*65}")
    print_llm_result(res_v1, "V1  (additive, no regime)")
    print_llm_result(res_v2, f"V2  (regime={regime}, sector×, relative market align)")

    # ── Score breakdown diff for top pick ──
    if same_pick and v1_pick:
        t = v1_pick["ticker"]
        s1 = v1_pick["score_v1"]
        s2 = v1_pick["score_v2"]
        print(f"\n{'═'*65}")
        print(f"  Score Breakdown Diff — {t}")
        print(f"{'═'*65}")
        print(f"  {'Component':<20} {'V1':>5} {'V2':>5} {'Δ':>5}  Reason")
        print(f"  {'─'*20} {'─'*5} {'─'*5} {'─'*5}  {'─'*30}")
        rows = [
            ("Momentum",  "raw×regime_mult"),
            ("Volume",    "unchanged"),
            ("Setup",     "×sector_multiplier"),
            ("Mkt Align", "relative-only fix"),
            ("Conviction","ADX-based (was flat sector)"),
            ("Penalty",   "+regime_penalty if applicable"),
        ]
        keys = ["momentum","volume","setup","market","sector","penalty"]
        for (label, reason), key in zip(rows, keys):
            d = s2[key] - s1[key]
            flag = " ◄" if abs(d) >= 3 else ""
            print(f"  {label:<20} {s1[key]:>5} {s2[key]:>5} {d:>+5}  {reason}{flag}")
        print(f"  {'─'*20} {'─'*5} {'─'*5} {'─'*5}")
        print(f"  {'TOTAL':<20} {s1['total']:>5} {s2['total']:>5} {s2['total']-s1['total']:>+5}")

    # Raw JSON
    print(f"\n{'═'*65}")
    print("  Raw JSON — V2 Output")
    print(f"{'═'*65}")
    print(json.dumps(res_v2, indent=2))


if __name__ == "__main__":
    main()
