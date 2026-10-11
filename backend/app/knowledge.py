"""Semantic knowledge base loader.

The agents work better with curated domain context — but shoving the whole KB
into every prompt is wasteful and noisy. This module loads the JSON knowledge
files and selects ONLY the entries relevant to the analysis at hand:

  * lineage_rules  -> always included (small, foundational)
  * sas_idioms     -> only idioms whose trigger strings appear in the code/warnings
  * glossary       -> only terms that actually appear in the dataset/column names
"""
from __future__ import annotations

import functools
import json
import re
from pathlib import Path
from typing import Any

KB_DIR = Path(__file__).resolve().parent / "knowledge"

_TOKEN = re.compile(r"[A-Za-z0-9]+")


def _tokens(text: str) -> set[str]:
    """Lower-cased alphanumeric tokens, so 'AB' never matches inside 'label'."""
    return {t.lower() for t in _TOKEN.findall(text)}


@functools.lru_cache(maxsize=8)
def _load(name: str) -> dict[str, Any]:
    path = KB_DIR / name
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def build_context(result: dict[str, Any]) -> dict[str, Any]:
    ops = result.get("operations", [])
    datasets = result.get("datasets", {}) or {}
    warnings = result.get("warnings", []) or []
    langs = {o.get("language") for o in ops}

    ctx: dict[str, Any] = {"lineage_rules": _load("lineage_rules.json").get("rules", [])}

    # SAS idioms — only those whose triggers appear in the evidence.
    if "sas" in langs or any("PROC" in w or "SAS" in w or "macro" in w for w in warnings):
        blob = " ".join([*(str(o.get("snippet", "")) for o in ops), *warnings]).lower()
        idioms = _load("sas_idioms.json").get("idioms", [])
        picked = [i for i in idioms if any(t in blob for t in i.get("triggers", []))]
        ctx["sas_idioms"] = picked or idioms[:4]

    # Glossary — only terms that appear as a WHOLE TOKEN in dataset/column names.
    # Exact-token matching (not substring) avoids injecting unrelated definitions
    # for short keys like 'AB', 'pd', 'ead' that would otherwise match inside words.
    name_tokens: set[str] = set()
    for key, d in datasets.items():
        name_tokens |= _tokens(str(key))
        name_tokens |= _tokens(str(d.get("name", "")))
        for col in d.get("columns", []) or []:
            name_tokens |= _tokens(str(col))
    glossary = _load("glossary.json").get("terms", {})
    matched = {k: v for k, v in glossary.items() if k.lower() in name_tokens}
    if matched:
        ctx["glossary"] = matched

    return ctx
