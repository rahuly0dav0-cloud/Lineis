"""Two-agent lineage review pipeline (Groq, OpenAI-compatible).

Stage 1 — DISCOVERY agent:
    Looks at the operations the static parser was least sure about (low/medium
    confidence) and the dynamic cases it flagged (SAS macros, SELECT INTO :,
    runtime-bound code). Using the curated knowledge base as grounding, it
    proposes the most likely lineage with explicit assumptions and a confidence.

Stage 2 — VALIDATION agent:
    Independently checks the discovery proposals (and a sample of the parser's
    own low-confidence edges) against the code evidence and the knowledge-base
    rules. It returns a verdict per item (confirmed / needs_review / rejected),
    concrete issues, and an adjusted confidence. This is the human-in-the-loop
    safety net: the first agent proposes, the second challenges.

Both stages are grounded in backend/app/knowledge/* via the knowledge loader,
so only context relevant to the current analysis is sent to the model.
"""
from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.request
from typing import Any

import certifi

from . import knowledge
from .config import GROQ_API_KEY, GROQ_BASE_URL, GROQ_MODEL

_SSL_CTX = ssl.create_default_context(cafile=certifi.where())

_DISCOVERY_SYSTEM = (
    "You are a data-lineage DISCOVERY agent for a bank's regulatory/reporting "
    "code (SQL, SAS, Python). You receive transformation operations a static "
    "parser could not fully resolve, each with a code snippet, plus a curated "
    "knowledge base. For each operation, infer the most likely source datasets, "
    "target dataset, and (if visible) key columns. Use ONLY the evidence and the "
    "knowledge base — never invent table or column names. State assumptions "
    "explicitly and give a confidence in [0,1]. Respond with STRICT JSON only."
)

_VALIDATION_SYSTEM = (
    "You are a data-lineage VALIDATION agent. You receive (a) proposed lineage "
    "from a discovery agent and (b) the code evidence and knowledge-base rules. "
    "Independently verify each proposal against the evidence and rules. Do not "
    "invent names. For each item return a verdict of 'confirmed', 'needs_review' "
    "or 'rejected', a list of concrete issues (empty if none), and an adjusted "
    "confidence in [0,1]. Respond with STRICT JSON only."
)

_DISCOVERY_SHAPE = (
    '{"proposals":[{"op_id":"...","proposed_inputs":["..."],'
    '"proposed_target":"...","columns":["..."],"confidence":0.0,'
    '"assumptions":["..."],"rationale":"..."}]}'
)
_VALIDATION_SHAPE = (
    '{"validations":[{"op_id":"...","verdict":"confirmed|needs_review|rejected",'
    '"confidence":0.0,"issues":["..."],"comment":"..."}]}'
)


def agent_available() -> bool:
    return bool(GROQ_API_KEY)


def _call_groq(system: str, user: str) -> dict[str, Any]:
    body = json.dumps({
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")
    req = urllib.request.Request(
        GROQ_BASE_URL, data=body, method="POST",
        headers={
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json",
            "User-Agent": "Lineis/0.2 (+lineage-review-agent)",
            "Accept": "application/json",
        },
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=90, context=_SSL_CTX) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            return json.loads(payload["choices"][0]["message"]["content"])
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt < 2:
                retry_after = exc.headers.get("Retry-After")
                wait = float(retry_after) if retry_after else 2.0 * (attempt + 1)
                time.sleep(min(wait, 8.0))
                continue
            raise


def _select_candidates(result: dict[str, Any], limit: int = 10) -> list[dict[str, Any]]:
    ops = result.get("operations", [])
    ranked = sorted(
        ops,
        key=lambda o: {"low": 0, "medium": 1, "high": 2}.get(o.get("confidence"), 1),
    )
    candidates = [o for o in ranked if o.get("confidence") in ("low", "medium")]
    return (candidates or ranked)[:limit]


def _compact(op: dict[str, Any]) -> dict[str, Any]:
    return {
        "op_id": op.get("id"),
        "language": op.get("language"),
        "kind": op.get("kind"),
        "current_inputs": op.get("inputs", []),
        "current_target": op.get("target"),
        "confidence": op.get("confidence"),
        "file": op.get("file"),
        "snippet": (op.get("snippet") or "")[:1000],
    }


def _discovery(candidates: list[dict[str, Any]], warnings: list[str],
               kb: dict[str, Any]) -> list[dict[str, Any]]:
    user = (
        "KNOWLEDGE BASE (grounding):\n"
        f"{json.dumps(kb, indent=2)}\n\n"
        "UNRESOLVED / DYNAMIC NOTES:\n"
        f"{json.dumps(warnings[:12], indent=2)}\n\n"
        "OPERATIONS TO RESOLVE (propose lineage for each):\n"
        f"{json.dumps([_compact(o) for o in candidates], indent=2)}\n\n"
        f"Return JSON exactly matching: {_DISCOVERY_SHAPE}"
    )
    parsed = _call_groq(_DISCOVERY_SYSTEM, user)
    return parsed.get("proposals", []) if isinstance(parsed, dict) else []


def _validation(proposals: list[dict[str, Any]], candidates: list[dict[str, Any]],
                kb: dict[str, Any]) -> list[dict[str, Any]]:
    evidence = {o.get("id"): (o.get("snippet") or "")[:600] for o in candidates}
    user = (
        "KNOWLEDGE-BASE RULES (grounding):\n"
        f"{json.dumps(kb.get('lineage_rules', []), indent=2)}\n\n"
        "CODE EVIDENCE (op_id -> snippet):\n"
        f"{json.dumps(evidence, indent=2)}\n\n"
        "PROPOSED LINEAGE TO VALIDATE:\n"
        f"{json.dumps(proposals, indent=2)}\n\n"
        f"Return JSON exactly matching: {_VALIDATION_SHAPE}"
    )
    parsed = _call_groq(_VALIDATION_SYSTEM, user)
    return parsed.get("validations", []) if isinstance(parsed, dict) else []


def review(result: dict[str, Any]) -> dict[str, Any]:
    if not agent_available():
        return {"error": "GROQ_API_KEY is not set on the server.",
                "proposals": [], "validations": []}

    candidates = _select_candidates(result)
    warnings = result.get("warnings", []) or []
    if not candidates and not warnings:
        return {"proposals": [], "validations": [], "reviewed": 0,
                "message": "No low-confidence operations or unresolved cases to review."}

    kb = knowledge.build_context(result)
    context_used = {
        "rules": len(kb.get("lineage_rules", [])),
        "sas_idioms": len(kb.get("sas_idioms", [])),
        "glossary": list(kb.get("glossary", {}).keys()),
    }

    try:
        proposals = _discovery(candidates, warnings, kb)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        return {"error": f"Discovery agent — Groq API error {exc.code}: {detail}",
                "proposals": [], "validations": []}
    except Exception as exc:
        return {"error": f"Discovery agent failed: {exc}",
                "proposals": [], "validations": []}

    validations: list[dict[str, Any]] = []
    if proposals:
        try:
            validations = _validation(proposals, candidates, kb)
        except Exception as exc:
            validations = [{"op_id": "*", "verdict": "needs_review",
                            "confidence": 0.0, "issues": [f"Validation agent failed: {exc}"],
                            "comment": "Proposals are unvalidated."}]

    return {
        "proposals": proposals,
        "validations": validations,
        "reviewed": len(candidates),
        "model": GROQ_MODEL,
        "stages": ["discovery", "validation"],
        "context_used": context_used,
    }
