"""
app/analysis/stock_intelligence.py

Hybrid intelligence system: note ingestion → TF-IDF embedding → retrieval →
deterministic scoring → LLM synthesis → decision fusion.
"""
import json
import math
import re
import logging
from collections import Counter
from datetime import datetime, UTC

import aiosqlite

from app.config import DB_PATH
from app.analysis.claude_engine import call_claude

logger = logging.getLogger(__name__)

# ── TF-IDF Embedding ──────────────────────────────────────────────────────────

_STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
    "been", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "that", "this", "it", "its", "they",
    "their", "we", "you", "i", "he", "she", "which", "who", "not", "also",
    "just", "very", "more", "some", "its", "been", "both", "such",
}
_VOCAB_SIZE = 256


def _tokenize(text: str) -> list[str]:
    words = re.findall(r"\b[a-zA-Z][a-zA-Z0-9]*\b", text.lower())
    return [w for w in words if w not in _STOPWORDS and len(w) > 2]


def build_embedding(text: str) -> list[float]:
    """Hash-projected TF-IDF vector, L2-normalized."""
    tokens = _tokenize(text)
    if not tokens:
        return [0.0] * _VOCAB_SIZE
    tf = Counter(tokens)
    total = sum(tf.values())
    vec = [0.0] * _VOCAB_SIZE
    for word, count in tf.items():
        tfidf = count / total
        for salt in range(3):
            idx = hash(f"{word}|{salt}") % _VOCAB_SIZE
            vec[idx] += tfidf
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return dot / (na * nb)


# ── Ingestion ─────────────────────────────────────────────────────────────────

_INGEST_PROMPT = """You are a financial analyst assistant. Extract structured information from the following investment research note.

Note:
{text}

Return ONLY valid JSON (no markdown) with this exact structure:
{{
  "ticker": "primary stock ticker mentioned (uppercase, e.g. AAPL) or null if unclear",
  "thesis": "bullish" or "bearish" or "neutral",
  "signals": ["list of up to 5 specific positive/bullish signals mentioned"],
  "risks": ["list of up to 5 specific risks or bearish factors mentioned"],
  "timeframe": "investment timeframe mentioned, e.g. 'next quarter', '12 months', 'long term', or null",
  "confidence": integer 1-10 how confident you are in the extraction quality
}}"""


async def ingest_note(ticker: str, raw_text: str, source_label: str = "own_note") -> dict:
    """Extract signals from raw text, compute embedding, store in DB. Returns note_id and signals."""
    now = datetime.now(UTC).isoformat()
    ticker = ticker.upper().strip()

    prompt = _INGEST_PROMPT.format(text=raw_text[:3000])
    extracted = await call_claude(prompt, model="haiku", job_name="stock_intel_ingest")

    if extracted.get("error"):
        logger.warning("ingest_note: extraction failed for %s: %s", ticker, extracted)
        # Store anyway with minimal data
        extracted = {"ticker": ticker, "thesis": "neutral", "signals": [], "risks": [], "timeframe": None, "confidence": 1}

    # Override ticker with user-supplied one (they know what they're researching)
    extracted["ticker"] = ticker

    embedding = build_embedding(raw_text)
    embedding_json = json.dumps(embedding)

    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO stock_intelligence_notes (ticker, raw_text, source_label, created_at, embedding_json) VALUES (?,?,?,?,?)",
            (ticker, raw_text[:5000], source_label, now, embedding_json),
        )
        note_id = cur.lastrowid

        await db.execute(
            """INSERT INTO stock_intelligence_signals
               (note_id, ticker, thesis, signals_json, risks_json, timeframe, confidence, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                note_id, ticker,
                extracted.get("thesis", "neutral"),
                json.dumps(extracted.get("signals", [])),
                json.dumps(extracted.get("risks", [])),
                extracted.get("timeframe"),
                extracted.get("confidence", 5),
                now,
            ),
        )
        await db.commit()

    logger.info("ingest_note: stored note_id=%d ticker=%s thesis=%s", note_id, ticker, extracted.get("thesis"))
    return {
        "note_id": note_id,
        "ticker": ticker,
        "thesis": extracted.get("thesis", "neutral"),
        "signals": extracted.get("signals", []),
        "risks": extracted.get("risks", []),
        "timeframe": extracted.get("timeframe"),
        "confidence": extracted.get("confidence", 5),
    }


# ── Retrieval ─────────────────────────────────────────────────────────────────

async def retrieve_signals(ticker: str, top_k: int = 8) -> list[dict]:
    """Hybrid retrieval: exact ticker match + semantic similarity, recency-weighted."""
    ticker = ticker.upper().strip()
    target_emb = build_embedding(ticker)

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT n.id, n.ticker, n.raw_text, n.source_label, n.created_at, n.embedding_json,
                      s.thesis, s.signals_json, s.risks_json, s.timeframe, s.confidence
               FROM stock_intelligence_notes n
               JOIN stock_intelligence_signals s ON s.note_id = n.id
               ORDER BY n.created_at DESC
               LIMIT 200""",
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]

    if not rows:
        return []

    now = datetime.now(UTC)
    scored = []
    for row in rows:
        # Exact ticker match gets a large boost
        exact = 1.0 if row["ticker"] == ticker else 0.0

        # Semantic similarity against note content
        if row.get("embedding_json"):
            try:
                emb = json.loads(row["embedding_json"])
                sim = _cosine(target_emb, emb)
            except Exception:
                sim = 0.0
        else:
            sim = 0.0

        # Recency weight: last 7d = 2×, last 30d = 1×, older = 0.4×
        try:
            note_dt = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
            days_ago = (now - note_dt).days
        except Exception:
            days_ago = 999
        if days_ago <= 7:
            recency = 2.0
        elif days_ago <= 30:
            recency = 1.0
        else:
            recency = 0.4

        score = (exact * 5.0 + sim) * recency
        scored.append((score, row))

    scored.sort(key=lambda x: x[0], reverse=True)
    results = []
    for score, row in scored[:top_k]:
        results.append({
            "note_id":      row["id"],
            "ticker":       row["ticker"],
            "source_label": row["source_label"],
            "created_at":   row["created_at"],
            "thesis":       row["thesis"],
            "signals":      json.loads(row.get("signals_json") or "[]"),
            "risks":        json.loads(row.get("risks_json") or "[]"),
            "timeframe":    row["timeframe"],
            "confidence":   row["confidence"],
            "relevance":    round(score, 3),
            "raw_preview":  row["raw_text"][:200],
        })
    return results


# ── Deterministic Scoring ─────────────────────────────────────────────────────

async def _score_technical(ticker: str) -> tuple[float, dict, str]:
    try:
        from app.analysis.technicals import compute_technicals
        t = await compute_technicals(ticker)
        if not t:
            return 5.0, {}, "No technical data available."
        score = 5.0
        reasons = []
        rsi = float(t.get("rsi", 50))
        if 40 <= rsi <= 65:
            score += 2.0
            reasons.append(f"RSI {rsi:.1f} is in the healthy momentum zone (40–65) ↑")
        elif rsi < 30:
            score += 1.0
            reasons.append(f"RSI {rsi:.1f} is oversold — potential bounce territory")
        elif rsi > 75:
            score -= 2.0
            reasons.append(f"RSI {rsi:.1f} is overbought (>75) — stock may be overextended ↓")
        elif rsi > 65:
            score -= 0.5
            reasons.append(f"RSI {rsi:.1f} is elevated (>65) — momentum strong but watch for reversal")
        else:
            reasons.append(f"RSI {rsi:.1f} is neutral")

        macd_cross = t.get("macd_crossover", "bearish")
        if macd_cross == "bullish":
            score += 1.5
            reasons.append("MACD bullish crossover — upward momentum signal ↑")
        else:
            score -= 0.5
            reasons.append("MACD bearish crossover — downward momentum signal ↓")

        above_sma = bool(t.get("above_sma_50", False))
        if above_sma:
            score += 1.0
            reasons.append("Price above 50-day moving average — uptrend intact ↑")
        else:
            score -= 1.0
            reasons.append("Price below 50-day moving average — downtrend or consolidation ↓")

        vr = float(t.get("volume_ratio", 1.0))
        if vr > 1.5:
            score += 0.5
            reasons.append(f"Volume {vr:.1f}× above average — strong buyer conviction ↑")

        price = t.get("price")
        detail = {
            "rsi": rsi, "macd_crossover": macd_cross, "above_sma_50": above_sma,
            "volume_ratio": round(vr, 2), "price": float(price) if price is not None else None,
        }
        return max(0.0, min(10.0, score)), detail, " ".join(reasons)
    except Exception as e:
        logger.warning("_score_technical %s: %s", ticker, e)
        return 5.0, {}, "Technical data unavailable."


async def _score_macro() -> tuple[float, dict, str]:
    try:
        from app.analysis.macro import get_macro_snapshot
        m = await get_macro_snapshot()
        vix = m.get("vix") or 20
        regime = (m.get("regime") or m.get("market_regime") or "").lower()
        reasons = []
        if "bull" in regime:
            score = 7.5
            reasons.append(f"Market is in BULL regime — tailwind for long positions ↑")
        elif "bear" in regime:
            score = 3.0
            reasons.append(f"Market is in BEAR regime — headwind for new positions ↓")
        else:
            score = 5.0
            reasons.append(f"Market is in CHOP/neutral regime — no strong directional bias")

        if vix < 15:
            score += 1.0
            reasons.append(f"VIX {vix:.1f} is very low — calm, low-fear market ↑")
        elif vix > 30:
            score -= 2.0
            reasons.append(f"VIX {vix:.1f} is elevated (>30) — high fear, risky entry ↓")
        elif vix > 20:
            score -= 0.5
            reasons.append(f"VIX {vix:.1f} is slightly elevated — mild caution ↓")
        else:
            reasons.append(f"VIX {vix:.1f} is normal — market not stressed")

        return max(0.0, min(10.0, score)), {"vix": vix, "regime": regime}, " ".join(reasons)
    except Exception as e:
        logger.warning("_score_macro: %s", e)
        return 5.0, {}, "Macro data unavailable."


async def _score_sentiment(ticker: str, signals: list[dict]) -> tuple[float, dict, str]:
    """Sentiment from stored intelligence signals for this ticker."""
    ticker_signals = [s for s in signals if s["ticker"] == ticker]
    if not ticker_signals:
        return 5.0, {"note_count": 0}, "No research notes found for this ticker — add notes to improve this score."

    bullish = sum(1 for s in ticker_signals if s["thesis"] == "bullish")
    bearish = sum(1 for s in ticker_signals if s["thesis"] == "bearish")
    neutral = len(ticker_signals) - bullish - bearish
    total = len(ticker_signals)
    bull_pct = bullish / total if total > 0 else 0.5
    score = 2.0 + bull_pct * 8.0
    avg_conf = sum(s.get("confidence", 5) for s in ticker_signals) / total
    score = score * (0.5 + avg_conf / 20.0)

    parts = []
    if bullish:
        parts.append(f"{bullish} bullish note{'s' if bullish > 1 else ''}")
    if bearish:
        parts.append(f"{bearish} bearish note{'s' if bearish > 1 else ''}")
    if neutral:
        parts.append(f"{neutral} neutral note{'s' if neutral > 1 else ''}")
    note_summary = ", ".join(parts) if parts else f"{total} notes"
    reason = f"Based on {note_summary} (avg confidence {avg_conf:.0f}/10). "
    if bullish > bearish:
        reason += "Your notes lean bullish ↑"
    elif bearish > bullish:
        reason += "Your notes lean bearish ↓"
    else:
        reason += "Your notes are mixed — no clear directional signal."

    return max(0.0, min(10.0, score)), {"bullish": bullish, "bearish": bearish, "neutral": neutral, "avg_confidence": round(avg_conf, 1)}, reason


async def _score_valuation(ticker: str) -> tuple[float, dict, str]:
    try:
        from app.analysis.fundamentals import get_fundamentals
        f = await get_fundamentals(ticker)
        if not f:
            return 5.0, {}, "No valuation data available."
        score = 5.0
        reasons = []
        pe = f.get("pe_ratio")
        if pe and 0 < pe < 20:
            score += 2.0
            reasons.append(f"P/E ratio {pe:.1f} is low (<20) — stock looks cheap vs earnings ↑")
        elif pe and pe > 50:
            score -= 2.0
            reasons.append(f"P/E ratio {pe:.1f} is very high (>50) — expensive, priced for perfection ↓")
        elif pe and pe > 30:
            score -= 0.5
            reasons.append(f"P/E ratio {pe:.1f} is elevated (>30) — paying a premium ↓")
        elif pe:
            reasons.append(f"P/E ratio {pe:.1f} is reasonable")
        else:
            reasons.append("P/E ratio unavailable")

        beta = float(f.get("beta") or 1.0)
        if beta < 0.8:
            score += 0.5
            reasons.append(f"Beta {beta:.2f} — low market sensitivity, defensive ↑")
        elif beta > 1.8:
            score -= 0.5
            reasons.append(f"Beta {beta:.2f} — high volatility vs market ↓")
        else:
            reasons.append(f"Beta {beta:.2f} — normal market sensitivity")

        return max(0.0, min(10.0, score)), {"pe_ratio": pe, "beta": beta}, " ".join(reasons)
    except Exception as e:
        logger.warning("_score_valuation %s: %s", ticker, e)
        return 5.0, {}, "Valuation data unavailable."


async def _score_momentum(ticker: str) -> tuple[float, dict, str]:
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT price, change_pct FROM market_data WHERE symbol = ?", (ticker,)
            ) as cur:
                row = await cur.fetchone()
        if not row or row[1] is None:
            return 5.0, {}, "No live price data — run a market data sync first."
        change_pct = row[1]
        price = row[0]
        if change_pct > 3:
            score, note = 8.5, f"Up {change_pct:.1f}% today — strong buying pressure ↑"
        elif change_pct > 1:
            score, note = 7.0, f"Up {change_pct:.1f}% today — positive momentum ↑"
        elif change_pct > 0:
            score, note = 5.5, f"Up {change_pct:.1f}% today — mild positive drift"
        elif change_pct > -1:
            score, note = 4.5, f"Down {change_pct:.1f}% today — slight weakness"
        elif change_pct > -3:
            score, note = 3.0, f"Down {change_pct:.1f}% today — selling pressure ↓"
        else:
            score, note = 1.5, f"Down {change_pct:.1f}% today — heavy selling ↓"
        return score, {"change_pct": change_pct, "price": price}, note
    except Exception as e:
        logger.warning("_score_momentum %s: %s", ticker, e)
        return 5.0, {}, "Momentum data unavailable."


async def _score_risk(ticker: str) -> tuple[float, dict, str]:
    """Higher score = LOWER risk (better for buying)."""
    try:
        from app.analysis.fundamentals import get_fundamentals
        f = await get_fundamentals(ticker)
        beta = float((f.get("beta") if f else None) or 1.0)
        if beta < 0.8:
            score, note = 8.0, f"Beta {beta:.2f} — low volatility, moves less than the market. Lower drawdown risk ↑"
        elif beta < 1.2:
            score, note = 6.5, f"Beta {beta:.2f} — market-like volatility. Standard risk profile"
        elif beta < 1.6:
            score, note = 5.0, f"Beta {beta:.2f} — moderately volatile. Wider stop-loss may be needed ↓"
        else:
            score, note = 3.0, f"Beta {beta:.2f} — high volatility. Significant downside risk in selloffs ↓"
        return score, {"beta": beta}, note
    except Exception as e:
        logger.warning("_score_risk %s: %s", ticker, e)
        return 5.0, {}, "Risk data unavailable."


async def _score_catalyst(ticker: str) -> tuple[float, dict, str]:
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT COUNT(*) FROM events WHERE related_symbols LIKE ? AND event_date > datetime('now', '-7 days')",
                (f"%{ticker}%",),
            ) as cur:
                event_count = (await cur.fetchone())[0]
        score = min(10.0, 4.0 + event_count * 1.5)
        if event_count == 0:
            note = "No recent events in the last 7 days — quiet news period"
        elif event_count <= 2:
            note = f"{event_count} recent event{'s' if event_count > 1 else ''} — some activity ↑"
        else:
            note = f"{event_count} recent events — high news activity, monitor closely ↑"
        return score, {"recent_events": event_count}, note
    except Exception as e:
        logger.warning("_score_catalyst %s: %s", ticker, e)
        return 4.0, {}, "Catalyst data unavailable."


async def compute_deterministic_scores(ticker: str, retrieved_signals: list[dict]) -> dict:
    """Run all sub-scorers and return composite with per-score reasoning."""
    t_score,  t_detail,  t_reason  = await _score_technical(ticker)
    m_score,  m_detail,  m_reason  = await _score_macro()
    s_score,  s_detail,  s_reason  = await _score_sentiment(ticker, retrieved_signals)
    v_score,  v_detail,  v_reason  = await _score_valuation(ticker)
    mo_score, mo_detail, mo_reason = await _score_momentum(ticker)
    r_score,  r_detail,  r_reason  = await _score_risk(ticker)
    c_score,  c_detail,  c_reason  = await _score_catalyst(ticker)

    weights = {"technical": 0.20, "macro": 0.15, "sentiment": 0.20,
               "valuation": 0.15, "momentum": 0.10, "risk": 0.10, "catalyst": 0.10}
    composite = (
        t_score  * weights["technical"]  +
        m_score  * weights["macro"]      +
        s_score  * weights["sentiment"]  +
        v_score  * weights["valuation"]  +
        mo_score * weights["momentum"]   +
        r_score  * weights["risk"]       +
        c_score  * weights["catalyst"]
    )
    return {
        "technical":    round(t_score, 1),
        "macro":        round(m_score, 1),
        "sentiment":    round(s_score, 1),
        "valuation":    round(v_score, 1),
        "momentum":     round(mo_score, 1),
        "risk":         round(r_score, 1),
        "catalyst":     round(c_score, 1),
        "composite":    round(composite, 2),
        "details": {
            "technical": t_detail, "macro": m_detail, "sentiment": s_detail,
            "valuation": v_detail, "momentum": mo_detail, "risk": r_detail,
            "catalyst": c_detail,
        },
        "reasons": {
            "technical": t_reason, "macro": m_reason, "sentiment": s_reason,
            "valuation": v_reason, "momentum": mo_reason, "risk": r_reason,
            "catalyst": c_reason,
        },
    }


# ── LLM Synthesis ─────────────────────────────────────────────────────────────

_SYNTHESIS_PROMPT = """You are an expert equity analyst giving a plain-English verdict for a retail investor.

Ticker: {ticker}
Composite Score: {deterministic_score}/10

Score breakdown:
{score_breakdown}

Research notes found ({evidence_count} notes):
{evidence_text}

Your job: explain the verdict in plain English so a non-expert investor understands EXACTLY why the score came out this way — which notes support or contradict the buy thesis, and which specific metrics are most impactful.

Return ONLY valid JSON (no markdown):
{{
  "verdict": "BUY" or "HOLD" or "SELL" or "WATCH",
  "confidence": integer 1-10,
  "reasoning": "3-5 sentence plain-English explanation. Start with the verdict, then explain the 2-3 biggest drivers (mention specific score names and values), and close with the key risk to watch.",
  "note_attributions": [
    "Your [source_label] note from [date] said '[key phrase]' — this [supports / contradicts / raises caution about] the bullish thesis because [brief why]"
  ],
  "key_strengths": ["up to 3 specific strengths with metric values where possible"],
  "key_risks": ["up to 3 specific risks with metric values where possible"],
  "suggested_action": "One concrete sentence: what to do and under what condition (e.g. 'Consider a starter position if RSI pulls back below 65 or MACD holds the bullish cross at next week\\'s open')"
}}"""


def _build_evidence_text(signals: list[dict]) -> str:
    if not signals:
        return "No intelligence notes found for this ticker."
    lines = []
    for i, s in enumerate(signals[:6], 1):
        bull = ", ".join(s.get("signals", [])[:3]) or "none"
        risk = ", ".join(s.get("risks", [])[:3]) or "none"
        lines.append(
            f"[{i}] {s['created_at'][:10]} ({s['source_label']}) — "
            f"Thesis: {s['thesis'].upper()} | "
            f"Signals: {bull} | Risks: {risk}"
        )
    return "\n".join(lines)


def _to_native(obj):
    """Recursively convert numpy scalars to Python native types for JSON serialization."""
    import numpy as np
    if isinstance(obj, dict):
        return {k: _to_native(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_to_native(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    return obj


async def run_full_analysis(ticker: str) -> dict:
    """Orchestrates retrieval → scoring → LLM → fusion. Returns complete analysis."""
    ticker = ticker.upper().strip()

    retrieved = await retrieve_signals(ticker, top_k=8)
    scores = await compute_deterministic_scores(ticker, retrieved)

    evidence_text = _build_evidence_text(retrieved)

    # Build human-readable score breakdown for the prompt
    reasons = scores.get("reasons", {})
    score_breakdown_lines = [
        f"  Technical  {scores['technical']:.1f}/10 — {reasons.get('technical', '')}",
        f"  Macro      {scores['macro']:.1f}/10 — {reasons.get('macro', '')}",
        f"  Sentiment  {scores['sentiment']:.1f}/10 — {reasons.get('sentiment', '')}",
        f"  Valuation  {scores['valuation']:.1f}/10 — {reasons.get('valuation', '')}",
        f"  Momentum   {scores['momentum']:.1f}/10 — {reasons.get('momentum', '')}",
        f"  Risk       {scores['risk']:.1f}/10 — {reasons.get('risk', '')}",
        f"  Catalyst   {scores['catalyst']:.1f}/10 — {reasons.get('catalyst', '')}",
    ]

    prompt = _SYNTHESIS_PROMPT.format(
        ticker=ticker,
        deterministic_score=round(scores["composite"], 1),
        score_breakdown="\n".join(score_breakdown_lines),
        evidence_count=len(retrieved),
        evidence_text=evidence_text,
    )
    llm = await call_claude(prompt, model="sonnet", job_name=f"stock_intel_synthesis_{ticker}")

    if llm.get("error"):
        llm = {"verdict": "WATCH", "confidence": 5, "reasoning": "LLM synthesis unavailable.", "key_strengths": [], "key_risks": [], "suggested_action": "Unable to generate recommendation."}

    verdict    = llm.get("verdict", "WATCH")
    llm_conf   = llm.get("confidence", 5)

    # Decision fusion: 50% deterministic, 30% LLM confidence, 20% evidence strength
    exact_note_count = len([r for r in retrieved if r["ticker"] == ticker])
    evidence_strength = min(10.0, exact_note_count * 2.0)
    _w = {"composite": 0.50, "llm": 0.30, "evidence": 0.20}
    fusion_breakdown = {
        "composite_contribution":  round(scores["composite"] * _w["composite"], 3),
        "llm_contribution":        round(llm_conf * _w["llm"], 3),
        "evidence_contribution":   round(evidence_strength * _w["evidence"], 3),
        "composite_weight":        _w["composite"],
        "llm_weight":              _w["llm"],
        "evidence_weight":         _w["evidence"],
        "evidence_strength":       round(evidence_strength, 1),
        "exact_note_count":        exact_note_count,
        "sub_weights": {"technical": 0.20, "macro": 0.15, "sentiment": 0.20,
                        "valuation": 0.15, "momentum": 0.10, "risk": 0.10, "catalyst": 0.10},
    }
    fusion = round(
        scores["composite"] * _w["composite"] +
        llm_conf            * _w["llm"] +
        evidence_strength   * _w["evidence"],
        2,
    )

    now = datetime.now(UTC).isoformat()
    note_ids = json.dumps([r["note_id"] for r in retrieved])

    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO stock_analysis_runs
               (ticker, technical_score, macro_score, sentiment_score, valuation_score,
                momentum_score, risk_score, catalyst_score, deterministic_score,
                llm_verdict, llm_confidence, fusion_score, reasoning,
                evidence_summary, evidence_note_ids, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                ticker, scores["technical"], scores["macro"], scores["sentiment"],
                scores["valuation"], scores["momentum"], scores["risk"], scores["catalyst"],
                scores["composite"], verdict, llm_conf, fusion,
                llm.get("reasoning", ""), evidence_text[:2000], note_ids, now,
            ),
        )
        run_id = cur.lastrowid

        for r in retrieved:
            await db.execute(
                "INSERT INTO analysis_memory_links (run_id, note_id, relevance_score) VALUES (?,?,?)",
                (run_id, r["note_id"], r["relevance"]),
            )
        await db.commit()

    return _to_native({
        "run_id":             run_id,
        "ticker":             ticker,
        "scores":             scores,
        "verdict":            verdict,
        "llm_confidence":     llm_conf,
        "fusion_score":       fusion,
        "fusion_breakdown":   fusion_breakdown,
        "reasoning":          llm.get("reasoning", ""),
        "note_attributions":  llm.get("note_attributions", []),
        "key_strengths":      llm.get("key_strengths", []),
        "key_risks":          llm.get("key_risks", []),
        "suggested_action":   llm.get("suggested_action", ""),
        "evidence":           retrieved,
        "created_at":         now,
    })


# ── Contradiction Detection ───────────────────────────────────────────────────

async def detect_contradictions(ticker: str) -> list[dict]:
    """Compare last 2 analysis runs for thesis drift."""
    ticker = ticker.upper().strip()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT id, llm_verdict, deterministic_score, fusion_score, created_at
               FROM stock_analysis_runs WHERE ticker = ? ORDER BY created_at DESC LIMIT 5""",
            (ticker,),
        ) as cur:
            runs = [dict(r) for r in await cur.fetchall()]

    if len(runs) < 2:
        return []

    contradictions = []
    verdicts = [r["llm_verdict"] for r in runs[:3]]
    bullish_verdicts = {"BUY"}
    bearish_verdicts = {"SELL"}

    # Flag if verdict swung from bullish to bearish or vice versa
    for i in range(len(verdicts) - 1):
        prev, curr = verdicts[i + 1], verdicts[i]
        if prev in bullish_verdicts and curr in bearish_verdicts:
            contradictions.append({
                "type": "thesis_drift",
                "message": f"Verdict shifted from {prev} → {curr} — thesis has reversed",
                "from_run": runs[i + 1]["id"],
                "to_run": runs[i]["id"],
                "from_date": runs[i + 1]["created_at"][:10],
                "to_date": runs[i]["created_at"][:10],
            })
        elif prev in bearish_verdicts and curr in bullish_verdicts:
            contradictions.append({
                "type": "thesis_drift",
                "message": f"Verdict shifted from {prev} → {curr} — thesis has reversed",
                "from_run": runs[i + 1]["id"],
                "to_run": runs[i]["id"],
                "from_date": runs[i + 1]["created_at"][:10],
                "to_date": runs[i]["created_at"][:10],
            })

    # Also flag if fusion_score swung >3 points
    if len(runs) >= 2:
        delta = abs(runs[0]["fusion_score"] - runs[1]["fusion_score"])
        if delta >= 3.0:
            contradictions.append({
                "type": "score_swing",
                "message": f"Fusion score changed by {delta:.1f} points between analyses",
                "from_run": runs[1]["id"],
                "to_run": runs[0]["id"],
                "from_date": runs[1]["created_at"][:10],
                "to_date": runs[0]["created_at"][:10],
            })

    return contradictions


# ── History & Notes ───────────────────────────────────────────────────────────

async def get_analysis_history(ticker: str, limit: int = 10) -> list[dict]:
    ticker = ticker.upper().strip()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT id, ticker, deterministic_score, llm_verdict, llm_confidence,
                      fusion_score, reasoning, created_at
               FROM stock_analysis_runs WHERE ticker = ? ORDER BY created_at DESC LIMIT ?""",
            (ticker, limit),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_notes(ticker: str) -> list[dict]:
    ticker = ticker.upper().strip()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT n.id, n.ticker, n.raw_text, n.source_label, n.created_at,
                      s.thesis, s.signals_json, s.risks_json, s.timeframe, s.confidence
               FROM stock_intelligence_notes n
               LEFT JOIN stock_intelligence_signals s ON s.note_id = n.id
               WHERE n.ticker = ? ORDER BY n.created_at DESC""",
            (ticker,),
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    for r in rows:
        r["signals"] = json.loads(r.get("signals_json") or "[]")
        r["risks"]   = json.loads(r.get("risks_json") or "[]")
    return rows


async def delete_note(note_id: int) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT id FROM stock_intelligence_notes WHERE id = ?", (note_id,)) as cur:
            if not await cur.fetchone():
                return False
        await db.execute("DELETE FROM stock_intelligence_notes WHERE id = ?", (note_id,))
        await db.commit()
    return True
