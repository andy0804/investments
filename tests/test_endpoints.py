import pytest
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from httpx import AsyncClient, ASGITransport
from app.main import app
from app.db.schema import init_db
from app.connectors.portfolio_csv import sync_portfolio_from_csv


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session", autouse=True)
async def setup():
    await init_db()
    await sync_portfolio_from_csv()


@pytest.mark.asyncio
async def test_health():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "ok"
    assert data["positions_loaded"] > 0


@pytest.mark.asyncio
async def test_positions():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.get("/positions")
    assert r.status_code == 200
    data = r.json()
    assert "positions" in data
    assert data["count"] > 0


@pytest.mark.asyncio
async def test_portfolio_summary():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.get("/portfolio/summary")
    assert r.status_code == 200
    data = r.json()
    assert "accounts" in data
    assert data["portfolio_total"] > 0


@pytest.mark.asyncio
async def test_macro():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.get("/macro")
    assert r.status_code == 200
    data = r.json()
    assert "macro" in data


@pytest.mark.asyncio
async def test_risk():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.get("/risk")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_signals_empty():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.get("/signals")
    assert r.status_code == 200
    data = r.json()
    assert "signals" in data


@pytest.mark.asyncio
async def test_log_trade():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/portfolio/log-trade?symbol=NVDA&action=buy&quantity=5&price=200.00")
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "ok"
    assert data["symbol"] == "NVDA"


@pytest.mark.asyncio
async def test_trade_log():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.get("/trade-log")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_daily_cost():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.get("/analysis/daily-cost")
    assert r.status_code == 200
    data = r.json()
    assert "today_usd" in data
    assert "budget_usd" in data
