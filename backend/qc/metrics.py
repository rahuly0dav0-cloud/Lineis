"""Pure scoring functions for the lineage QC harness.

All functions operate on a `ParseResult` (the parser IR) and/or raw source, so
they have no dependency on the web layer and are trivially unit-testable.
"""
from __future__ import annotations

import re
from typing import Iterable

from app.models import ParseResult
from app.parsers.naming import split_name

Edge = tuple[str, str]


# --------------------------------------------------------------------------- #
# Edge extraction + precision / recall
# --------------------------------------------------------------------------- #
def result_edges(result: ParseResult) -> set[Edge]:
    """Every (source_id -> target_id) edge the graph would draw for a result."""
    edges: set[Edge] = set()
    for op in result.operations:
        for src in op.inputs:
            if src and op.target and src != op.target:
                edges.add((src, op.target))
    return edges


def norm_edge(src: str, tgt: str) -> Edge:
    """Normalize a hand-labeled edge to the same ids the parser emits."""
    return split_name(src)[0], split_name(tgt)[0]


def score_edges(expected: set[Edge], actual: set[Edge], mode: str) -> dict:
    """Compare expected vs actual edges.

    mode="complete"  -> ground truth is exhaustive: count precision + recall.
    mode="subset"    -> only the labeled edges are known-true: count recall only
                        (extra parser edges are NOT treated as false positives).
    """
    tp = sorted(expected & actual)
    fn = sorted(expected - actual)
    fp = sorted(actual - expected) if mode == "complete" else []

    n_tp, n_fp, n_fn = len(tp), len(fp), len(fn)
    precision = n_tp / (n_tp + n_fp) if (n_tp + n_fp) else 1.0
    recall = n_tp / (n_tp + n_fn) if (n_tp + n_fn) else 1.0
    f1 = (2 * precision * recall / (precision + recall)
          if (precision + recall) else 0.0)
    return {
        "mode": mode,
        "tp": tp, "fp": fp, "fn": fn,
        "precision": precision, "recall": recall, "f1": f1,
    }


def check_forbidden(forbidden: Iterable[Edge], actual: set[Edge]) -> list[Edge]:
    """Edges that must NOT appear (regression guards for fixed bugs)."""
    return sorted(e for e in {norm_edge(*f) for f in forbidden} if e in actual)


# --------------------------------------------------------------------------- #
# Coverage: did we emit an operation for each lineage-producing construct?
# --------------------------------------------------------------------------- #
_CONSTRUCTS = {
    "sql": [
        r"\bcreate\s+(?:or\s+replace\s+)?(?:table|view)\b",
        r"\binsert\s+into\b",
        r"\bselect\b[\s\S]*?\binto\b",
    ],
    "sas": [
        r"(?<![=.\w])\bdata\s+[\w.&]",          # data step start (not data=)
        r"\bcreate\s+table\b",
        r"\bproc\s+sort\b[\s\S]*?\bout\s*=",
        r"\bproc\s+(?:gplot|sgplot|gchart|sgpanel|report|tabulate|export)\b",
    ],
    "python": [
        r"\.(?:to_\w+|saveastable|insertinto|save)\s*\(",
        r"\.write\b",
    ],
}


def _strip_comments(code: str, language: str) -> str:
    if language == "sql":
        code = re.sub(r"--[^\n]*", "", code)
        code = re.sub(r"/\*[\s\S]*?\*/", "", code)
    elif language == "sas":
        code = re.sub(r"/\*[\s\S]*?\*/", "", code)
        code = re.sub(r"(?m)^\s*\*[^;]*;", "", code)
    elif language == "python":
        code = re.sub(r"#[^\n]*", "", code)
    return code


def count_constructs(code: str, language: str) -> int:
    body = _strip_comments(code, language)
    total = 0
    for pat in _CONSTRUCTS.get(language, []):
        total += len(re.findall(pat, body, re.IGNORECASE))
    return total


def coverage(code: str, result: ParseResult, language: str) -> dict:
    """Approximate construct coverage + how many ops are actually wired."""
    constructs = count_constructs(code, language)
    ops_total = len(result.operations)
    ops_wired = sum(1 for op in result.operations if op.inputs)
    return {
        "constructs": constructs,
        "ops": ops_total,
        "ops_wired": ops_wired,
        "construct_coverage": min(1.0, ops_total / constructs) if constructs else 1.0,
        "wired_ratio": ops_wired / ops_total if ops_total else 1.0,
    }


# --------------------------------------------------------------------------- #
# Column capture report (table-level parsers capture output cols best-effort)
# --------------------------------------------------------------------------- #
def column_report(result: ParseResult) -> dict:
    ops = result.operations
    star_only = sum(1 for op in ops if op.columns and all(c == "*" for c in op.columns))
    with_cols = sum(1 for op in ops if op.columns and not all(c == "*" for c in op.columns))
    none = sum(1 for op in ops if not op.columns)
    opaque = star_only + none
    return {
        "ops": len(ops),
        "with_columns": with_cols,
        "star_only": star_only,
        "no_columns": none,
        "opaque_ratio": opaque / len(ops) if ops else 0.0,
    }
