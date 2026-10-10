"""Build a lineage graph from the parsed IR and serialize it for the UI.

Produces:
  * Cytoscape.js elements (nodes + edges) for visualization
  * foundation datasets (graph roots) and final outputs (graph sinks)
  * an OpenLineage-style event list (the L1 -> L2 / DataHub handshake)
"""
from __future__ import annotations

from typing import Any

import networkx as nx

from .models import ParseResult


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
    g = build_graph(result)

    roots = sorted(n for n in g.nodes if g.in_degree(n) == 0 and g.out_degree(n) > 0)
    sinks = sorted(n for n in g.nodes if g.out_degree(n) == 0 and g.in_degree(n) > 0)
    intermediate = sorted(n for n in g.nodes
                          if g.in_degree(n) > 0 and g.out_degree(n) > 0)
    isolated = sorted(n for n in g.nodes
                      if g.in_degree(n) == 0 and g.out_degree(n) == 0)

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

    elements = _to_cytoscape(g, set(roots), set(sinks))
    return {
        "elements": elements,
        "roots": roots,
        "sinks": sinks,
        "intermediate": intermediate,
        "isolated": isolated,
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


def _to_cytoscape(g: nx.DiGraph, roots: set[str], sinks: set[str]) -> list[dict]:
    elements: list[dict] = []
    for node_id, data in g.nodes(data=True):
        role = "root" if node_id in roots else "sink" if node_id in sinks else "mid"
        elements.append({"data": {
            "id": node_id,
            "label": data.get("name", node_id),
            "type": data.get("type", "unknown"),
            "role": role,
            "source_file": data.get("source_file") or "",
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
