from datetime import date as date_type
from typing import Optional
import aiosqlite
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import DB_PATH

router = APIRouter(prefix="/live-portfolio", tags=["live-portfolio"])


class OpenPositionBody(BaseModel):
    ticker: str
    action: str = "BUY"
    option_type: str
    strike: float
    expiry: str
    fill_price: float
    quantity: int = 1
    strategy_label: Optional[str] = None
    commission: float = 0.65
    note: Optional[str] = None


class ClosePositionBody(BaseModel):
    close_price: float
    note: Optional[str] = None


def _row_to_dict(row, cursor) -> dict:
    return {cursor.description[i][0]: row[i] for i in range(len(row))}


def _auto_label(action: str, option_type: str) -> str:
    mapping = {
        ("BUY", "CALL"): "Long Call",
        ("BUY", "PUT"):  "Long Put",
        ("SELL", "CALL"): "Short Call",
        ("SELL", "PUT"):  "Short Put",
    }
    return mapping.get((action.upper(), option_type.upper()), f"{action} {option_type}")


@router.get("/positions")
async def list_open_positions():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM live_positions WHERE status = 'OPEN' ORDER BY open_date DESC"
        ) as cur:
            rows = await cur.fetchall()
    return {"positions": [dict(r) for r in rows]}


@router.get("/positions/closed")
async def list_closed_positions():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM live_positions WHERE status = 'CLOSED' ORDER BY close_date DESC"
        ) as cur:
            rows = await cur.fetchall()
    return {"positions": [dict(r) for r in rows]}


@router.post("/positions")
async def open_position(body: OpenPositionBody):
    label = body.strategy_label or _auto_label(body.action, body.option_type)
    today = date_type.today().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """INSERT INTO live_positions
               (ticker, action, option_type, strike, expiry, fill_price,
                quantity, strategy_label, open_date, commission, note)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                body.ticker.upper(), body.action.upper(), body.option_type.upper(),
                body.strike, body.expiry, body.fill_price,
                body.quantity, label, today, body.commission, body.note,
            ),
        ) as cur:
            new_id = cur.lastrowid
        await db.commit()
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM live_positions WHERE id = ?", (new_id,)) as cur:
            row = await cur.fetchone()
    return {"position": dict(row)}


@router.post("/positions/{position_id}/close")
async def close_position(position_id: int, body: ClosePositionBody):
    today = date_type.today().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id, status FROM live_positions WHERE id = ?", (position_id,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Position not found")
        if row[1] != "OPEN":
            raise HTTPException(status_code=400, detail="Position is already closed")
        await db.execute(
            """UPDATE live_positions
               SET status='CLOSED', close_price=?, close_date=?, note=COALESCE(?, note)
               WHERE id=?""",
            (body.close_price, today, body.note, position_id),
        )
        await db.commit()
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM live_positions WHERE id = ?", (position_id,)) as cur:
            updated = await cur.fetchone()
    return {"position": dict(updated)}


@router.delete("/positions/{position_id}")
async def delete_position(position_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id FROM live_positions WHERE id = ?", (position_id,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Position not found")
        await db.execute("DELETE FROM live_positions WHERE id = ?", (position_id,))
        await db.commit()
    return {"ok": True}
