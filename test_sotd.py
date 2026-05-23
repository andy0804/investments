"""
Stock of the Day — pipeline test script.
Runs: screener → hard filters → scorer → LLM explainer
Prints every step so you can validate quality before building.

Usage:
    source venv/bin/activate
    python test_sotd.py
"""

import os, json, sys, warnings
warnings.filterwarnings("ignore")

import pandas as pd
import yfinance as yf
from ta.momentum import RSIIndicator
from ta.trend import ADXIndicator, SMAIndicator, MACD
from ta.volatility import BollingerBands
from dotenv import load_dotenv
from finvizfinance.screener.overview import Overview

load_dotenv()

ANTHROPIC_KEY   = os.getenv("ANTHROPIC_API_KEY")
HAIKU_MODEL     = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")

# Stocks already in portfolio — never recommend these
PORTFOLIO = {
    "NVDA","TSLA","NFLX","WDC","WMT","PLTR","VRT","AMZN","AAPL","NBIS",
    "MSFT","COST","APP","CRWV","ORLY","SOFI","APLD","CAVA","HIMS","CMG",
    "AXON","GOOGL","SPY","QQQ","FNILX","LLY","FSPSX","BRKB"
}

SECTOR_ETF = {
    "Technology": "XLK", "Financial Services": "XLF", "Healthcare": "XLV",
    "Consumer Cyclical": "XLY", "Communication Services": "XLC",
    "Industrials": "XLI", "Consumer Defensive": "XLP", "Energy": "XLE",
    "Utilities": "XLU", "Real Estate": "XLRE", "Basic Materials": "XLB",
}

SEP = "─" * 60


# ── Step 1: Screener ──────────────────────────────────────────────────────────

def fetch_candidates(limit=40) -> list[dict]:
    print(f"\n{SEP}")
    print("STEP 1  Screener — fetching momentum candidates")
    print(SEP)

    foverview = Overview()
    foverview.set_filter(filters_dict={
        "Country":        "USA",
        "Market Cap.":    "+Small (over $300mln)",
        "Average Volume": "Over 500K",
        "Performance":    "Week Up",
        "RSI (14)":       "Not Overbought (<60)",
    })
    try:
        df = foverview.screener_view()
    except Exception as e:
        print(f"  [warn] Finviz returned error: {e} — trying broader filter")
        foverview.set_filter(filters_dict={
            "Country":        "USA",
            "Market Cap.":    "+Small (over $300mln)",
            "Average Volume": "Over 500K",
            "Performance":    "Week Up",
        })
        df = foverview.screener_view()

    if df is None or df.empty:
        print("  [error] No screener results returned")
        sys.exit(1)

    print(f"  Raw candidates: {len(df)}")
    candidates = []
    for _, row in df.head(limit).iterrows():
        ticker = str(row.get("Ticker", "")).strip()
        if ticker and ticker not in PORTFOLIO:
            candidates.append({
                "ticker":  ticker,
                "company": str(row.get("Company", ticker)),
                "sector":  str(row.get("Sector", "Unknown")),
            })

    print(f"  After excluding portfolio holdings: {len(candidates)} candidates")
    for c in candidates[:10]:
        print(f"    {c['ticker']:8s} {c['sector']}")
    if len(candidates) > 10:
        print(f"    ... and {len(candidates)-10} more")
    return candidates


# ── Step 2: Fetch market data ─────────────────────────────────────────────────

def fetch_market_data(tickers: list[str]) -> dict[str, pd.DataFrame]:
    print(f"\n{SEP}")
    print("STEP 2  Downloading 40-day OHLCV from yfinance")
    print(SEP)

    all_tickers = tickers + ["SPY"] + list(SECTOR_ETF.values())
    unique = list(dict.fromkeys(all_tickers))
    print(f"  Downloading {len(unique)} tickers (candidates + SPY + sector ETFs)...")

    raw = yf.download(unique, period="40d", auto_adjust=True, progress=False)
    result = {}

    for t in unique:
        try:
            if isinstance(raw.columns, pd.MultiIndex):
                df = pd.DataFrame({
                    "Open":   raw["Open"][t],
                    "High":   raw["High"][t],
                    "Low":    raw["Low"][t],
                    "Close":  raw["Close"][t],
                    "Volume": raw["Volume"][t],
                }).dropna()
            else:
                df = raw.copy()
            if len(df) >= 20:
                result[t] = df
        except Exception:
            pass

    print(f"  Got data for {len(result)} tickers ({len(result)-1-len(SECTOR_ETF)} candidates + SPY + ETFs)")
    return result


# ── Step 3: Compute indicators ────────────────────────────────────────────────

def compute_indicators(df: pd.DataFrame) -> dict:
    close  = df["Close"]
    volume = df["Volume"]

    rsi    = RSIIndicator(close, window=14).rsi().iloc[-1]
    sma20  = SMAIndicator(close, window=20).sma_indicator()
    sma50  = SMAIndicator(close, window=50).sma_indicator() if len(df) >= 50 else sma20
    bb     = BollingerBands(close, window=20, window_dev=2)
    adx    = ADXIndicator(df["High"], df["Low"], close, window=14).adx().iloc[-1]

    price_now  = close.iloc[-1]
    price_5d   = close.iloc[-6]  if len(df) >= 6  else close.iloc[0]
    price_10d  = close.iloc[-11] if len(df) >= 11 else close.iloc[0]
    price_3d   = close.iloc[-4]  if len(df) >= 4  else close.iloc[0]

    vol_20d_avg = volume.iloc[-21:-1].mean() if len(volume) >= 21 else volume.mean()
    vol_today   = volume.iloc[-1]
    vol_ratio   = vol_today / vol_20d_avg if vol_20d_avg > 0 else 0

    bb_width_now  = (bb.bollinger_hband().iloc[-1] - bb.bollinger_lband().iloc[-1]) / price_now
    bb_width_5d   = (bb.bollinger_hband().iloc[-6] - bb.bollinger_lband().iloc[-6]) / price_5d if len(df) >= 6 else bb_width_now
    bb_squeeze    = bb_width_now < bb_width_5d * 0.85  # bands narrowing = consolidation

    above_upper   = price_now > bb.bollinger_hband().iloc[-1]
    above_sma20   = price_now > sma20.iloc[-1]

    rsi_5d_ago    = RSIIndicator(close, window=14).rsi().iloc[-6] if len(df) >= 20 else rsi
    rsi_recovering= (rsi_5d_ago < 40) and (rsi > 48)  # was oversold, now recovering

    return {
        "price":          price_now,
        "rsi":            round(rsi, 1),
        "adx":            round(adx, 1),
        "vol_ratio":      round(vol_ratio, 2),
        "return_3d":      round((price_now / price_3d - 1) * 100, 2),
        "return_5d":      round((price_now / price_5d - 1) * 100, 2),
        "return_10d":     round((price_now / price_10d - 1) * 100, 2),
        "above_sma20":    bool(above_sma20),
        "bb_squeeze":     bool(bb_squeeze),
        "above_upper_bb": bool(above_upper),
        "rsi_recovering": bool(rsi_recovering),
        "avg_volume":     int(vol_20d_avg),
    }


# ── Step 4: Hard filters ──────────────────────────────────────────────────────

def apply_hard_filters(ticker: str, ind: dict) -> tuple[bool, str]:
    if ind["rsi"] > 78:
        return False, f"RSI {ind['rsi']} > 78 (overbought)"
    if ind["return_3d"] > 18:
        return False, f"3-day move {ind['return_3d']}% > 18% (overextended)"
    if ind["avg_volume"] < 500_000:
        return False, f"avg volume {ind['avg_volume']:,} < 500K (illiquid)"
    if ind["return_5d"] > 10 and ind["vol_ratio"] < 1.2:
        return False, f"+{ind['return_5d']}% 5d move on weak volume ({ind['vol_ratio']}x) — noise"
    if ind["adx"] < 15 and not ind["bb_squeeze"] and ind["return_10d"] < 2:
        return False, f"ADX {ind['adx']} + no squeeze + flat 10d return — no structure"
    return True, "passed"


# ── Step 5: Scoring model ─────────────────────────────────────────────────────

def score_stock(ind: dict, spy_10d: float, sector_10d: float) -> dict:

    # 1. Momentum Score (0–25)
    r10 = ind["return_10d"]
    if r10 >= 8:     momentum = 25
    elif r10 >= 5:   momentum = 20
    elif r10 >= 3:   momentum = 15
    elif r10 >= 1:   momentum = 8
    else:            momentum = 3

    # 2. Volume Confirmation (0–20)
    vr = ind["vol_ratio"]
    if vr >= 2.0:    volume = 20
    elif vr >= 1.5:  volume = 15
    elif vr >= 1.2:  volume = 8
    else:            volume = 0

    # 3. Setup Quality (0–20)
    if ind["bb_squeeze"] and ind["above_upper_bb"]:
        setup = 19  # breakout from consolidation
    elif ind["rsi_recovering"] and ind["above_sma20"]:
        setup = 16  # reversal from oversold
    elif ind["above_sma20"] and 50 <= ind["rsi"] <= 65:
        setup = 12  # mid-trend continuation
    elif ind["above_sma20"]:
        setup = 7
    else:
        setup = 2

    # 4. Market Alignment (0–15)
    rel = ind["return_10d"] - spy_10d
    if rel >= 3:     market = 15
    elif rel >= 1:   market = 10
    elif rel >= -1:  market = 7
    else:            market = 2

    # 5. Sector Strength (0–10)
    if sector_10d >= 3:    sector = 10
    elif sector_10d >= 1:  sector = 7
    elif sector_10d >= 0:  sector = 4
    else:                  sector = 1

    # 6. Risk Penalty (-10 to 0)
    penalty = 0
    if ind["adx"] < 20:             penalty -= 3
    if ind["return_3d"] > 10:       penalty -= 4   # spike
    if ind["vol_ratio"] < 1.5 and ind["above_upper_bb"]:
        penalty -= 3                               # breakout without conviction volume

    total = momentum + volume + setup + market + sector + penalty

    return {
        "momentum":    momentum,
        "volume":      volume,
        "setup":       setup,
        "market":      market,
        "sector":      sector,
        "penalty":     penalty,
        "total":       max(0, min(100, total)),
    }


# ── Step 6: LLM explainer ─────────────────────────────────────────────────────

def call_llm(candidates: list[dict]) -> dict:
    import anthropic
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

    candidates_json = json.dumps(candidates, indent=2)

    prompt = f"""You are a disciplined quantitative market analyst. You have been given a list of pre-screened and pre-scored stocks for today. Your ONLY job is to interpret the scores, select the best pick, and explain clearly.

RULES YOU MUST FOLLOW:
- Prefer early-stage momentum, not late-stage spikes
- Avoid overbought conditions (RSI > 75)
- Require volume confirmation (>1.5x avg)
- Prefer alignment with sector and market trend
- Reward consolidation before breakout
- Score >= 80: qualify as "Stock of the Day"
- Score 65-79: qualify as "Best Watchlist Candidate"
- Score < 65: do not recommend
- If the top score is below 65: return no_trade_day = true

SCORED CANDIDATES:
{candidates_json}

Select the single best candidate. Explain WHY the score is high — reference the actual score components. Be specific and evidence-based. Do NOT invent data not in the input.

Return ONLY valid JSON in this exact format:
{{
  "no_trade_day": false,
  "stock_of_the_day": {{
    "ticker": "...",
    "company_name": "...",
    "confidence_score": 0-100,
    "tier": "Stock of the Day | Best Watchlist Candidate",
    "signal_type": "breakout | reversal | continuation | momentum",
    "summary": "2-3 sentence explanation referencing the score drivers",
    "key_drivers": ["driver 1", "driver 2", "driver 3"],
    "risk_factors": ["risk 1", "risk 2"]
  }},
  "other_considered": [
    {{"ticker": "...", "score": 0, "reason_not_selected": "specific reason"}}
  ]
}}"""

    response = client.messages.create(
        model=HAIKU_MODEL,
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print(f"\n{'═'*60}")
    print("  STOCK OF THE DAY — Pipeline Test")
    print(f"{'═'*60}")

    # Step 1: Screener
    candidates = fetch_candidates(limit=40)
    if not candidates:
        print("[error] No candidates from screener")
        return

    # Step 2: Market data
    tickers = [c["ticker"] for c in candidates]
    market_data = fetch_market_data(tickers)

    # SPY 10d return for market alignment
    spy_df = market_data.get("SPY")
    spy_10d = ((spy_df["Close"].iloc[-1] / spy_df["Close"].iloc[-11]) - 1) * 100 if spy_df is not None and len(spy_df) >= 11 else 0.0

    # Sector ETF 10d returns
    sector_returns: dict[str, float] = {}
    for sector_name, etf in SECTOR_ETF.items():
        etf_df = market_data.get(etf)
        if etf_df is not None and len(etf_df) >= 11:
            sector_returns[sector_name] = ((etf_df["Close"].iloc[-1] / etf_df["Close"].iloc[-11]) - 1) * 100
        else:
            sector_returns[sector_name] = 0.0

    print(f"\n  SPY 10d return: {spy_10d:+.1f}%")
    print("  Sector 10d returns:")
    for s, r in sorted(sector_returns.items(), key=lambda x: -x[1]):
        print(f"    {s:30s} {r:+.1f}%")

    # Steps 3–5: Indicators, filters, scoring
    print(f"\n{SEP}")
    print("STEP 3 + 4  Indicators → Hard Filters")
    print(SEP)

    passed: list[dict] = []
    rejected: list[tuple] = []

    for c in candidates:
        t = c["ticker"]
        df = market_data.get(t)
        if df is None or len(df) < 20:
            rejected.append((t, "insufficient price history"))
            continue

        ind = compute_indicators(df)
        ok, reason = apply_hard_filters(t, ind)

        if not ok:
            rejected.append((t, reason))
        else:
            sector_10d = sector_returns.get(c["sector"], 0.0)
            sc = score_stock(ind, spy_10d, sector_10d)
            passed.append({
                "ticker":         t,
                "company":        c["company"],
                "sector":         c["sector"],
                "indicators":     ind,
                "score_breakdown": sc,
                "final_score":    sc["total"],
                "tags": (
                    (["breakout"] if ind["bb_squeeze"] and ind["above_upper_bb"] else []) +
                    (["reversal"] if ind["rsi_recovering"] else []) +
                    (["volume_confirmed"] if ind["vol_ratio"] >= 1.5 else []) +
                    (["above_sma20"] if ind["above_sma20"] else [])
                ),
            })

    print(f"\n  REJECTED ({len(rejected)}):")
    for t, reason in rejected:
        print(f"    ✗ {t:8s} — {reason}")

    print(f"\n{SEP}")
    print("STEP 5  Scoring Results")
    print(SEP)

    passed.sort(key=lambda x: -x["final_score"])

    print(f"\n  {'Ticker':<8} {'Score':>5}  {'Mom':>4} {'Vol':>4} {'Setup':>5} {'Mkt':>4} {'Sec':>4} {'Pen':>4}  Indicators")
    print(f"  {'─'*8} {'─'*5}  {'─'*4} {'─'*4} {'─'*5} {'─'*4} {'─'*4} {'─'*4}  {'─'*30}")

    for s in passed:
        sc  = s["score_breakdown"]
        ind = s["indicators"]
        tier = "★ " if s["final_score"] >= 80 else ("◆ " if s["final_score"] >= 65 else "  ")
        print(
            f"  {tier}{s['ticker']:<6} {s['final_score']:>5}  "
            f"{sc['momentum']:>4} {sc['volume']:>4} {sc['setup']:>5} "
            f"{sc['market']:>4} {sc['sector']:>4} {sc['penalty']:>4}  "
            f"RSI={ind['rsi']} vol={ind['vol_ratio']}x 10d={ind['return_10d']:+.1f}%"
        )

    qualified = [s for s in passed if s["final_score"] >= 65]
    print(f"\n  ★ = Stock of the Day (≥80)   ◆ = Watchlist Candidate (65–79)")
    print(f"  Qualified for LLM: {len(qualified)} stocks")

    if not qualified:
        print("\n  NO TRADE DAY — no candidates cleared the 65 threshold")
        return

    # Step 6: LLM
    print(f"\n{SEP}")
    print("STEP 6  LLM Explainer (Claude Haiku)")
    print(SEP)

    # Pass top 8 to LLM with score breakdowns
    llm_input = []
    for s in qualified[:8]:
        llm_input.append({
            "ticker":          s["ticker"],
            "company_name":    s["company"],
            "sector":          s["sector"],
            "final_score":     s["final_score"],
            "score_breakdown": s["score_breakdown"],
            "tags":            s["tags"],
            "metrics": {
                "rsi":            s["indicators"]["rsi"],
                "adx":            s["indicators"]["adx"],
                "return_10d":     s["indicators"]["return_10d"],
                "return_5d":      s["indicators"]["return_5d"],
                "volume_ratio":   s["indicators"]["vol_ratio"],
                "above_sma20":    s["indicators"]["above_sma20"],
                "bb_squeeze":     s["indicators"]["bb_squeeze"],
                "rsi_recovering": s["indicators"]["rsi_recovering"],
            },
        })

    print(f"\n  Sending {len(llm_input)} candidates to Haiku...")
    result = call_llm(llm_input)

    # ── Print final output ──
    print(f"\n{'═'*60}")
    print("  FINAL OUTPUT")
    print(f"{'═'*60}")

    if result.get("no_trade_day"):
        print("\n  NO TRADE DAY — LLM found no high-quality setup worth recommending")
        return

    pick = result.get("stock_of_the_day", {})
    tier_label = pick.get("tier", "Stock of the Day")
    score      = pick.get("confidence_score", 0)
    bar_filled = int(score / 5)
    bar        = "█" * bar_filled + "░" * (20 - bar_filled)

    print(f"\n  {tier_label.upper()}")
    print(f"  {pick.get('ticker')} — {pick.get('company_name')}")
    print(f"  Signal: {pick.get('signal_type', '').upper()}")
    print(f"  Score:  [{bar}] {score}/100")
    print(f"\n  {pick.get('summary')}")

    print(f"\n  Key Drivers:")
    for d in pick.get("key_drivers", []):
        print(f"    + {d}")

    print(f"\n  Risk Factors:")
    for r in pick.get("risk_factors", []):
        print(f"    ! {r}")

    others = result.get("other_considered", [])
    if others:
        print(f"\n  Other Considered ({len(others)}):")
        for o in others:
            print(f"    {o.get('ticker'):8s} (score {o.get('score')}) — {o.get('reason_not_selected')}")

    print(f"\n{'═'*60}")
    print("  Raw JSON output:")
    print(f"{'═'*60}")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
