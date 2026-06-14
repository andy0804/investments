"""
Research Agent — gathers evidence from EDGAR, Finnhub, yfinance, and RSS.
Synthesises into a structured research brief for the Bull/Bear agents.
"""

import os
import json
import logging
import asyncio
from datetime import datetime, UTC

import anthropic

from app.connectors import edgar_mcp, finnhub_mcp, yfinance_mcp, rss_mcp
from app.analysis.alpha_agent import cost_tracker

log = logging.getLogger(__name__)
MODEL = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")


async def run(ticker: str, run_id: int | None = None, emit=None) -> dict:
    """
    Gather all data sources and produce a structured research brief.
    emit: optional async callable for SSE streaming.
    """
    async def _emit(msg: str, confidence: int | None = None, data: dict = {}):
        if emit:
            try:
                await emit({"stage": "research", "status": "running",
                            "message": msg, "confidence": confidence, **data})
            except Exception:
                pass

    await _emit(f"Pulling EDGAR filings for {ticker}…")

    edgar_data, finnhub_data, yfinance_data, rss_data = await asyncio.gather(
        edgar_mcp.build_research_brief(ticker),
        finnhub_mcp.build_research_brief(ticker),
        yfinance_mcp.build_research_brief(ticker),
        rss_mcp.build_research_brief(ticker),
        return_exceptions=True,
    )

    def _safe(v, default):
        return v if isinstance(v, dict) else default

    raw_data = {
        "ticker":   ticker.upper(),
        "edgar":    _safe(edgar_data, {}),
        "finnhub":  _safe(finnhub_data, {}),
        "yfinance": _safe(yfinance_data, {}),
        "rss":      _safe(rss_data, {}),
    }

    await _emit("Data gathered — synthesising research brief…")

    prices    = raw_data["yfinance"].get("prices", {})
    technicals = raw_data["yfinance"].get("technicals", {})
    news_items = raw_data["rss"].get("ticker_news", [])[:5]
    analyst    = raw_data["finnhub"].get("analyst_ratings", [])
    surprises  = raw_data["finnhub"].get("earnings_surprises", [])
    target     = raw_data["finnhub"].get("price_target", {})
    insiders   = raw_data["edgar"].get("insiders", {})

    prompt = f"""You are the Research Agent for Alpha Agent, an AI portfolio manager.

Your job: synthesise all available data into a clear, factual research brief for {ticker}.
Do NOT recommend a trade. Only report what the evidence shows.

PRICE DATA:
{json.dumps(prices, indent=2)[:1500]}

TECHNICAL INDICATORS:
{json.dumps(technicals, indent=2)}

RECENT NEWS (last 14 days):
{json.dumps(news_items, indent=2)[:1000]}

ANALYST RATINGS (last 3 periods):
{json.dumps(analyst[:3], indent=2)}

ANALYST PRICE TARGET:
{json.dumps(target, indent=2)}

EARNINGS SURPRISES (last 4 quarters):
{json.dumps(surprises, indent=2)}

INSIDER TRADES (recent):
{json.dumps(insiders, indent=2)[:800]}

Produce a JSON research brief with these exact keys:
{{
  "ticker": "{ticker}",
  "price_summary": "one sentence on current price action and trend",
  "momentum": "bullish|bearish|neutral with brief explanation",
  "fundamental_signal": "strong|moderate|weak|negative with brief explanation",
  "news_sentiment": "positive|negative|neutral with key headline",
  "analyst_consensus": "buy|hold|sell with price target if available",
  "earnings_trend": "beating|missing|inline with brief explanation",
  "insider_activity": "buying|selling|neutral",
  "key_catalysts": ["catalyst 1", "catalyst 2"],
  "key_risks": ["risk 1", "risk 2"],
  "data_quality": "high|medium|low (how complete is the data)",
  "research_summary": "2-3 sentence objective summary of findings"
}}

Return ONLY valid JSON."""

    client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
    try:
        response = await client.messages.create(
            model=MODEL,
            max_tokens=800,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text.strip()
        await cost_tracker.log_call("research", MODEL,
                                    response.usage.input_tokens,
                                    response.usage.output_tokens, run_id)
        # Parse JSON
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        brief = json.loads(text)
    except Exception as e:
        log.warning("research_agent LLM failed: %s", e)
        brief = {
            "ticker": ticker, "price_summary": "Data available — LLM synthesis failed",
            "momentum": "neutral", "fundamental_signal": "moderate",
            "news_sentiment": "neutral", "analyst_consensus": "hold",
            "earnings_trend": "inline", "insider_activity": "neutral",
            "key_catalysts": [], "key_risks": ["LLM synthesis error"],
            "data_quality": "low", "research_summary": "Research data gathered but synthesis failed.",
        }

    brief["_raw"] = raw_data
    await _emit("Research complete", confidence=None,
                data={"data": {k: v for k, v in brief.items() if k != "_raw"}})
    return brief
