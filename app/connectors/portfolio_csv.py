import os
import glob
import csv
import logging
from datetime import datetime, UTC
import aiosqlite
from app.config import DB_PATH, CSV_DIR
from app.db.schema import log_sync

logger = logging.getLogger(__name__)

MONEY_MARKET_SYMBOLS = {"SPAXX**", "FDRXX**", "FZFXX**"}


def _parse_float(val: str) -> float | None:
    if not val or val.strip() in ("", "--"):
        return None
    cleaned = val.replace("$", "").replace(",", "").replace("+", "").replace("%", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return None


def _load_csv_file(filepath: str) -> list[dict]:
    rows = []
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            acct = (row.get("Account Number") or "").strip()
            symbol = (row.get("Symbol") or "").strip()
            if not acct or not acct[0].isalnum():
                continue
            if not symbol:
                continue
            is_cash = symbol in MONEY_MARKET_SYMBOLS
            rows.append({
                "account_number": acct,
                "account_name": (row.get("Account Name") or "").strip(),
                "symbol": symbol,
                "description": (row.get("Description") or "").strip(),
                "quantity": _parse_float(row.get("Quantity") or ""),
                "last_price": _parse_float(row.get("Last Price") or ""),
                "current_value": _parse_float(row.get("Current Value") or ""),
                "today_gain_loss_dollar": _parse_float(row.get("Today's Gain/Loss Dollar") or ""),
                "today_gain_loss_percent": _parse_float(row.get("Today's Gain/Loss Percent") or ""),
                "total_gain_loss_dollar": _parse_float(row.get("Total Gain/Loss Dollar") or ""),
                "total_gain_loss_percent": _parse_float(row.get("Total Gain/Loss Percent") or ""),
                "percent_of_account": _parse_float(row.get("Percent Of Account") or ""),
                "cost_basis_total": _parse_float(row.get("Cost Basis Total") or ""),
                "avg_cost_basis": _parse_float(row.get("Average Cost Basis") or ""),
                "position_type": "Cash_MM" if is_cash else (row.get("Type") or "Cash").strip(),
            })
    return rows


async def sync_portfolio_from_csv() -> int:
    pattern = os.path.join(CSV_DIR, "Portfolio_Positions_*.csv")
    csv_files = glob.glob(pattern)
    if not csv_files:
        logger.warning("No CSV files found matching %s", pattern)
        await log_sync("portfolio_csv", "failed", 0, "No CSV files found")
        return 0

    all_rows = []
    for filepath in csv_files:
        try:
            rows = _load_csv_file(filepath)
            all_rows.extend(rows)
            logger.info("Loaded %d positions from %s", len(rows), os.path.basename(filepath))
        except Exception as e:
            logger.error("Failed to parse %s: %s", filepath, e)

    if not all_rows:
        await log_sync("portfolio_csv", "failed", 0, "No valid rows parsed")
        return 0

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM positions")
        await db.executemany(
            """INSERT OR REPLACE INTO positions
               (account_number, account_name, symbol, description, quantity, last_price,
                current_value, today_gain_loss_dollar, today_gain_loss_percent,
                total_gain_loss_dollar, total_gain_loss_percent, percent_of_account,
                cost_basis_total, avg_cost_basis, position_type, last_synced)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            [
                (
                    r["account_number"], r["account_name"], r["symbol"], r["description"],
                    r["quantity"], r["last_price"], r["current_value"],
                    r["today_gain_loss_dollar"], r["today_gain_loss_percent"],
                    r["total_gain_loss_dollar"], r["total_gain_loss_percent"],
                    r["percent_of_account"], r["cost_basis_total"], r["avg_cost_basis"],
                    r["position_type"], datetime.now(UTC).isoformat(),
                )
                for r in all_rows
            ],
        )
        await db.commit()

    await log_sync("portfolio_csv", "success", len(all_rows))
    logger.info("Portfolio synced: %d positions loaded", len(all_rows))
    return len(all_rows)


async def get_portfolio_symbols() -> list[str]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT DISTINCT symbol FROM positions WHERE position_type NOT IN ('Cash_MM')"
        ) as cursor:
            rows = await cursor.fetchall()
    return [r["symbol"] for r in rows]
