"""Stress-test the parser against the external `data_lineage_stress_corpus_v2`.

Each batch ships 3 source files (a cross-language pipeline) plus a
`ground_truth.json` oracle. We stitch the batch with `parse_many` and reconcile
the merged graph against the oracle's canonical edges.

Id normalization: the oracle uses full `schema.table` ids while the parser
collapses to the last dot-component (its stable node id). We normalize BOTH
sides with `split_name` so the comparison is apples-to-apples.

The oracle separates a deterministic "core" chain from adversarial "probe"
edges (scenario families, union probes, audit reads) that are catalogued by
naming convention — those are reported separately, not scored as hard misses.

Usage (from backend/):
    ./.venv/bin/python -m qc.stress
    ./.venv/bin/python -m qc.stress --verbose
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys

_BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)
_ROOT = os.path.dirname(_BACKEND)

from app.parsers import parse_many               # noqa: E402
from app.parsers.naming import split_name        # noqa: E402
from qc import metrics                            # noqa: E402

_CORPUS = os.path.join(_ROOT, "data_lineage_stress_corpus_v2")
_PROBE_HINTS = ("scenario_outputs", "union_probe", "scenario_log")

# The oracle ids are canonical (schema_batch.logical); the code uses adversarial
# variants (schema.logical_batch, plus stageN_base/_dedup/_rules/_metricNNN
# families). The corpus README asks for comparison "after canonical
# normalization", so we reduce both the oracle and the parser nodes to a shared
# logical key before matching.
_BATCH_TOK = re.compile(r"_?b\d{2}_?")
_STAGE_SUFFIX = re.compile(r"_(base|dedup|rules|import|final|out|tmp|applied|latest|raw)$")
_METRIC_FAM = re.compile(r"_metric\d+$")


def _canon(node: str) -> str:
    base = node.split(".")[-1].lower()       # drop schema / db / catalog
    base = _BATCH_TOK.sub("", base)          # strip batch marker (b01 / _b01_)
    base = _METRIC_FAM.sub("_metric", base)  # collapse metricNNN family
    base = _STAGE_SUFFIX.sub("", base)       # collapse stage variant outputs
    base = re.sub(r"_+", "_", base).strip("_")
    return base or node.lower()


def _norm(node: str) -> str:
    return split_name(node)[0]


def _reachable_pairs(edges: set[tuple[str, str]]) -> set[tuple[str, str]]:
    """All (source, descendant) pairs reachable in the graph — i.e. transitive
    closure. The oracle lists source->final edges; our parser emits the direct
    hops, so connectivity must be checked over the closure, not edge-equality."""
    from collections import defaultdict, deque
    adj: dict[str, set[str]] = defaultdict(set)
    nodes: set[str] = set()
    for s, t in edges:
        adj[s].add(t)
        nodes.add(s)
        nodes.add(t)
    reach: set[tuple[str, str]] = set()
    for start in nodes:
        seen: set[str] = set()
        dq = deque(adj[start])
        while dq:
            n = dq.popleft()
            if n in seen:
                continue
            seen.add(n)
            reach.add((start, n))
            dq.extend(adj[n] - seen)
    return reach


def _batch_dirs() -> list[str]:
    return sorted(
        d for d in glob.glob(os.path.join(_CORPUS, "*"))
        if os.path.isdir(d) and os.path.exists(os.path.join(d, "ground_truth.json"))
    )


def _source_files(batch_dir: str) -> list[tuple[str, str]]:
    files = []
    for path in sorted(glob.glob(os.path.join(batch_dir, "*"))):
        if path.endswith((".sql", ".sas", ".py")):
            with open(path, encoding="utf-8", errors="replace") as fh:
                files.append((os.path.basename(path), fh.read()))
    return files


def _fmt(x: float) -> str:
    return f"{100 * x:5.1f}%"


def run(verbose: bool = False) -> int:
    batches = _batch_dirs()
    if not batches:
        print("No corpus found at", _CORPUS)
        return 1

    print("=" * 82)
    print("LINEIS — stress test vs data_lineage_stress_corpus_v2")
    print("=" * 82)
    print(f"{'batch':22} {'langs':8} {'raw R':>7} {'canon R':>8} {'reach R':>8} "
          f"  reach miss")
    print("-" * 82)

    agg = {"raw_tp": 0, "raw_fn": 0, "canon_tp": 0, "canon_fn": 0,
           "reach_tp": 0, "reach_fn": 0, "probe_tp": 0, "probe_fn": 0}

    for bdir in batches:
        name = os.path.basename(bdir)
        oracle = json.load(open(os.path.join(bdir, "ground_truth.json"), encoding="utf-8"))
        langs = "/".join(l[0] for l in oracle.get("language_combination", []))

        files = _source_files(bdir)
        result = parse_many(files)
        actual = metrics.result_edges(result)                       # raw ids
        actual_canon = {(_canon(s), _canon(t)) for s, t in actual   # canonical
                        if _canon(s) != _canon(t)}
        reach = _reachable_pairs(actual_canon)                      # closure

        core_raw, core_canon, probe_canon = set(), set(), set()
        for e in oracle.get("edges", []):
            is_probe = any(h in e["from"] or h in e["to"] for h in _PROBE_HINTS)
            craw = (_norm(e["from"]), _norm(e["to"]))
            ccan = (_canon(e["from"]), _canon(e["to"]))
            if is_probe:
                probe_canon.add(ccan)
            else:
                core_raw.add(craw)
                if ccan[0] != ccan[1]:
                    core_canon.add(ccan)

        raw_tp = core_raw & actual
        canon_tp = core_canon & actual_canon
        reach_tp = sorted(core_canon & reach)
        reach_fn = sorted(core_canon - reach)
        probe_tp = probe_canon & reach

        agg["raw_tp"] += len(raw_tp)
        agg["raw_fn"] += len(core_raw) - len(raw_tp)
        agg["canon_tp"] += len(canon_tp)
        agg["canon_fn"] += len(core_canon) - len(canon_tp)
        agg["reach_tp"] += len(reach_tp)
        agg["reach_fn"] += len(reach_fn)
        agg["probe_tp"] += len(probe_tp)
        agg["probe_fn"] += len(probe_canon) - len(probe_tp)

        raw_r = len(raw_tp) / len(core_raw) if core_raw else 1.0
        canon_r = len(canon_tp) / len(core_canon) if core_canon else 1.0
        reach_r = len(reach_tp) / len(core_canon) if core_canon else 1.0
        print(f"{name:22} {langs:8} {_fmt(raw_r):>7} {_fmt(canon_r):>8} "
              f"{_fmt(reach_r):>8}   {len(reach_fn)} missed")
        if verbose or reach_fn:
            for s, t in reach_fn:
                print(f"    REACH MISS  {s} -> {t}")

    print("-" * 82)
    raw_tot = agg["raw_tp"] + agg["raw_fn"]
    canon_tot = agg["canon_tp"] + agg["canon_fn"]
    reach_tot = agg["reach_tp"] + agg["reach_fn"]
    probe_tot = agg["probe_tp"] + agg["probe_fn"]
    rr = agg["raw_tp"] / raw_tot if raw_tot else 1.0
    cr = agg["canon_tp"] / canon_tot if canon_tot else 1.0
    rer = agg["reach_tp"] / reach_tot if reach_tot else 1.0
    pr = agg["probe_tp"] / probe_tot if probe_tot else 1.0
    print(f"RAW core    (literal direct edges)      : TP={agg['raw_tp']} "
          f"FN={agg['raw_fn']}  recall {_fmt(rr)}")
    print(f"CANON core  (normalized direct edges)   : TP={agg['canon_tp']} "
          f"FN={agg['canon_fn']}  recall {_fmt(cr)}")
    print(f"REACH core  (normalized + transitive)   : TP={agg['reach_tp']} "
          f"FN={agg['reach_fn']}  recall {_fmt(rer)}")
    print(f"PROBE       (adversarial, via reach)    : TP={agg['probe_tp']} "
          f"FN={agg['probe_fn']}  recall {_fmt(pr)}")
    print("=" * 82)
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    raise SystemExit(run(verbose=args.verbose))
