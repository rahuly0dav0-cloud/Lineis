"""SQL lineage extraction using sqlglot.

Handles the statements that actually move data between tables:
  * CREATE TABLE ... AS SELECT   (CTAS)
  * CREATE VIEW ... AS SELECT
  * INSERT INTO ... SELECT
  * SELECT ... INTO ...

For each, the target table and all source tables are extracted, plus a
best-effort list of output column names.
"""
from __future__ import annotations

import logging

import sqlglot
from sqlglot import exp

from ..models import Dataset, Operation, ParseResult
from .naming import make_dataset, split_name

logging.getLogger("sqlglot").setLevel(logging.ERROR)


def _table_ref(table: exp.Table) -> str:
    parts = [p for p in (table.catalog, table.db, table.name) if p]
    return ".".join(parts)


def _source_tables(select_scope: exp.Expression | None) -> list[str]:
    if select_scope is None:
        return []
    seen: dict[str, None] = {}
    for tbl in select_scope.find_all(exp.Table):
        ref = _table_ref(tbl)
        if ref:
            seen.setdefault(ref, None)
    return list(seen)


def _output_columns(select_scope: exp.Expression | None) -> list[str]:
    if not isinstance(select_scope, exp.Select):
        return []
    cols: list[str] = []
    for proj in select_scope.expressions:
        if isinstance(proj, exp.Star):
            cols.append("*")
        else:
            name = proj.alias_or_name
            if name:
                cols.append(name)
    return cols


def _register(datasets: dict[str, Dataset], raw: str, filename: str,
              dtype_hint: str | None = None) -> str:
    ds = make_dataset(raw, filename, dtype_hint=dtype_hint)
    datasets.setdefault(ds.id, ds)
    return ds.id


def parse(code: str, filename: str = "<sql>", dialect: str = "") -> ParseResult:
    result = ParseResult()
    read = dialect or None
    try:
        statements = sqlglot.parse(code, read=read)
    except Exception as exc:
        result.warnings.append(f"{filename}: sqlglot failed to parse ({exc})")
        return result

    for idx, stmt in enumerate(statements):
        if stmt is None:
            continue

        target_raw: str | None = None
        select_scope: exp.Expression | None = None
        kind = "unknown"
        dtype_hint = "table"

        if isinstance(stmt, exp.Create):
            create_kind = (stmt.args.get("kind") or "TABLE").upper()
            target_node = stmt.this
            target_tbl = (target_node if isinstance(target_node, exp.Table)
                          else target_node.find(exp.Table) if target_node else None)
            if target_tbl is None:
                continue
            target_raw = _table_ref(target_tbl)
            select_scope = stmt.expression
            if create_kind == "VIEW":
                kind, dtype_hint = "view", "view"
            else:
                kind = "ctas"

        elif isinstance(stmt, exp.Insert):
            target_node = stmt.this
            target_tbl = (target_node if isinstance(target_node, exp.Table)
                          else target_node.find(exp.Table) if target_node else None)
            if target_tbl is None:
                continue
            target_raw = _table_ref(target_tbl)
            select_scope = stmt.expression
            kind = "insert"

        elif isinstance(stmt, exp.Select):
            into = stmt.args.get("into")
            if into is None:
                continue  # a bare SELECT produces no persisted dataset
            into_tbl = into.find(exp.Table)
            if into_tbl is None:
                continue
            target_raw = _table_ref(into_tbl)
            select_scope = stmt
            kind = "select"

        else:
            continue

        if not target_raw:
            continue

        target_id = _register(result.datasets, target_raw, filename, dtype_hint)
        source_ids = []
        for src in _source_tables(select_scope):
            sid, _, _ = split_name(src)
            if sid == target_id:
                continue
            source_ids.append(_register(result.datasets, src, filename))

        op = Operation(
            id=f"{filename}:sql:{idx}",
            kind=kind,
            target=target_id,
            inputs=source_ids,
            columns=_output_columns(select_scope),
            file=filename,
            language="sql",
            line_start=stmt.meta.get("line", 0) if stmt.meta else 0,
            snippet=stmt.sql(dialect=read)[:600],
            confidence="high",
        )
        result.operations.append(op)

    return result
