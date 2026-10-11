"""Lineage QC runner.

Usage (from the backend/ directory):
    ./.venv/bin/python -m qc.run            # full report
    ./.venv/bin/python -m qc.run --strict   # exit 1 if any complete fixture misses/invents an edge

Loads every fixture in qc/fixtures/, parses the referenced source file, and
reports precision/recall/F1 against the hand-labeled ground truth, plus
coverage, column capture, and an independent cross-parser agreement check.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys

# Make `app` importable whether run from backend/ or the repo root.
_BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)
_ROOT = os.path.dirname(_BACKEND)

from app.parsers import parse_file                       # noqa: E402
from qc import crosscheck, metrics                       # noqa: E402

_FIXTURE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def _load_fixtures() -> list[dict]:
    fixtures = []
    for path in sorted(glob.glob(os.path.join(_FIXTURE_DIR, "*.json"))):
        with open(path, encoding="utf-8") as fh:
            fx = json.load(fh)
            fx["_fixture"] = os.path.basename(path)
            fixtures.append(fx)
    return fixtures


def _read_source(rel: str) -> str | None:
    full = os.path.join(_ROOT, rel)
    if not os.path.exists(full):
        return None
    with open(full, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def _fmt_pct(x: float) -> str:
    return f"{100 * x:5.1f}%"


def run(strict: bool = False, verbose: bool = False) -> int:
    fixtures = _load_fixtures()
    if not fixtures:
        print("No fixtures found in", _FIXTURE_DIR)
        return 1

    agg = {"tp": 0, "fp": 0, "fn": 0}
    failures: list[str] = []
    missing: list[str] = []

    print("=" * 78)
    print("LINEIS — lineage QC report")
    print("=" * 78)
    print(f"LLM cross-check: {'available' if crosscheck.llm_available() else 'skipped (no API key)'}")
    print()
    header = f"{'file':46} {'mode':10} {'P':>6} {'R':>6} {'F1':>6}  edges"
    print(header)
    print("-" * 78)

    for fx in fixtures:
        rel = fx["file"]
        language = fx.get("language", "")
        mode = fx.get("mode", "complete")
        code = _read_source(rel)
        if code is None:
            missing.append(rel)
            print(f"{rel:46} {'MISSING':>10}")
            continue

        result = parse_file(os.path.basename(rel), code)
        actual = metrics.result_edges(result)
        expected = {metrics.norm_edge(s, t) for s, t in fx.get("edges", [])}
        sc = metrics.score_edges(expected, actual, mode)

        if mode == "complete":
            agg["tp"] += len(sc["tp"])
            agg["fp"] += len(sc["fp"])
            agg["fn"] += len(sc["fn"])

        forbidden_hit = metrics.check_forbidden(fx.get("forbidden", []), actual)
        label = os.path.basename(rel)
        print(f"{label:46} {mode:10} "
              f"{_fmt_pct(sc['precision'])} {_fmt_pct(sc['recall'])} "
              f"{_fmt_pct(sc['f1'])}  {len(expected)}")

        if sc["fn"] or (mode == 'complete' and sc["fp"]) or forbidden_hit:
            failures.append(rel)
        if verbose or sc["fn"] or (mode == "complete" and sc["fp"]) or forbidden_hit:
            for e in sc["fn"]:
                print(f"    MISSED   {e[0]} -> {e[1]}")
            for e in (sc["fp"] if mode == "complete" else []):
                print(f"    EXTRA    {e[0]} -> {e[1]}")
            for e in forbidden_hit:
                print(f"    FORBIDDEN present {e[0]} -> {e[1]}")

        # Coverage + columns + cross-check (informational).
        cov = metrics.coverage(code, result, language)
        col = metrics.column_report(result)
        print(f"    coverage: constructs={cov['constructs']} ops={cov['ops']} "
              f"wired={cov['ops_wired']} "
              f"(construct {_fmt_pct(cov['construct_coverage'])}, "
              f"wired {_fmt_pct(cov['wired_ratio'])}) | "
              f"cols: with={col['with_columns']} star={col['star_only']} "
              f"none={col['no_columns']} (opaque {_fmt_pct(col['opaque_ratio'])})")
        if language in ("sql", "sas"):
            second = crosscheck.regex_edges(code, language)
            ag = crosscheck.agreement(actual, second)
            print(f"    cross-check (regex 2nd opinion): "
                  f"jaccard {_fmt_pct(ag['jaccard'])} "
                  f"| only-parser {len(ag['only_primary'])} "
                  f"| only-regex {len(ag['only_secondary'])}")
            if verbose:
                for e in ag["only_secondary"]:
                    print(f"        regex-only (parser may have missed): {e[0]} -> {e[1]}")

    # Aggregate over complete-mode fixtures only.
    tp, fp, fn = agg["tp"], agg["fp"], agg["fn"]
    prec = tp / (tp + fp) if (tp + fp) else 1.0
    rec = tp / (tp + fn) if (tp + fn) else 1.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    print("-" * 78)
    print(f"AGGREGATE (complete fixtures): TP={tp} FP={fp} FN={fn}")
    print(f"  precision {_fmt_pct(prec)}  recall {_fmt_pct(rec)}  F1 {_fmt_pct(f1)}")
    if missing:
        print(f"  missing source files: {len(missing)} ({', '.join(missing)})")
    print("=" * 78)

    if strict and (failures or missing):
        print(f"STRICT: {len(failures)} fixture(s) with edge errors, "
              f"{len(missing)} missing file(s).")
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Lineis lineage QC harness")
    ap.add_argument("--strict", action="store_true",
                    help="exit 1 if any complete fixture misses/invents an edge")
    ap.add_argument("--verbose", "-v", action="store_true",
                    help="show every discrepancy and cross-check detail")
    args = ap.parse_args()
    return run(strict=args.strict, verbose=args.verbose)


if __name__ == "__main__":
    raise SystemExit(main())
