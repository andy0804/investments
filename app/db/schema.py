import aiosqlite
import logging
from app.config import DB_PATH

logger = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_number TEXT NOT NULL,
    account_name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    description TEXT,
    quantity REAL,
    last_price REAL,
    current_value REAL,
    today_gain_loss_dollar REAL,
    today_gain_loss_percent REAL,
    total_gain_loss_dollar REAL,
    total_gain_loss_percent REAL,
    percent_of_account REAL,
    cost_basis_total REAL,
    avg_cost_basis REAL,
    position_type TEXT DEFAULT 'Cash',
    last_synced TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_number, symbol)
);

CREATE TABLE IF NOT EXISTS market_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL UNIQUE,
    price REAL,
    change_pct REAL,
    volume INTEGER,
    high_52w REAL,
    low_52w REAL,
    market_cap REAL,
    beta REAL,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vix_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    value REAL NOT NULL,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    event_type TEXT,
    title TEXT,
    url TEXT,
    tone REAL,
    impact_score REAL,
    related_symbols TEXT,
    event_date TIMESTAMP,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name TEXT NOT NULL,
    status TEXT NOT NULL,
    records_affected INTEGER DEFAULT 0,
    error_message TEXT,
    ran_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trade_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_number TEXT,
    symbol TEXT NOT NULL,
    action TEXT NOT NULL,
    quantity REAL NOT NULL,
    price REAL NOT NULL,
    total_value REAL,
    notes TEXT,
    traded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    score INTEGER NOT NULL,
    reasoning TEXT,
    action TEXT,
    model_used TEXT,
    resolved_at TIMESTAMP,
    resolved_outcome TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS analysis_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0.0,
    ran_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS portfolio_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total_value REAL,
    total_gain_loss REAL,
    cash REAL,
    positions_json TEXT,
    vix REAL,
    snapped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kelly_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL UNIQUE,
    win_rate REAL,
    avg_win REAL,
    avg_loss REAL,
    kelly_fraction REAL,
    suggested_position_pct REAL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    value_type TEXT NOT NULL DEFAULT 'float',
    label TEXT,
    group_name TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pick_date TEXT NOT NULL UNIQUE,
    symbol TEXT NOT NULL,
    signal_json TEXT,
    regime TEXT,
    market_context_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS signal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pick_date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    confidence_score INTEGER,
    tier TEXT,
    signal_type TEXT,
    regime TEXT,
    generated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pick_date, ticker)
);

CREATE TABLE IF NOT EXISTS signal_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_event_id INTEGER NOT NULL REFERENCES signal_events(id),
    ticker TEXT NOT NULL,
    pick_date TEXT NOT NULL,
    entry_price REAL,
    price_1d REAL,
    price_3d REAL,
    price_7d REAL,
    price_14d REAL,
    price_30d REAL,
    return_1d REAL,
    return_3d REAL,
    return_7d REAL,
    return_14d REAL,
    return_30d REAL,
    spy_return_7d REAL,
    spy_return_14d REAL,
    alpha_7d REAL,
    alpha_14d REAL,
    outcome TEXT,
    evaluated_at TEXT,
    UNIQUE(signal_event_id)
);

CREATE TABLE IF NOT EXISTS correction_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'pending',
    trigger_reason TEXT NOT NULL,
    metric_snapshot_json TEXT,
    proposed_changes_json TEXT NOT NULL,
    current_values_json TEXT NOT NULL,
    generated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT,
    resolution TEXT
);

CREATE TABLE IF NOT EXISTS performance_attribution (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT NOT NULL UNIQUE,
    picks_count INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    win_rate REAL,
    avg_alpha_14d REAL,
    cumulative_alpha REAL,
    by_regime_json TEXT,
    by_tier_json TEXT,
    rolling_8w_win_rate REAL,
    computed_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE,
    description TEXT,
    schedule_type TEXT NOT NULL DEFAULT 'cron',
    cron_expression TEXT,
    interval_minutes INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    delivery_channel TEXT NOT NULL DEFAULT 'both',
    telegram_enabled INTEGER NOT NULL DEFAULT 1,
    last_run TEXT,
    next_run TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS filter_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    is_active INTEGER NOT NULL DEFAULT 0,
    min_price REAL NOT NULL DEFAULT 10.0,
    min_avg_volume INTEGER NOT NULL DEFAULT 1000000,
    market_cap TEXT NOT NULL DEFAULT 'mid',
    rsi_filter TEXT NOT NULL DEFAULT 'Not Overbought (<60)',
    performance_filter TEXT NOT NULL DEFAULT 'Week Up',
    conviction_threshold INTEGER NOT NULL DEFAULT 65,
    limit_candidates INTEGER NOT NULL DEFAULT 40,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deep_dive_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    verdict TEXT,
    score INTEGER,
    reasoning TEXT,
    technicals_json TEXT,
    fundamentals_json TEXT,
    full_result_json TEXT,
    saved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS strategy_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    buy_threshold INTEGER NOT NULL DEFAULT 80,
    max_positions INTEGER NOT NULL DEFAULT 5,
    allocation_pct REAL NOT NULL DEFAULT 20.0,
    min_hold_days INTEGER NOT NULL DEFAULT 30,
    max_hold_days INTEGER NOT NULL DEFAULT 90,
    profit_target_pct REAL NOT NULL DEFAULT 15.0,
    stop_loss_pct REAL NOT NULL DEFAULT -8.0,
    score_exit_threshold INTEGER NOT NULL DEFAULT 60,
    floor_value REAL NOT NULL DEFAULT 8000.0,
    reload_amount REAL NOT NULL DEFAULT 2000.0,
    regime_filter TEXT NOT NULL DEFAULT 'ALL',
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS virtual_account (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id INTEGER NOT NULL REFERENCES strategy_configs(id),
    cash REAL NOT NULL DEFAULT 10000.0,
    initial_capital REAL NOT NULL DEFAULT 10000.0,
    is_suspended INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS virtual_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES virtual_account(id),
    config_id INTEGER NOT NULL REFERENCES strategy_configs(id),
    ticker TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    entry_price REAL NOT NULL,
    quantity REAL NOT NULL,
    entry_score INTEGER NOT NULL,
    entry_regime TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    exit_date TEXT,
    exit_price REAL,
    exit_reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS virtual_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER NOT NULL REFERENCES virtual_positions(id),
    action TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    price REAL NOT NULL,
    quantity REAL NOT NULL,
    score_at_trade INTEGER,
    reasoning_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS portfolio_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES virtual_account(id),
    date TEXT NOT NULL,
    total_value REAL NOT NULL,
    cash REAL NOT NULL,
    invested_value REAL NOT NULL,
    daily_return_pct REAL,
    cumulative_return_pct REAL,
    open_positions INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account_id, date)
);

CREATE TABLE IF NOT EXISTS benchmark_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    spy_price REAL NOT NULL,
    spy_return_pct REAL,
    spy_cumulative_pct REAL
);

CREATE TABLE IF NOT EXISTS decision_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES virtual_account(id),
    position_id INTEGER,
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    action TEXT NOT NULL,
    score_current INTEGER,
    score_previous INTEGER,
    regime_current TEXT,
    regime_entry TEXT,
    return_pct REAL,
    days_held INTEGER,
    confidence TEXT,
    reasoning_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cached_prices (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    volume REAL,
    PRIMARY KEY (ticker, date)
);

CREATE TABLE IF NOT EXISTS simulated_prices (
    run_id TEXT NOT NULL,
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    volume REAL,
    regime TEXT,
    PRIMARY KEY (run_id, ticker, date)
);

CREATE TABLE IF NOT EXISTS strategy_runs (
    run_id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL DEFAULT 'backtest',
    status TEXT NOT NULL DEFAULT 'PENDING',
    progress INTEGER NOT NULL DEFAULT 0,
    current_step TEXT,
    config_json TEXT,
    strategies_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    error TEXT
);

CREATE TABLE IF NOT EXISTS strategy_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES strategy_runs(run_id),
    strategy_name TEXT NOT NULL,
    params_json TEXT,
    metrics_json TEXT,
    regime_breakdown_json TEXT,
    trades_json TEXT,
    composite_score REAL,
    rank INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fundamental_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,
    raw_json TEXT,
    analysis_haiku_json TEXT,
    analysis_sonnet_json TEXT,
    fetch_errors_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(symbol, date)
);

CREATE TABLE IF NOT EXISTS universe_cooldown (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL UNIQUE,
    reason TEXT,
    alpha_14d REAL,
    times_blocked INTEGER DEFAULT 1,
    blocked_at TEXT NOT NULL,
    unblock_after TEXT
);

CREATE TABLE IF NOT EXISTS strategy_forward_picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_name TEXT NOT NULL,
    pick_date TEXT NOT NULL,
    ticker TEXT,
    company TEXT,
    sector TEXT,
    score INTEGER,
    regime TEXT,
    metrics_json TEXT,
    entry_price REAL,
    price_14d REAL,
    return_14d REAL,
    spy_return_14d REAL,
    alpha_14d REAL,
    outcome TEXT,
    evaluated_at TEXT,
    no_pick INTEGER DEFAULT 0,
    no_pick_reason TEXT,
    UNIQUE(strategy_name, pick_date)
);

CREATE TABLE IF NOT EXISTS stock_intelligence_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    source_label TEXT NOT NULL DEFAULT 'own_note',
    created_at TEXT NOT NULL,
    embedding_json TEXT
);

CREATE TABLE IF NOT EXISTS stock_intelligence_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES stock_intelligence_notes(id) ON DELETE CASCADE,
    ticker TEXT NOT NULL,
    thesis TEXT NOT NULL,
    signals_json TEXT,
    risks_json TEXT,
    timeframe TEXT,
    confidence INTEGER DEFAULT 5,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_analysis_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    technical_score REAL,
    macro_score REAL,
    sentiment_score REAL,
    valuation_score REAL,
    momentum_score REAL,
    risk_score REAL,
    catalyst_score REAL,
    deterministic_score REAL,
    llm_verdict TEXT,
    llm_confidence INTEGER,
    fusion_score REAL,
    reasoning TEXT,
    evidence_summary TEXT,
    evidence_note_ids TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_memory_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES stock_analysis_runs(id) ON DELETE CASCADE,
    note_id INTEGER NOT NULL REFERENCES stock_intelligence_notes(id) ON DELETE CASCADE,
    relevance_score REAL
);
"""

CONFIG_DEFAULTS = [
    ("stop_loss_pct",               "-8.0",  "float", "Stop Loss %",                    "Risk Thresholds"),
    ("soft_review_pct",             "-5.0",  "float", "Soft Review %",                  "Risk Thresholds"),
    ("target1_pct",                 "10.0",  "float", "Target 1 %",                     "Risk Thresholds"),
    ("target2_pct",                 "18.0",  "float", "Target 2 %",                     "Risk Thresholds"),
    ("max_single_position_pct",      "8.0",  "float", "Max Single Position %",          "Position Limits"),
    ("max_sector_concentration_pct", "35.0", "float", "Max Sector Concentration %",     "Position Limits"),
    ("min_hold_days",               "30",    "int",   "Min Hold Days",                  "Position Limits"),
    ("daily_cost_budget",           "0.15",  "float", "Daily API Budget ($)",           "Budget"),
    ("scan_abort_threshold",        "0.12",  "float", "Scan Abort Threshold ($)",       "Budget"),
    ("max_daily_messages",          "8",     "int",   "Max Daily Telegram Messages",    "Notifications"),
    ("telegram_enabled",            "true",  "bool",  "Telegram Notifications Enabled", "Notifications"),
    ("universe_min_price",         "10.0",  "float", "Universe Min Price ($)",          "Signal Universe"),
    ("universe_min_avg_volume",    "1000000","float", "Universe Min Avg Volume",        "Signal Universe"),
    ("universe_min_market_cap",    "mid",   "str",   "Universe Min Market Cap",         "Signal Universe"),
    ("sotd_conviction_threshold",  "65",    "int",   "SOTD Min Conviction Score",       "Signal Universe"),
]


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(SCHEMA)

        # Migrate stock_picks: add new columns if they don't exist yet
        async with db.execute("PRAGMA table_info(stock_picks)") as cur:
            existing_cols = {row[1] for row in await cur.fetchall()}
        for col, col_def in [("regime", "TEXT"), ("market_context_json", "TEXT")]:
            if col not in existing_cols:
                await db.execute(f"ALTER TABLE stock_picks ADD COLUMN {col} {col_def}")

        for key, value, vtype, label, group in CONFIG_DEFAULTS:
            await db.execute(
                "INSERT OR IGNORE INTO agent_config (key, value, value_type, label, group_name) VALUES (?,?,?,?,?)",
                (key, value, vtype, label, group),
            )

        # Migrate schedules: add telegram_enabled if missing
        async with db.execute("PRAGMA table_info(schedules)") as cur:
            sched_cols = {row[1] for row in await cur.fetchall()}
        if "telegram_enabled" not in sched_cols:
            await db.execute("ALTER TABLE schedules ADD COLUMN telegram_enabled INTEGER NOT NULL DEFAULT 1")

        # Fix SOTD schedule name (was seeded as "Morning Stock Scan")
        await db.execute(
            "UPDATE schedules SET name = 'SOTD Pipeline — Stock of the Day', "
            "description = 'V2 SOTD pipeline — screens market with universe filters, scores candidates, picks Stock of the Day' "
            "WHERE job_id = 'sotd' AND name = 'Morning Stock Scan'"
        )

        # Seed default SOTD filter preset (INSERT OR IGNORE — preserves user edits)
        await db.execute(
            """INSERT OR IGNORE INTO filter_presets
               (name, description, is_active, min_price, min_avg_volume, market_cap,
                rsi_filter, performance_filter, conviction_threshold, limit_candidates)
               VALUES (?,?,1,10.0,1000000,'mid','Not Overbought (<60)','Week Up',65,40)""",
            ("SOTD", "Default universe: mid+ cap, price >$10, volume >1M, RSI not overbought"),
        )

        # Migrate strategy_results: add trades_json if missing
        async with db.execute("PRAGMA table_info(strategy_results)") as cur:
            sr_cols = {row[1] for row in await cur.fetchall()}
        if "trades_json" not in sr_cols:
            await db.execute("ALTER TABLE strategy_results ADD COLUMN trades_json TEXT")

        # Migrate strategy_configs: add regime_filter if missing
        async with db.execute("PRAGMA table_info(strategy_configs)") as cur:
            sc_cols = {row[1] for row in await cur.fetchall()}
        if "regime_filter" not in sc_cols:
            await db.execute("ALTER TABLE strategy_configs ADD COLUMN regime_filter TEXT NOT NULL DEFAULT 'ALL'")

        # Migrate signal_outcomes: add 14d/30d columns if missing
        async with db.execute("PRAGMA table_info(signal_outcomes)") as cur:
            so_cols = {row[1] for row in await cur.fetchall()}
        for col, col_def in [
            ("price_14d", "REAL"), ("price_30d", "REAL"),
            ("return_14d", "REAL"), ("return_30d", "REAL"),
            ("spy_return_14d", "REAL"), ("alpha_14d", "REAL"),
        ]:
            if col not in so_cols:
                await db.execute(f"ALTER TABLE signal_outcomes ADD COLUMN {col} {col_def}")

        # Seed all 7 strategy configs
        _strategies = [
            (1, "Default",          "Standard SOTD strategy: 80+ score, 5 positions, 20% allocation",        80, 5, 20.0, 30, 90,  15.0, -8.0,  60, 8000.0, 2000.0, "ALL",  1),
            (2, "High_Conviction",  "High bar entries — fewer trades, strongest setups only",                 85, 5, 20.0, 30, 90,  20.0, -8.0,  65, 8000.0, 2000.0, "ALL",  0),
            (3, "Trend_Follower",   "Lower threshold + longer hold — ride momentum further",                  70, 5, 20.0, 30, 120, 25.0, -10.0, 60, 8000.0, 2000.0, "ALL",  0),
            (4, "Conservative",     "Tight stops, quick profits, BULL regime only — capital preservation",    80, 5, 20.0, 14, 60,  10.0, -5.0,  65, 8000.0, 2000.0, "BULL", 0),
            (5, "Aggressive_Growth","Wider stops, higher targets — accept volatility for bigger returns",     75, 5, 20.0, 30, 90,  25.0, -12.0, 55, 8000.0, 2000.0, "ALL",  0),
            (6, "Regime_Selective", "Default params but sits in cash during BEAR and CHOP",                   80, 5, 20.0, 30, 90,  15.0, -8.0,  60, 8000.0, 2000.0, "BULL", 0),
            (7, "Moon_Shot",        "Let winners run — targets 50% gain with wide stops and long hold",       80, 5, 20.0, 30, 180, 50.0, -12.0, 55, 8000.0, 2000.0, "ALL",  0),
        ]
        for s in _strategies:
            await db.execute(
                """INSERT OR IGNORE INTO strategy_configs
                   (id, name, description, buy_threshold, max_positions, allocation_pct,
                    min_hold_days, max_hold_days, profit_target_pct, stop_loss_pct,
                    score_exit_threshold, floor_value, reload_amount, regime_filter, is_active)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                s
            )
        # Seed virtual account if not exists
        await db.execute(
            """INSERT OR IGNORE INTO virtual_account
               (id, config_id, cash, initial_capital, is_suspended)
               VALUES (1, 1, 10000.0, 10000.0, 0)"""
        )

        # Migrate: add embedding_json to stock_intelligence_notes if missing (safe no-op on new DB)
        async with db.execute("PRAGMA table_info(stock_intelligence_notes)") as cur:
            sin_cols = {row[1] for row in await cur.fetchall()}
        if sin_cols and "embedding_json" not in sin_cols:
            await db.execute("ALTER TABLE stock_intelligence_notes ADD COLUMN embedding_json TEXT")

        await db.commit()
    logger.info("Database initialized at %s", DB_PATH)


async def log_sync(job_name: str, status: str, records: int = 0, error: str = None):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO sync_log (job_name, status, records_affected, error_message) VALUES (?,?,?,?)",
            (job_name, status, records, error),
        )
        await db.commit()
