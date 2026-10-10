"""Shared helpers for normalizing dataset names across languages.

Cross-language stitching depends on every parser agreeing on a dataset `id`.
We key on the *bare object name* (last path/schema component, no extension),
lowercased. This is deliberately loose so that a SAS `work.stg_customers`, a
Python `staging/stg_customers.parquet`, and a SQL `staging.stg_customers` all
collapse to the same node `stg_customers`. It is a prototype simplification and
is surfaced to the user as such.
"""
from __future__ import annotations

import os
import re

from ..models import Dataset

_QUOTES = "\"'`[]"
_FILE_EXTS = {
    ".csv", ".parquet", ".json", ".txt", ".dat", ".xlsx", ".xls",
    ".orc", ".avro", ".feather", ".tsv", ".sas7bdat",
}


def _strip(raw: str) -> str:
    raw = raw.strip().strip(";").strip()
    for ch in _QUOTES:
        raw = raw.replace(ch, "")
    return raw.strip()


def split_name(raw: str) -> tuple[str, str, str]:
    """Return (id, display_name, dataset_type) for a raw dataset reference."""
    cleaned = _strip(raw)
    display = cleaned
    dtype = "table"

    has_path = "/" in cleaned or "\\" in cleaned
    base = os.path.basename(cleaned.replace("\\", "/")) if has_path else cleaned

    root, ext = os.path.splitext(base)
    if ext.lower() in _FILE_EXTS:
        dtype = "file"
        bare = root
    elif "." in base:                      # schema.table or libref.table
        dtype = "table"
        bare = base.split(".")[-1]
    else:
        bare = base

    bare = re.sub(r"\s+", "_", bare.strip()).lower()
    return bare, display, dtype


def make_dataset(raw: str, source_file: str, dtype_hint: str | None = None) -> Dataset:
    ds_id, display, dtype = split_name(raw)
    if dtype_hint:
        dtype = dtype_hint
    return Dataset(id=ds_id, name=display, type=dtype, source_file=source_file)
