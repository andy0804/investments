"""Bear Agent — challenges every assumption. Finds what the Bull Agent ignored."""

import os, json, logging
import anthropic
from app.analysis.alpha_agent import cost_tracker, lessons as lessons_mod

log = logging.getLogger(__name__)
MODEL = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")


async def run(ticker: str, research: dict, bull: dict,
              run_id: int | None = None, emit=None) -> dict:
    async def _emit(msg, confidence=None):
        if emit:
            try:
                await emit({"stage": "bear", "status": "running",
                            "message": msg, "confidence": confidence})
            except Exception:
                pass

    await _emit(f"Challenging the bull case for {ticker}…")

    active_lessons = await lessons_mod.get_active_lessons()
    lessons_block  = await lessons_mod.format_for_prompt(active_lessons)

    prompt = f"""You are the Bear Agent for Alpha Agent, an AI portfolio manager.

Your role: challenge every assumption in the bull case for {ticker}. You are a sceptic.
Find what is being ignored, underweighted, or misread.

RESEARCH BRIEF:
{json.dumps({k: v for k, v in research.items() if k != '_raw'}, indent=2)[:1500]}

BULL CASE TO CHALLENGE:
{json.dumps(bull, indent=2)[:1000]}

{lessons_block}

Build the bear case. Return JSON:
{{
  "ticker": "{ticker}",
  "verdict": "AVOID|WEAK_AVOID|NEUTRAL",
  "confidence": 0-100,
  "counter_thesis": "2-3 sentence rebuttal of the bull case",
  "top_concerns": [
    {{"concern": "specific concern with evidence", "severity": "high|medium|low"}}
  ],
  "downside_scenario": "what happens if things go wrong",
  "invalidation_conditions": ["condition that would invalidate bull thesis"],
  "what_bull_missed": "key risk the bull case underweighted"
}}

Return ONLY valid JSON."""

    client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
    try:
        response = await client.messages.create(
            model=MODEL, max_tokens=700,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text.strip()
        await cost_tracker.log_call("bear", MODEL,
                                    response.usage.input_tokens,
                                    response.usage.output_tokens, run_id)
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        result = json.loads(text)
    except Exception as e:
        log.warning("bear_agent LLM failed: %s", e)
        result = {"ticker": ticker, "verdict": "NEUTRAL", "confidence": 50,
                  "counter_thesis": "Bear analysis unavailable.",
                  "top_concerns": [], "downside_scenario": "Unknown",
                  "invalidation_conditions": [], "what_bull_missed": "Unknown"}

    await _emit("Bear case complete", confidence=result.get("confidence"))
    return result
