"""
Quick smoke test for all external APIs used by the investment agent.
Run with: python test_apis.py
"""
import os, sys, json, requests
from dotenv import load_dotenv

load_dotenv()

PASS = "✅"
FAIL = "❌"
results = []

def check(name, fn):
    try:
        msg = fn()
        print(f"{PASS} {name}: {msg}")
        results.append((name, True))
    except Exception as e:
        print(f"{FAIL} {name}: {e}")
        results.append((name, False))

# ── 1. Anthropic ──────────────────────────────────────────────────────────────
def test_anthropic():
    import anthropic
    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    r = client.messages.create(
        model=os.getenv("ANTHROPIC_MODEL_HAIKU"),
        max_tokens=10,
        messages=[{"role": "user", "content": "Say OK"}]
    )
    return f"Haiku responded: '{r.content[0].text.strip()}'"

# ── 2. Finnhub ────────────────────────────────────────────────────────────────
def test_finnhub():
    key = os.getenv("FINNHUB_API_KEY")
    r = requests.get(f"https://finnhub.io/api/v1/quote?symbol=AAPL&token={key}", timeout=10)
    r.raise_for_status()
    d = r.json()
    if "c" not in d or d["c"] == 0:
        raise ValueError(f"Unexpected response: {d}")
    return f"AAPL current price ${d['c']:.2f}"

# ── 3. FRED (VIX) ─────────────────────────────────────────────────────────────
def test_fred():
    key = os.getenv("FRED_API_KEY")
    r = requests.get(
        f"https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS&limit=1&sort_order=desc&api_key={key}&file_type=json",
        timeout=10
    )
    r.raise_for_status()
    obs = r.json()["observations"]
    if not obs:
        raise ValueError("No observations returned")
    return f"VIX = {obs[0]['value']} on {obs[0]['date']}"

# ── 4. FMP quote (v4 stable) ──────────────────────────────────────────────────
def test_fmp():
    key = os.getenv("FINANCIAL_MODELLING_API_KEY")
    r = requests.get(
        f"https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey={key}",
        timeout=10
    )
    r.raise_for_status()
    d = r.json()
    if not d or "Error Message" in str(d):
        raise ValueError(f"Error or empty response: {d}")
    return f"AAPL price ${d[0]['price']:.2f}, mktcap ${d[0]['marketCap']/1e12:.1f}T"

# ── 5. FMP earnings calendar (v4 stable) ─────────────────────────────────────
def test_fmp_earnings():
    key = os.getenv("FINANCIAL_MODELLING_API_KEY")
    r = requests.get(
        f"https://financialmodelingprep.com/stable/earnings-calendar?from=2026-04-18&to=2026-04-25&apikey={key}",
        timeout=10
    )
    r.raise_for_status()
    d = r.json()
    if not d or "Error Message" in str(d):
        raise ValueError(f"Error or empty: {d}")
    upcoming = [e["symbol"] for e in d[:3]]
    return f"Upcoming earnings: {upcoming}"

# ── 6. Finviz screener (stock discovery) ─────────────────────────────────────
def test_finviz():
    from finvizfinance.screener.overview import Overview
    fov = Overview()
    fov.set_filter(filters_dict={"Market Cap.": "+Large (over $10bln)", "Country": "USA", "Sector": "Technology"})
    df = fov.screener_view()
    if df.empty:
        raise ValueError("No results returned")
    return f"Screener: {len(df)} stocks, sample: {list(df['Ticker'].head(3).values)}"

# ── 6. yfinance ───────────────────────────────────────────────────────────────
def test_yfinance():
    import yfinance as yf
    t = yf.Ticker("NVDA")
    hist = t.history(period="2d")
    if hist.empty:
        raise ValueError("No data returned")
    price = hist["Close"].iloc[-1]
    return f"NVDA last close ${price:.2f}"

# ── 7. GDELT (no key) ─────────────────────────────────────────────────────────
def test_gdelt():
    r = requests.get(
        "https://api.gdeltproject.org/api/v2/doc/doc?query=stock+market&mode=artlist&maxrecords=1&format=json",
        timeout=15
    )
    r.raise_for_status()
    d = r.json()
    if "articles" not in d:
        raise ValueError(f"Unexpected structure: {list(d.keys())}")
    title = d["articles"][0].get("title", "")[:60] if d["articles"] else "no articles"
    return f"GDELT article: '{title}...'"

# ── 8. SEC EDGAR (no key) ─────────────────────────────────────────────────────
def test_edgar():
    r = requests.get(
        "https://efts.sec.gov/LATEST/search-index?q=%22NVIDIA%22&dateRange=custom&startdt=2026-01-01&enddt=2026-04-18&hits.hits._source=period_of_report,file_date,entity_name,file_num&hits.hits.total=1",
        headers={"User-Agent": "investment-agent ananth.bhagyavahana@gmail.com"},
        timeout=15
    )
    r.raise_for_status()
    return f"EDGAR responded HTTP {r.status_code}, size {len(r.text)} bytes"

# ── 9. Telegram (get bot info only — no message sent) ────────────────────────
def test_telegram():
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    r = requests.get(f"https://api.telegram.org/bot{token}/getMe", timeout=10)
    r.raise_for_status()
    d = r.json()
    if not d.get("ok"):
        raise ValueError(f"Not OK: {d}")
    bot = d["result"]
    return f"Bot '@{bot['username']}' is live"

# ── Run all ───────────────────────────────────────────────────────────────────
print("\n=== Investment Agent — API Smoke Tests ===\n")
check("Anthropic (Haiku)",           test_anthropic)
check("Finnhub (quote)",             test_finnhub)
check("FRED (VIX)",                  test_fred)
check("FMP (quote v4)",              test_fmp)
check("FMP (earnings calendar v4)",  test_fmp_earnings)
check("Finviz (stock screener)",     test_finviz)
check("yfinance (OHLCV)",            test_yfinance)
check("GDELT (news)",                test_gdelt)
check("SEC EDGAR (filings)",         test_edgar)
check("Telegram (bot info)",         test_telegram)

passed = sum(1 for _, ok in results if ok)
total  = len(results)
print(f"\n{'='*42}")
print(f"Result: {passed}/{total} APIs passing")
if passed < total:
    print("Failed:", [n for n, ok in results if not ok])
print()
sys.exit(0 if passed == total else 1)
