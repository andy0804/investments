"""
app/simulator/universe.py

Fixed backtest universe — ~80 US stocks across 11 sectors.
Hardcoded to avoid survivorship bias issues with dynamic screeners.
All tickers have reliable yfinance coverage going back 3+ years.
"""

# ticker → (sector, cap_tier)
UNIVERSE: dict[str, tuple[str, str]] = {
    # Technology
    "AAPL":  ("Technology", "large"),
    "MSFT":  ("Technology", "large"),
    "NVDA":  ("Technology", "large"),
    "GOOGL": ("Technology", "large"),
    "META":  ("Technology", "large"),
    "AMD":   ("Technology", "large"),
    "CRM":   ("Technology", "large"),
    "NOW":   ("Technology", "large"),
    "ADBE":  ("Technology", "large"),
    "INTC":  ("Technology", "large"),
    "QCOM":  ("Technology", "large"),
    "AMAT":  ("Technology", "large"),
    "KLAC":  ("Technology", "mid"),
    "MU":    ("Technology", "large"),
    "TXN":   ("Technology", "large"),
    "CRWD":  ("Technology", "mid"),
    "DDOG":  ("Technology", "mid"),
    "SNOW":  ("Technology", "mid"),
    # Healthcare
    "UNH":   ("Healthcare", "large"),
    "LLY":   ("Healthcare", "large"),
    "ABBV":  ("Healthcare", "large"),
    "PFE":   ("Healthcare", "large"),
    "MRK":   ("Healthcare", "large"),
    "TMO":   ("Healthcare", "large"),
    "ABT":   ("Healthcare", "large"),
    "DHR":   ("Healthcare", "large"),
    "AMGN":  ("Healthcare", "large"),
    # Financials
    "JPM":   ("Financials", "large"),
    "BAC":   ("Financials", "large"),
    "GS":    ("Financials", "large"),
    "V":     ("Financials", "large"),
    "MA":    ("Financials", "large"),
    "AXP":   ("Financials", "large"),
    "BLK":   ("Financials", "large"),
    "COF":   ("Financials", "large"),
    # Consumer Discretionary
    "AMZN":  ("Consumer Discretionary", "large"),
    "TSLA":  ("Consumer Discretionary", "large"),
    "NKE":   ("Consumer Discretionary", "large"),
    "SBUX":  ("Consumer Discretionary", "large"),
    "MCD":   ("Consumer Discretionary", "large"),
    "HD":    ("Consumer Discretionary", "large"),
    "LOW":   ("Consumer Discretionary", "large"),
    "TGT":   ("Consumer Discretionary", "large"),
    # Consumer Staples
    "COST":  ("Consumer Staples", "large"),
    "WMT":   ("Consumer Staples", "large"),
    "PG":    ("Consumer Staples", "large"),
    "KO":    ("Consumer Staples", "large"),
    # Energy
    "XOM":   ("Energy", "large"),
    "CVX":   ("Energy", "large"),
    "COP":   ("Energy", "mid"),
    "EOG":   ("Energy", "mid"),
    "OXY":   ("Energy", "mid"),
    "SLB":   ("Energy", "large"),
    # Industrials
    "CAT":   ("Industrials", "large"),
    "DE":    ("Industrials", "large"),
    "UNP":   ("Industrials", "large"),
    "UPS":   ("Industrials", "large"),
    "GE":    ("Industrials", "large"),
    "HON":   ("Industrials", "large"),
    "BA":    ("Industrials", "large"),
    "RTX":   ("Industrials", "large"),
    # Communication Services
    "NFLX":  ("Communication Services", "large"),
    "DIS":   ("Communication Services", "large"),
    "CMCSA": ("Communication Services", "large"),
    "VZ":    ("Communication Services", "large"),
    # Materials
    "LIN":   ("Materials", "large"),
    "NEM":   ("Materials", "mid"),
    "FCX":   ("Materials", "mid"),
    # Real Estate
    "AMT":   ("Real Estate", "large"),
    "PLD":   ("Real Estate", "large"),
    # Utilities
    "NEE":   ("Utilities", "large"),
    "DUK":   ("Utilities", "large"),
}

SECTOR_ETFS: dict[str, str] = {
    "Technology":             "XLK",
    "Healthcare":             "XLV",
    "Financials":             "XLF",
    "Energy":                 "XLE",
    "Consumer Discretionary": "XLY",
    "Consumer Staples":       "XLP",
    "Industrials":            "XLI",
    "Materials":              "XLB",
    "Real Estate":            "XLRE",
    "Utilities":              "XLU",
    "Communication Services": "XLC",
}

TICKERS = list(UNIVERSE.keys())
ALL_DOWNLOAD_TICKERS = TICKERS + ["SPY", "^VIX"] + list(SECTOR_ETFS.values())
