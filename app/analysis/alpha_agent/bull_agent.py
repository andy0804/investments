"""Bull Agent — builds the strongest possible case FOR a trade."""

import os, json, logging
import anthropic
from app.analysis.alpha_agent import cost_tracker, lessons as lessons_mod

log = logging.getLogger(__name__)
MODEL = os.getenv("ANTHROPIC_MODEL_HAIKU", "claude-haiku-4-5-20251001")


async def run(ticker: str, research: dict, run_id: int | None = None, emit=None) -> dict:
    async def _emit(msg, confidence=None):
        if emit:
            try:
                await emit({"stage": "bull", "status": "running",
                            "message": msg, "confidence": confidence})
            except Exception:
                pass

    await _emit(f"Building bull case for {ticker}…")

    active_lessons = await lessons_mod.get_active_lessons()
    lessons_block  = await lessons_mod.format_for_prompt(active_lessons)

    prompt = f"""You are the Bull Agent for Alpha Agent, an AI portfolio manager.

Your role: argue the STRONGEST possible case for buying {ticker}. You are an optimist, but you only cite real evidence.

RESEARCH BRIEF:
{json.dumps({k: v for k, v in research.items() if k != '_raw'}, indent=2)[:2000]}

{lessons_block}

Build the bull case. Return JSON:
{{
  "ticker": "{ticker}",
  "verdict": "BUY|STRONG_BUY|WEAK_BUY",
  "confidence": 0-100,
  "thesis": "2-3 sentence core investment thesis",
  "top_reasons": [
    {{"reason": "specific evidence-backed reason", "strength": "strong|moderate|weak"}}
  ],
  "upside_scenario": "what happens if everything goes right",
  "expected_return_pct": estimated % upside over holding horizon,
  "time_horizon": "2-4 weeks|4-8 weeks|8-12 weeks",
  "key_conviction_drivers": ["driver 1", "driver 2"]
}}

Only cite evidence from the research brief. Return ONLY valid JSON."""

    client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
    try:
        response = await client.messages.create(
            model=MODEL, max_tokens=700,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text.strip()
        await cost_tracker.log_call("bull", MODEL,
                                    response.usage.input_tokens,
                                    response.usage.output_tokens, run_id)
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        result = json.loads(text)
    except Exception as e:
        log.warning("bull_agent LLM failed: %s", e)
        result = {"ticker": ticker, "verdict": "WEAK_BUY", "confidence": 50,
                  "thesis": "Bull analysis unavailable.",
                  "top_reasons": [], "upside_scenario": "Unknown",
                  "expected_return_pct": 0, "time_horizon": "4-8 weeks",
                  "key_conviction_drivers": []}

    await _emit("Bull case complete", confidence=result.get("confidence"))
    return result
