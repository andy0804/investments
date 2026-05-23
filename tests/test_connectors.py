import pytest
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.connectors.portfolio_csv import sync_portfolio_from_csv, get_portfolio_symbols
from app.connectors.fred import sync_vix, get_latest_vix
from app.db.schema import init_db


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session", autouse=True)
async def setup_db():
    await init_db()


@pytest.mark.asyncio
async def test_portfolio_csv_loads():
    count = await sync_portfolio_from_csv()
    assert count > 0, "Expected positions from CSV files"


@pytest.mark.asyncio
async def test_portfolio_has_symbols():
    symbols = await get_portfolio_symbols()
    assert len(symbols) > 0
    assert "NVDA" in symbols or "AAPL" in symbols, "Expected known holdings"


@pytest.mark.asyncio
async def test_fred_vix():
    vix = await sync_vix()
    assert vix is not None
    assert 5.0 < vix < 100.0, f"VIX {vix} out of expected range"


@pytest.mark.asyncio
async def test_get_latest_vix():
    vix = await get_latest_vix()
    assert vix is not None
