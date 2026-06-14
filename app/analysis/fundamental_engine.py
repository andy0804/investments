"""
app/analysis/fundamental_engine.py

Orchestrates fundamental analysis:
  1. Check fundamental_cache for today's entry
  2. Fetch from AV + Finnhub if cache miss
  3. Run Claude Haiku/Sonnet with master prompt
  4. Store result in cache
  5. Return analysis + metrics + errors
"""
import json
import logging
import os
from datetime import datetime, UTC
from typing import Optional

import aiosqlite
import anthropic

from app.config import DB_PATH
from app.connectors.fundamentals import fetch_fundamentals

logger = logging.getLogger(__name__)

HAIKU_MODEL  = os.getenv("ANTHROPIC_MODEL_HAIKU",  "claude-haiku-4-5-20251001")
SONNET_MODEL = os.getenv("ANTHROPIC_MODEL_SONNET", "claude-sonnet-4-6")


# ── Cache helpers ─────────────────────────────────────────────────────────────

async def _get_cache(symbol: str, date: str) -> Optional[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM fundamental_cache WHERE symbol = ? AND date = ?",
            (symbol, date)
        ) as cur:
            row = await cur.fetchone()
    if not row:
        return None
    d = dict(row)
    for field in ("raw_json", "analysis_haiku_json", "analysis_sonnet_json", "fetch_errors_json"):
        if d.get(field):
            try:
                d[field] = json.loads(d[field])
            except Exception:
                pass
    return d


async def _save_cache(symbol: str, date: str, raw: dict,
                      analysis: dict, model_key: str, errors: list) -> None:
    analysis_field = "analysis_haiku_json" if model_key == "haiku" else "analysis_sonnet_json"
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            f"""INSERT INTO fundamental_cache
                (symbol, date, raw_json, {analysis_field}, fetch_errors_json, created_at)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(symbol, date) DO UPDATE SET
                {analysis_field} = excluded.{analysis_field},
                fetch_errors_json = excluded.fetch_errors_json""",
            (symbol, date,
             json.dumps(raw),
             json.dumps(analysis),
             json.dumps(errors),
             datetime.now(UTC).isoformat())
        )
        await db.commit()


async def _update_analysis_cache(symbol: str, date: str, analysis: dict, model_key: str) -> None:
    """Update only the analysis column (when raw data already cached, re-running LLM)."""
    field = "analysis_haiku_json" if model_key == "haiku" else "analysis_sonnet_json"
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            f"UPDATE fundamental_cache SET {field} = ? WHERE symbol = ? AND date = ?",
            (json.dumps(analysis), symbol, date)
        )
        await db.commit()


# ── Claude prompt ─────────────────────────────────────────────────────────────

def _build_prompt(symbol: str, raw: dict, signal_data: Optional[dict]) -> str:
    quarterly = raw.get("quarterly", [])
    balance   = raw.get("balance") or {}
    fh        = raw.get("finnhub") or {}

    def fmt_m(v):
        if v is None: return "N/A"
        b = v / 1e9
        if abs(b) >= 1: return f"${b:.2f}B"
        return f"${v/1e6:.0f}M"

    def fmt_pct(v):
        return f"{v:+.1f}%" if v is not None else "N/A"

    # Format last 4 quarters for LLM
    q_lines = []
    for i, q in enumerate(quarterly[:4]):
        label = f"Q{i+1} ({q['period']})"
        beat  = f"+{q['eps_surprise_pct']:.1f}% beat" if q.get('eps_beat') and q.get('eps_surprise_pct') else \
                (f"{q['eps_surprise_pct']:.1f}% miss" if q.get('eps_surprise_pct') else "N/A")
        q_lines.append(
            f"  {label}: Rev={fmt_m(q.get('revenue'))} (YoY {fmt_pct(q.get('revenue_yoy_pct'))}), "
            f"EPS={q.get('eps') or 'N/A'} (YoY {fmt_pct(q.get('eps_yoy_pct'))}, {beat}), "
            f"Net Margin={fmt_pct(q.get('net_margin'))}, "
            f"Gross Margin={fmt_pct(q.get('gross_margin'))}, "
            f"FCF={fmt_m(q.get('fcf'))}"
        )

    signal_block = ""
    if signal_data:
        signal_block = f"""
TECHNICAL SIGNAL:
  Type: {signal_data.get('signal_type', 'MOMENTUM').upper()}
  Confidence Score: {signal_data.get('confidence_score', 'N/A')}/100
  Market Regime: {signal_data.get('regime', 'UNKNOWN')}
  Key Drivers: {', '.join(signal_data.get('key_drivers', []) or [])}
"""
    else:
        signal_block = "\nTECHNICAL SIGNAL: No active signal — pure fundamental analysis requested.\n"

    return f"""You are a senior equity research analyst. Analyze {symbol}'s financials and determine whether they SUPPORT or CONTRADICT a trading signal.

FINANCIAL DATA (last 4 quarters, most recent first):
{chr(10).join(q_lines) if q_lines else "  No quarterly data available."}

BALANCE SHEET (latest):
  D/E Ratio: {balance.get('de_ratio') or 'N/A'}
  Total Debt: {fmt_m(balance.get('total_debt'))}
  Equity: {fmt_m(balance.get('total_equity'))}

MARKET METRICS (TTM):
  P/E: {fh.get('pe_ttm') or 'N/A'}
  Revenue Growth YoY: {fmt_pct(fh.get('revenue_growth_yoy'))}
  Net Margin TTM: {fmt_pct(fh.get('net_margin_ttm'))}
  ROE: {fmt_pct(fh.get('roe_ttm'))}
{signal_block}

ANALYSIS FRAMEWORK:
1. Growth Quality — Is revenue growing consistently? Is EPS growth aligned with revenue or artificially inflated?
2. Profitability — Are margins improving or shrinking? Is profitability sustainable?
3. Financial Strength — Is FCF positive and growing? Is debt manageable?
4. Signal Alignment — Do fundamentals support, contradict, or remain neutral to the technical signal?

RULES:
- Do NOT restate raw numbers verbatim — interpret them
- Be decisive, not vague
- If data is missing, note it briefly and work with what you have
- key_insights and risks: 2-4 bullets each, one sentence per bullet
- summary: 2-3 sentences max
- final_take: 1-2 sentences — the actionable bottom line

Respond with ONLY valid JSON in this exact structure:
{{
  "fundamental_strength": "STRONG | MODERATE | WEAK",
  "signal_alignment": "SUPPORTS | CONTRADICTS | NEUTRAL",
  "summary": "...",
  "key_insights": ["...", "..."],
  "risks": ["...", "..."],
  "final_take": "..."
}}"""


# ── LLM call ──────────────────────────────────────────────────────────────────

async def _run_llm(prompt: str, model_key: str) -> tuple[dict, float]:
    """Returns (parsed_analysis, cost_usd)."""
    import asyncio
    model  = HAIKU_MODEL if model_key == "haiku" else SONNET_MODEL
    client = anthropic.AsyncAnthropic()

    msg = await client.messages.create(
        model=model,
        max_tokens=1200,
        messages=[{"role": "user", "content": prompt}],
    )
    content = msg.content[0].text.strip()

    # Extract JSON even if wrapped in markdown
    if "```" in content:
        content = content.split("```")[1].lstrip("json").strip()

    analysis = json.loads(content)

    # Estimate cost
    in_tok  = msg.usage.input_tokens
    out_tok = msg.usage.output_tokens
    if model_key == "haiku":
        cost = in_tok / 1_000_000 * 1.0 + out_tok / 1_000_000 * 5.0
    else:
        cost = in_tok / 1_000_000 * 3.0 + out_tok / 1_000_000 * 15.0

    return analysis, round(cost, 5)


# ── Main entry ────────────────────────────────────────────────────────────────

async def get_fundamental_analysis(
    symbol: str,
    model: str = "haiku",
    signal_data: Optional[dict] = None,
    force_refresh: bool = False,
) -> dict:
    """
    Main entry point. Returns:
    {
      symbol, date, cached, model,
      quarterly: [...],   # up to 8 quarters
      balance: {...},
      finnhub: {...},
      analysis: { fundamental_strength, signal_alignment, summary, key_insights, risks, final_take },
      fetch_errors: [...],
      cost_usd: float,
    }
    """
    today    = datetime.now(UTC).strftime("%Y-%m-%d")
    model_key = "sonnet" if model == "sonnet" else "haiku"
    analysis_field = "analysis_haiku_json" if model_key == "haiku" else "analysis_sonnet_json"

    # Check cache
    cached_row = await _get_cache(symbol, today)

    raw    = None
    errors = []

    if cached_row and not force_refresh:
        raw    = cached_row.get("raw_json") or {}
        errors = cached_row.get("fetch_errors_json") or []
        # If we already have the analysis for this model, return immediately
        existing_analysis = cached_row.get(analysis_field)
        if existing_analysis and isinstance(existing_analysis, dict):
            quarterly = raw.get("quarterly", [])
            return {
                "symbol":        symbol,
                "date":          today,
                "cached":        True,
                "model":         model_key,
                "quarterly":     quarterly,
                "balance":       raw.get("balance"),
                "finnhub":       raw.get("finnhub", {}),
                "analysis":      existing_analysis,
                "fetch_errors":  errors,
                "cost_usd":      0.0,
            }

    # Fetch raw data if not cached or force_refresh
    if raw is None or force_refresh:
        raw_result = await fetch_fundamentals(symbol)
        raw    = raw_result
        errors = raw_result.get("errors", [])

    # Run LLM
    analysis = {}
    cost     = 0.0
    llm_err  = None
    try:
        prompt           = _build_prompt(symbol, raw, signal_data)
        analysis, cost   = await _run_llm(prompt, model_key)
    except json.JSONDecodeError as e:
        llm_err = f"LLM returned invalid JSON: {str(e)[:60]}"
        analysis = {
            "fundamental_strength": "UNKNOWN",
            "signal_alignment":     "NEUTRAL",
            "summary":              "Analysis parse error — raw data was fetched successfully.",
            "key_insights":         [],
            "risks":                [],
            "final_take":           "Unable to parse LLM output.",
        }
    except Exception as e:
        llm_err = f"LLM call failed: {str(e)[:80]}"
        analysis = {
            "fundamental_strength": "UNKNOWN",
            "signal_alignment":     "NEUTRAL",
            "summary":              f"LLM error: {str(e)[:120]}",
            "key_insights":         [],
            "risks":                [],
            "final_take":           "See error panel for details.",
        }

    if llm_err:
        errors = errors + [llm_err]

    # Save to cache
    try:
        await _save_cache(symbol, today, raw, analysis, model_key, errors)
    except Exception as e:
        logger.error("fundamental_engine: cache write failed: %s", e)

    return {
        "symbol":        symbol,
        "date":          today,
        "cached":        False,
        "model":         model_key,
        "quarterly":     raw.get("quarterly", []),
        "balance":       raw.get("balance"),
        "finnhub":       raw.get("finnhub", {}),
        "analysis":      analysis,
        "fetch_errors":  errors,
        "cost_usd":      cost,
    }
