"""Build a lineage graph from the parsed IR and serialize it for the UI.

Produces:
  * Cytoscape.js elements (nodes + edges) for visualization
  * foundation datasets (graph roots) and final outputs (graph sinks)
  * an OpenLineage-style event list (the L1 -> L2 / DataHub handshake)
"""
from __future__ import annotations

from typing import Any

import networkx as nx

from .models import Column, ParseResult


def _attach_columns(result: ParseResult) -> None:
    """Enrich each dataset with the columns the code reveals.

    Declared DDL columns (with types) are already set by the parsers. Here we
    add columns *derived* from each operation's output projection (SELECT list,
    CTAS/view/insert targets) to the dataset they produce — so a table's schema
    reflects whatever the transformations actually populate."""
    for op in result.operations:
        ds = result.datasets.get(op.target)
        if ds is None:
            continue
        have = {c.name.lower() for c in ds.columns}
        for name in op.columns:
            if not name or name == "*":
                continue
            key = name.lower()
            if key in have:
                continue
            ds.columns.append(Column(name=name, source="derived"))
            have.add(key)


def build_graph(result: ParseResult) -> nx.DiGraph:
    g = nx.DiGraph()
    for ds_id, ds in result.datasets.items():
        g.add_node(ds_id, **ds.model_dump())
    for op in result.operations:
        # ensure endpoints exist even if a parser forgot to register them
        for node_id in [op.target, *op.inputs]:
            if node_id not in g:
                g.add_node(node_id, id=node_id, name=node_id, type="unknown",
                           namespace="default", source_file=op.file)
        for src in op.inputs:
            g.add_edge(src, op.target, **op.model_dump())
    return g


def analyze(result: ParseResult) -> dict[str, Any]:
    _attach_columns(result)
    g = build_graph(result)

    roots = sorted(n for n in g.nodes if g.in_degree(n) == 0 and g.out_degree(n) > 0)
    # the runtime node is a dynamic boundary, not a business output — keep it out of sinks
    sinks = sorted(n for n in g.nodes
                   if g.out_degree(n) == 0 and g.in_degree(n) > 0
                   and g.nodes[n].get("type") != "process")
    intermediate = sorted(n for n in g.nodes
                          if g.in_degree(n) > 0 and g.out_degree(n) > 0)
    isolated = sorted(n for n in g.nodes
                      if g.in_degree(n) == 0 and g.out_degree(n) == 0)
    runtime = sorted(n for n in g.nodes if g.nodes[n].get("type") == "process")

    try:
        cycles = list(nx.simple_cycles(g))
    except Exception:
        cycles = []

    warnings = list(result.warnings)
    if cycles:
        warnings.append(f"{len(cycles)} cyclic dependency path(s) detected")
    low_conf = [op.id for op in result.operations if op.confidence == "low"]
    if low_conf:
        warnings.append(f"{len(low_conf)} low-confidence mapping(s) need review")

    by_language: dict[str, int] = {}
    by_file: dict[str, int] = {}
    for op in result.operations:
        by_language[op.language] = by_language.get(op.language, 0) + 1
        by_file[op.file] = by_file.get(op.file, 0) + 1

    integrity = _integrity(g, result, isolated, cycles)

    elements = _to_cytoscape(g, set(roots), set(sinks))
    return {
        "elements": elements,
        "roots": roots,
        "sinks": sinks,
        "intermediate": intermediate,
        "isolated": isolated,
        "runtime": runtime,
        "integrity": integrity,
        "stats": {
            "datasets": g.number_of_nodes(),
            "operations": len(result.operations),
            "edges": g.number_of_edges(),
            "foundation": len(roots),
            "intermediate": len(intermediate),
            "outputs": len(sinks),
            "files": len(by_file),
            "low_confidence": len(low_conf),
            "by_language": by_language,
            "by_file": by_file,
        },
        "operations": [op.model_dump() for op in result.operations],
        "datasets": {k: v.model_dump() for k, v in result.datasets.items()},
        "openlineage": to_openlineage(result),
        "warnings": warnings,
    }


def _integrity(g: nx.DiGraph, result: ParseResult, isolated: list[str],
               cycles: list[list[str]]) -> dict[str, Any]:
    """Deterministic whole-graph integrity audit (no AI).

    The AI validation agent only re-checks the handful of low/medium-confidence
    proposals. This audit instead inspects the *entire* lineage for structural
    soundness, so the graph can be trusted as a whole, not just op-by-op.
    """
    def _name(node_id: str) -> str:
        return g.nodes.get(node_id, {}).get("name", node_id)

    checks: list[dict[str, Any]] = []

    # 1) Cyclic dependencies — usually SAS iterative/in-place rebuilds.
    if cycles:
        checks.append({
            "id": "cycles", "label": "Cyclic dependencies", "severity": "warn",
            "count": len(cycles),
            "detail": "A dataset feeds itself through the chain. In SAS this is "
                      "normally an intentional iterative/in-place rebuild "
                      "(data X; set X; …) rather than an error — shown so the "
                      "loop is explicit. Confirm it is deliberate.",
            "items": [" → ".join(_name(n) for n in cyc) + " → " + _name(cyc[0])
                      for cyc in cycles[:10]],
        })

    # 2) Orphan datasets — parsed but not wired into any flow.
    if isolated:
        checks.append({
            "id": "isolated", "label": "Orphan datasets (no lineage)", "severity": "warn",
            "count": len(isolated),
            "detail": "Referenced in code but not connected to any transformation "
                      "— typically read-only references (proc print/contents/means) "
                      "or a step the parser could not resolve.",
            "items": [_name(n) for n in isolated[:25]],
        })

    # 3) Undefined sources — endpoints auto-created because no step produced them.
    unknown = sorted(n for n, d in g.nodes(data=True) if d.get("type") == "unknown")
    if unknown:
        checks.append({
            "id": "undefined", "label": "Undefined datasets", "severity": "warn",
            "count": len(unknown),
            "detail": "Used as an input/target but never declared in the parsed "
                      "code. Likely an external/library table loaded elsewhere, or "
                      "a name the parser missed.",
            "items": [_name(n) for n in unknown[:25]],
        })

    # 4) Multiple producers — same target written by more than one operation.
    producers: dict[str, int] = {}
    for op in result.operations:
        producers[op.target] = producers.get(op.target, 0) + 1
    multi = sorted(t for t, n in producers.items() if n > 1)
    if multi:
        checks.append({
            "id": "multi_producer", "label": "Datasets built in multiple steps",
            "severity": "info", "count": len(multi),
            "detail": "Written by more than one operation. Common and valid in SAS "
                      "(iterative rebuilds of the same table); listed so overwrites "
                      "are visible and intentional.",
            "items": [_name(t) for t in multi[:25]],
        })

    # 5) Low-confidence edges still awaiting review.
    low = [op for op in result.operations if op.confidence == "low"]
    if low:
        checks.append({
            "id": "low_conf", "label": "Low-confidence mappings", "severity": "info",
            "count": len(low),
            "detail": "Resolved statically but with weak evidence (constants, "
                      "dynamic macros). Candidates for the AI review step.",
            "items": [f"{_name(op.target)} ({op.file})" for op in low[:25]],
        })

    # Weighted score — undefined/orphan structure hurts most; SAS rebuild
    # cycles are usually intentional so they carry a lighter penalty.
    score = 100
    score -= min(20, 6 * len(cycles))
    score -= min(25, 3 * len(isolated))
    score -= min(20, 4 * len(unknown))
    score -= min(10, 2 * len(low))
    score = max(0, score)

    if unknown:
        status = "attention"
    elif score >= 85:
        status = "sound"
    elif score >= 60:
        status = "review"
    else:
        status = "attention"

    return {
        "score": score,
        "status": status,
        "checks": checks,
        "summary": {
            "datasets": g.number_of_nodes(),
            "edges": g.number_of_edges(),
            "cycles": len(cycles),
            "orphans": len(isolated),
            "undefined": len(unknown),
            "multi_producer": len(multi),
            "low_confidence": len(low),
        },
    }


def _to_cytoscape(g: nx.DiGraph, roots: set[str], sinks: set[str]) -> list[dict]:
    elements: list[dict] = []
    for node_id, data in g.nodes(data=True):
        ntype = data.get("type", "unknown")
        if ntype == "process":
            role = "runtime"
        else:
            role = "root" if node_id in roots else "sink" if node_id in sinks else "mid"
        elements.append({"data": {
            "id": node_id,
            "label": data.get("name", node_id),
            "type": ntype,
            "role": role,
            "source_file": data.get("source_file") or "",
            "cols": len(data.get("columns") or []),
        }})
    for src, dst, data in g.edges(data=True):
        elements.append({"data": {
            "id": f"e::{src}::{dst}",
            "source": src,
            "target": dst,
            "kind": data.get("kind", ""),
            "language": data.get("language", ""),
            "confidence": data.get("confidence", "high"),
            "file": data.get("file", ""),
            "line": data.get("line_start", 0),
            "snippet": data.get("snippet", ""),
        }})
    return elements


def to_openlineage(result: ParseResult) -> list[dict]:
    """Minimal OpenLineage run-event list, one per operation (DataHub-ingestable)."""
    events = []
    for op in result.operations:
        def _ds(ds_id: str) -> dict:
            ds = result.datasets.get(ds_id)
            return {
                "namespace": ds.namespace if ds else "default",
                "name": ds.name if ds else ds_id,
                "facets": {"lineageKey": ds_id},
            }
        events.append({
            "eventType": "COMPLETE",
            "job": {"namespace": "lineis-lineage", "name": op.id},
            "inputs": [_ds(i) for i in op.inputs],
            "outputs": [_ds(op.target)],
            "facets": {
                "language": op.language,
                "kind": op.kind,
                "confidence": op.confidence,
                "sourceFile": op.file,
            },
        })
    return events
