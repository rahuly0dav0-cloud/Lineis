"""Lineage QC harness: measure how closely parser output matches hand-labeled
ground truth, plus coverage, column and cross-parser checks.

This package is intentionally independent of the web app so it can run in CI or
from the command line:  python -m qc.run  (from the backend/ directory).
"""
