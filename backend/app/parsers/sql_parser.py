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


def _cte_names(select_scope: exp.Expression | None) -> set[str]:
    """Names of CTEs defined in this statement — they are query-local aliases,
    not physical source tables, so references to them must not become edges."""
    if select_scope is None:
        return set()
    return {cte.alias_or_name.lower()
            for cte in select_scope.find_all(exp.CTE) if cte.alias_or_name}


def _source_tables(select_scope: exp.Expression | None) -> list[str]:
    if select_scope is None:
        return []
    cte_names = _cte_names(select_scope)
    seen: dict[str, None] = {}
    for tbl in select_scope.find_all(exp.Table):
        ref = _table_ref(tbl)
        if not ref:
            continue
        # A bare (unqualified) reference whose name matches a CTE in this
        # statement is an internal alias, not a real table — skip it.
        if not tbl.catalog and not tbl.db and tbl.name.lower() in cte_names:
            continue
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


# Dialects to retry a statement with when the default parse fails. The corpus
# (and real-world SQL) mixes vendor syntax — IS DISTINCT FROM, ::casts, LATERAL,
# current_setting(x, true) — that the permissive default rejects.
_FALLBACK_DIALECTS = ("postgres",)


def _split_statements(sql: str) -> list[str]:
    """Split SQL into top-level statements on `;`, ignoring semicolons inside
    string literals and comments. Used only for resilient recovery."""
    out: list[str] = []
    buf: list[str] = []
    i, n = 0, len(sql)
    quote: str | None = None
    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if quote:
            buf.append(c)
            if c == quote:
                if nxt == quote:        # doubled-quote escape ('' or "")
                    buf.append(nxt)
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if c == "-" and nxt == "-":      # line comment
            while i < n and sql[i] != "\n":
                buf.append(sql[i])
                i += 1
            continue
        if c == "/" and nxt == "*":      # block comment
            buf.append(c)
            buf.append(nxt)
            i += 2
            while i < n and not (sql[i] == "*" and i + 1 < n and sql[i + 1] == "/"):
                buf.append(sql[i])
                i += 1
            if i < n:
                buf.append("*")
                buf.append("/")
                i += 2
            continue
        if c in ("'", '"', "`"):
            quote = c
            buf.append(c)
            i += 1
            continue
        if c == ";":
            out.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(c)
        i += 1
    tail = "".join(buf)
    if tail.strip():
        out.append(tail)
    return [s for s in out if s.strip()]


def _parse_statements(code: str, filename: str, read: str | None,
                      result: ParseResult) -> list[exp.Expression]:
    """Whole-file fast path; on failure, recover statement-by-statement so one
    unparseable statement doesn't discard the entire file's lineage."""
    try:
        return [s for s in sqlglot.parse(code, read=read) if s is not None]
    except Exception:
        pass
    statements: list[exp.Expression] = []
    skipped = 0
    for raw in _split_statements(code):
        parsed = None
        for dial in (read, *_FALLBACK_DIALECTS):
            try:
                parsed = sqlglot.parse_one(raw, read=dial or None)
                break
            except Exception:
                continue
        if parsed is None:
            skipped += 1
        else:
            statements.append(parsed)
    if skipped:
        result.warnings.append(
            f"{filename}: {skipped} statement(s) could not be parsed and were "
            f"skipped; lineage recovered from the remaining {len(statements)}.")
    return statements


def parse(code: str, filename: str = "<sql>", dialect: str = "") -> ParseResult:
    result = ParseResult()
    read = dialect or None
    statements = _parse_statements(code, filename, read, result)

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
