"""Independent 'second opinion' lineage extractors used to cross-check the main
parsers. These use a deliberately different (naive regex) method, so agreement
with the primary parser is meaningful signal and disagreement flags review.

An optional LLM cross-check is wired in too; it is skipped automatically when no
API key is configured so the harness always runs offline.
"""
from __future__ import annotations

import re

from app.parsers.naming import split_name

Edge = tuple[str, str]


def _nid(raw: str) -> str:
    return split_name(raw)[0]


def _norm(edges: set[Edge]) -> set[Edge]:
    out: set[Edge] = set()
    for s, t in edges:
        si, ti = _nid(s), _nid(t)
        if si and ti and si != ti:
            out.add((si, ti))
    return out


# --------------------------------------------------------------------------- #
# SQL — naive statement scan (independent of sqlglot)
# --------------------------------------------------------------------------- #
_SQL_TGT = re.compile(
    r"\bcreate\s+(?:or\s+replace\s+)?(?:table|view)\s+([\w.\"`\[\]]+)\s+as\b"
    r"|\binsert\s+into\s+([\w.\"`\[\]]+)",
    re.IGNORECASE,
)
_SQL_SRC = re.compile(r"\b(?:from|join)\s+([\w.\"`\[\]]+)", re.IGNORECASE)


def _strip_sql_comments(code: str) -> str:
    code = re.sub(r"--[^\n]*", "", code)
    code = re.sub(r"/\*[\s\S]*?\*/", "", code)
    return code


def regex_sql_edges(code: str) -> set[Edge]:
    code = _strip_sql_comments(code)
    edges: set[Edge] = set()
    for stmt in code.split(";"):
        m = _SQL_TGT.search(stmt)
        if not m:
            continue
        target = m.group(1) or m.group(2)
        if not target:
            continue
        for sm in _SQL_SRC.finditer(stmt):
            edges.add((sm.group(1), target))
    return _norm(edges)


# --------------------------------------------------------------------------- #
# SAS — naive data-step / proc sql scan (independent of the main parser)
# --------------------------------------------------------------------------- #
_SAS_DATA = re.compile(
    r"(?<![=.\w])\bdata\s+([\w.&]+)\s*;[\s\S]*?\brun\s*;", re.IGNORECASE)
_SAS_SETLIKE = re.compile(r"\b(?:set|merge|update)\s+([^;]+);", re.IGNORECASE)
_SAS_CTAS = re.compile(
    r"\bcreate\s+table\s+([\w.&]+)\s+as\b[\s\S]*?(?=;)", re.IGNORECASE)
_SAS_FROMJOIN = re.compile(r"\b(?:from|join)\s+([\w.&]+)", re.IGNORECASE)


def _strip_sas_comments(code: str) -> str:
    code = re.sub(r"/\*[\s\S]*?\*/", "", code)
    code = re.sub(r"(?m)^\s*\*[^;]*;", "", code)
    return code


def regex_sas_edges(code: str) -> set[Edge]:
    code = _strip_sas_comments(code)
    edges: set[Edge] = set()
    for m in _SAS_DATA.finditer(code):
        target = m.group(1)
        block = m.group(0)
        for sm in _SAS_SETLIKE.finditer(block):
            for token in re.split(r"\s+", sm.group(1).strip()):
                token = re.sub(r"\(.*", "", token)   # drop (in=a) options
                if token and not token.startswith("("):
                    edges.add((token, target))
    for m in _SAS_CTAS.finditer(code):
        target = m.group(1)
        for sm in _SAS_FROMJOIN.finditer(m.group(0)):
            edges.add((sm.group(1), target))
    return _norm(edges)


def regex_edges(code: str, language: str) -> set[Edge]:
    if language == "sql":
        return regex_sql_edges(code)
    if language == "sas":
        return regex_sas_edges(code)
    return set()


def agreement(primary: set[Edge], secondary: set[Edge]) -> dict:
    inter = primary & secondary
    union = primary | secondary
    return {
        "jaccard": len(inter) / len(union) if union else 1.0,
        "only_primary": sorted(primary - secondary),
        "only_secondary": sorted(secondary - primary),
    }


# --------------------------------------------------------------------------- #
# Optional LLM cross-check (skipped when no API key is set)
# --------------------------------------------------------------------------- #
def llm_available() -> bool:
    try:
        from app import config
    except Exception:
        return False
    return bool(getattr(config, "GROQ_API_KEY", "") or "")
