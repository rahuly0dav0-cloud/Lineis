"""AI review agent: routes low-confidence / unresolved lineage to Groq.

The static parsers resolve what they can and tag every operation with a
confidence. This agent takes the operations the parsers were least sure about,
gives the LLM the surrounding code evidence, and asks it to propose lineage
with explicit assumptions and a confidence level — mirroring the
"agent for unresolved cases" step of the field-level lineage vision.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from .config import GROQ_API_KEY, GROQ_BASE_URL, GROQ_MODEL

_SYSTEM_PROMPT = (
    "You are a data-lineage review agent for a bank's regulatory reporting "
    "code (SQL, SAS, Python). You receive transformation operations that a "
    "static parser could not fully resolve, each with a code snippet. For each "
    "operation, infer the most likely source datasets and target dataset, state "
    "any assumptions, and give a confidence in [0,1]. Only use evidence in the "
    "snippet; never invent table names. Respond with STRICT JSON only."
)

_RESPONSE_SHAPE = (
    '{"suggestions":[{"op_id":"...","proposed_inputs":["..."],'
    '"proposed_target":"...","confidence":0.0,"assumptions":["..."],'
    '"rationale":"..."}]}'
)


def agent_available() -> bool:
    return bool(GROQ_API_KEY)


def _select_candidates(result: dict[str, Any], limit: int = 12) -> list[dict[str, Any]]:
    ops = result.get("operations", [])
    ranked = sorted(
        ops,
        key=lambda o: {"low": 0, "medium": 1, "high": 2}.get(o.get("confidence"), 1),
    )
    candidates = [o for o in ranked if o.get("confidence") in ("low", "medium")]
    return (candidates or ranked)[:limit]


def _call_groq(messages: list[dict[str, str]]) -> dict[str, Any]:
    body = json.dumps({
        "model": GROQ_MODEL,
        "messages": messages,
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")
    req = urllib.request.Request(
        GROQ_BASE_URL, data=body, method="POST",
        headers={
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    content = payload["choices"][0]["message"]["content"]
    return json.loads(content)


def review(result: dict[str, Any]) -> dict[str, Any]:
    if not agent_available():
        return {"error": "GROQ_API_KEY is not set on the server.",
                "suggestions": []}

    candidates = _select_candidates(result)
    if not candidates:
        return {"suggestions": [], "reviewed": 0,
                "message": "No low-confidence operations to review."}

    compact = [{
        "op_id": o.get("id"),
        "language": o.get("language"),
        "kind": o.get("kind"),
        "current_inputs": o.get("inputs", []),
        "current_target": o.get("target"),
        "confidence": o.get("confidence"),
        "file": o.get("file"),
        "snippet": (o.get("snippet") or "")[:1200],
    } for o in candidates]

    user_prompt = (
        "Review these operations and return JSON exactly matching this shape:\n"
        f"{_RESPONSE_SHAPE}\n\nOperations:\n"
        f"{json.dumps(compact, indent=2)}"
    )
    try:
        parsed = _call_groq([
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ])
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        return {"error": f"Groq API error {exc.code}: {detail}", "suggestions": []}
    except Exception as exc:  # network / parse issues
        return {"error": f"Agent call failed: {exc}", "suggestions": []}

    suggestions = parsed.get("suggestions", []) if isinstance(parsed, dict) else []
    return {
        "suggestions": suggestions,
        "reviewed": len(compact),
        "model": GROQ_MODEL,
    }
