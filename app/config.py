import os
from dotenv import load_dotenv

load_dotenv()

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(ROOT_DIR, "investment_agent.db")
CSV_DIR = ROOT_DIR

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
ANTHROPIC_MODEL_HAIKU = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")
ANTHROPIC_MODEL_SONNET = os.getenv("ANTHROPIC_MODEL_SONNET", "claude-sonnet-4-6")
FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY")
FRED_API_KEY = os.getenv("FRED_API_KEY")
FMP_API_KEY = os.getenv("FINANCIAL_MODELLING_API_KEY")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

PORTFOLIO_SIZE = int(os.getenv("PORTFOLIO_SIZE", "100000"))
RISK_TOLERANCE = os.getenv("RISK_TOLERANCE", "balanced")
MIN_HOLD_DAYS = int(os.getenv("MIN_HOLD_DAYS", "30"))
MAX_SINGLE_POSITION_PCT = float(os.getenv("MAX_SINGLE_POSITION_PCT", "8"))
MAX_SECTOR_CONCENTRATION_PCT = float(os.getenv("MAX_SECTOR_CONCENTRATION_PCT", "35"))

INVESTOR_PROFILE = {
    "portfolio_size": PORTFOLIO_SIZE,
    "risk_tolerance": RISK_TOLERANCE,
    "min_hold_days": MIN_HOLD_DAYS,
    "max_single_position_pct": MAX_SINGLE_POSITION_PCT,
    "max_sector_concentration_pct": MAX_SECTOR_CONCENTRATION_PCT,
}

STOP_LOSS_PCT = -8.0
SOFT_REVIEW_PCT = -5.0
TARGET_1_PCT = 10.0
TARGET_2_PCT = 18.0

RSS_FEEDS = [
    "https://finance.yahoo.com/news/rssindex",
    "http://feeds.marketwatch.com/marketwatch/topstories/",
    "https://www.cnbc.com/id/20910258/device/rss/rss.html",
    "https://feeds.reuters.com/reuters/businessNews",
]
