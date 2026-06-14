"""
EDGAR MCP connector — wraps the edgar.tools/mcp hosted MCP server.
Exposes tool-style async functions the Research Agent calls directly.
"""

import os
import logging
import httpx
from typing import Any

log = logging.getLogger(__name__)

EDGAR_MCP_URL = "https://app.edgar.tools/mcp"
_API_KEY = os.getenv("EDGAR_API_KEY", "")

_HEADERS = {
    "Authorization": f"Bearer {_API_KEY}",
    "Content-Type": "application/json",
}


async def _call(tool: str, arguments: dict[str, Any]) -> dict:
    """Generic MCP tool call to edgar.tools."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(EDGAR_MCP_URL, json=payload, headers=_HEADERS)
            r.raise_for_status()
            data = r.json()
            if "error" in data:
                log.warning("EDGAR MCP error for %s: %s", tool, data["error"])
                return {}
            return data.get("result", {})
    except Exception as e:
        log.warning("EDGAR MCP call failed (%s): %s", tool, e)
        return {}


async def get_company_filings(ticker: str, filing_type: str = "10-K", limit: int = 3) -> dict:
    """Get recent SEC filings for a ticker (10-K, 10-Q, 8-K)."""
    return await _call("get_filings", {
        "ticker": ticker.upper(),
        "form_type": filing_type,
        "limit": limit,
    })


async def get_insider_trades(ticker: str, limit: int = 10) -> dict:
    """Get recent insider buying/selling activity."""
    return await _call("get_insider_trades", {
        "ticker": ticker.upper(),
        "limit": limit,
    })


async def get_institutional_ownership(ticker: str) -> dict:
    """Get latest 13F institutional ownership data."""
    return await _call("get_institutional_ownership", {
        "ticker": ticker.upper(),
    })


async def get_earnings_history(ticker: str, limit: int = 4) -> dict:
    """Get earnings history with beat/miss vs estimates."""
    return await _call("get_earnings", {
        "ticker": ticker.upper(),
        "limit": limit,
    })


async def search_company(query: str) -> dict:
    """Search for a company by name or ticker."""
    return await _call("search_company", {"query": query})


async def build_research_brief(ticker: str) -> dict:
    """
    Aggregate all EDGAR data for a ticker into a single research brief.
    Called by the Research Agent as a single unified fetch.
    """
    import asyncio
    filings_10k, filings_8k, insiders, institutions, earnings = await asyncio.gather(
        get_company_filings(ticker, "10-K", 2),
        get_company_filings(ticker, "8-K", 5),
        get_insider_trades(ticker, 10),
        get_institutional_ownership(ticker),
        get_earnings_history(ticker, 4),
        return_exceptions=True,
    )

    def _safe(result):
        return result if isinstance(result, dict) else {}

    return {
        "ticker":       ticker.upper(),
        "source":       "edgar_mcp",
        "filings_10k":  _safe(filings_10k),
        "filings_8k":   _safe(filings_8k),
        "insiders":     _safe(insiders),
        "institutions": _safe(institutions),
        "earnings":     _safe(earnings),
    }
