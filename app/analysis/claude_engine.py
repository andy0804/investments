# MODEL: haiku (default) or sonnet for advice/coaching
import json
import logging
import anthropic
import aiosqlite
from app.config import ANTHROPIC_API_KEY, ANTHROPIC_MODEL_HAIKU, ANTHROPIC_MODEL_SONNET, DB_PATH

logger = logging.getLogger(__name__)
client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

COST_PER_M = {
    ANTHROPIC_MODEL_HAIKU: {"input": 1.0, "output": 5.0},
    ANTHROPIC_MODEL_SONNET: {"input": 3.0, "output": 15.0},
}


def _calculate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    rates = COST_PER_M.get(model, COST_PER_M[ANTHROPIC_MODEL_HAIKU])
    return (input_tokens * rates["input"] + output_tokens * rates["output"]) / 1_000_000


async def call_claude(prompt: str, model: str = "haiku", job_name: str = "unknown") -> dict:
    model_id = ANTHROPIC_MODEL_SONNET if model == "sonnet" else ANTHROPIC_MODEL_HAIKU
    try:
        response = client.messages.create(
            model=model_id,
            max_tokens=1500,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text.strip()
        cost = _calculate_cost(model_id, response.usage.input_tokens, response.usage.output_tokens)

        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """INSERT INTO analysis_log (job_name, model, input_tokens, output_tokens, cost_usd)
                   VALUES (?,?,?,?,?)""",
                (job_name, model_id, response.usage.input_tokens, response.usage.output_tokens, cost),
            )
            await db.commit()

        logger.info("claude_engine: %s | model=%s | tokens=%d/%d | cost=$%.4f",
                    job_name, model_id, response.usage.input_tokens, response.usage.output_tokens, cost)

        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        return json.loads(raw)
    except json.JSONDecodeError as e:
        logger.error("claude_engine JSON parse failed for %s: %s | raw: %s", job_name, e, raw[:200])
        return {"error": "json_parse_failed", "raw": raw[:500]}
    except Exception as e:
        logger.error("claude_engine failed for %s: %s", job_name, e)
        return {"error": str(e)}


async def get_daily_cost() -> float:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT SUM(cost_usd) FROM analysis_log WHERE date(ran_at) = date('now')"
        ) as cur:
            row = await cur.fetchone()
    return row[0] or 0.0
