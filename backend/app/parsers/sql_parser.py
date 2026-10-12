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
import re

import sqlglot
from sqlglot import exp
from sqlglot.lineage import lineage as _column_lineage

from ..models import Column, ColumnEdge, Dataset, Operation, ParseResult
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


def _column_map(select_scope: exp.Expression | None, output_cols: list[str],
                source_ids: list[str], read: str | None) -> list[ColumnEdge]:
    """Best-effort column provenance via sqlglot's lineage tracer. Precision
    first: a column edge is emitted only when a leaf resolves to a physical
    source table we already recognised for this operation. Columns that cannot
    be traced (SELECT *, schema-ambiguous references) are silently skipped
    rather than guessed."""
    if not isinstance(select_scope, exp.Expression) or not output_cols:
        return []
    src_set = set(source_ids)
    edges: list[ColumnEdge] = []
    for col in output_cols:
        if not col or col == "*":
            continue
        try:
            root = _column_lineage(col, select_scope.copy(), dialect=read or None)
        except Exception:
            continue
        srcs: set[str] = set()
        for node in root.walk():
            if node is root or node.downstream:
                continue
            table = node.source
            if not isinstance(table, exp.Table):
                continue
            tid, _, _ = split_name(_table_ref(table))
            if tid not in src_set:
                continue
            colname = node.name.rpartition(".")[2] or node.name
            srcs.add(f"{tid}.{colname}")
        if srcs:
            edges.append(ColumnEdge(target_column=col,
                                    source_columns=sorted(srcs)))
    return edges


def _register(datasets: dict[str, Dataset], raw: str, filename: str,
              dtype_hint: str | None = None) -> str:
    ds = make_dataset(raw, filename, dtype_hint=dtype_hint)
    datasets.setdefault(ds.id, ds)
    return ds.id


def _schema_columns(create: exp.Create) -> list[Column]:
    """Declared columns (name + type) from a `CREATE TABLE t (col type, ...)`
    DDL schema. Constraints (PRIMARY KEY, ...) are ignored — only real fields."""
    node = create.this
    if not isinstance(node, exp.Schema):
        return []
    cols: list[Column] = []
    for defn in node.expressions:
        if not isinstance(defn, exp.ColumnDef):
            continue
        dtype = defn.args.get("kind")
        cols.append(Column(
            name=defn.name,
            dtype=dtype.sql().upper() if dtype is not None else None,
            source="declared",
        ))
    return cols


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
        _emit_statement(stmt, f"{filename}:sql:{idx}", read, result, filename)

    # Recover lineage hidden inside dynamic SQL strings (DECLARE/SET + EXEC
    # sp_executesql). The source/target tables are assembled at runtime from
    # string variables; when those variables are literal we can resolve them
    # deterministically rather than losing the dependency entirely.
    _recover_dynamic_sql(code, filename, read, result)

    return result


def _emit_statement(stmt: exp.Expression, op_id: str, read: str | None,
                    result: ParseResult, filename: str, *,
                    confidence: str = "high", note: str | None = None,
                    line: int | None = None) -> None:
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
            return
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
            return
        target_raw = _table_ref(target_tbl)
        select_scope = stmt.expression
        kind = "insert"

    elif isinstance(stmt, exp.Select):
        into = stmt.args.get("into")
        if into is None:
            return  # a bare SELECT produces no persisted dataset
        into_tbl = into.find(exp.Table)
        if into_tbl is None:
            return
        target_raw = _table_ref(into_tbl)
        select_scope = stmt
        kind = "select"

    else:
        return

    if not target_raw:
        return

    target_id = _register(result.datasets, target_raw, filename, dtype_hint)

    # Attach any explicitly declared DDL columns (name + type) to the dataset.
    if isinstance(stmt, exp.Create):
        declared = _schema_columns(stmt)
        if declared:
            tgt = result.datasets.get(target_id)
            if tgt is not None:
                have = {c.name.lower() for c in tgt.columns}
                tgt.columns.extend(c for c in declared if c.name.lower() not in have)

    source_ids = []
    for src in _source_tables(select_scope):
        sid, _, _ = split_name(src)
        if sid == target_id:
            continue
        source_ids.append(_register(result.datasets, src, filename))

    output_cols = _output_columns(select_scope)
    result.operations.append(Operation(
        id=op_id,
        kind=kind,
        target=target_id,
        inputs=source_ids,
        columns=output_cols,
        column_map=_column_map(select_scope, output_cols, source_ids, read),
        file=filename,
        language="sql",
        line_start=(line if line is not None
                    else (stmt.meta.get("line", 0) if stmt.meta else 0)),
        snippet=stmt.sql(dialect=read)[:600],
        confidence=confidence,
        notes=note,
    ))


# --- dynamic SQL recovery (DECLARE / SET string vars + EXEC sp_executesql) ---
_DECLARE_ASSIGN = re.compile(r"(?is)^\s*DECLARE\s+@(\w+)\b[^=;]*?=\s*(.+)$")
_DECLARE_ONLY = re.compile(r"(?is)^\s*DECLARE\s+@(\w+)\b")
_SET_ASSIGN = re.compile(r"(?is)^\s*SET\s+@(\w+)\s*=\s*(.+)$")
_EXEC_VAR = re.compile(
    r"(?is)\bexec(?:ute)?\b\s*\(?\s*(?:sp_executesql\s+)?@(\w+)")


def _strip_sql_comments(s: str) -> str:
    """Remove -- line comments and /* */ block comments, leaving string literals
    untouched (so comment markers inside a quoted dynamic-SQL string survive)."""
    out: list[str] = []
    i, n = 0, len(s)
    quote: str | None = None
    while i < n:
        c = s[i]
        nxt = s[i + 1] if i + 1 < n else ""
        if quote:
            out.append(c)
            if c == quote:
                if nxt == quote:
                    out.append(nxt)
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if c == "-" and nxt == "-":
            while i < n and s[i] != "\n":
                i += 1
            continue
        if c == "/" and nxt == "*":
            i += 2
            while i < n and not (s[i] == "*" and i + 1 < n and s[i + 1] == "/"):
                i += 1
            i += 2
            continue
        if c in ("'", '"'):
            quote = c
            out.append(c)
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _eval_concat(expr: str, variables: dict[str, str | None]) -> str | None:
    """Evaluate a T-SQL string expression that is a concatenation of string
    literals and @variables (``'a' + @v + 'b'``). Returns the resolved string,
    or None if it contains anything we cannot resolve deterministically (an
    unknown variable, a function call, etc.) — we never guess."""
    expr = expr.strip().rstrip(";").strip()
    parts: list[str] = []
    i, n = 0, len(expr)
    while i < n:
        c = expr[i]
        if c == "'":
            j = i + 1
            buf: list[str] = []
            while j < n:
                if expr[j] == "'":
                    if j + 1 < n and expr[j + 1] == "'":   # '' escape
                        buf.append("'")
                        j += 2
                        continue
                    break
                buf.append(expr[j])
                j += 1
            parts.append("".join(buf))
            i = j + 1
            continue
        if c == "@":
            m = re.match(r"@(\w+)", expr[i:])
            if m:
                val = variables.get(m.group(1).lower())
                if val is None:
                    return None
                parts.append(val)
                i += m.end()
                continue
        if c in "+ \t\r\n":
            i += 1
            continue
        return None  # unexpected token — refuse to guess
    return "".join(parts)


def _recover_dynamic_sql(code: str, filename: str, read: str | None,
                         result: ParseResult) -> None:
    variables: dict[str, str | None] = {}
    executed: list[str] = []
    for raw in _split_statements(_strip_sql_comments(code)):
        s = raw.strip()
        m = _DECLARE_ASSIGN.match(s)
        if m:
            variables[m.group(1).lower()] = _eval_concat(m.group(2), variables)
            continue
        m = _DECLARE_ONLY.match(s)
        if m:
            variables.setdefault(m.group(1).lower(), None)
            continue
        m = _SET_ASSIGN.match(s)
        if m:
            val = _eval_concat(m.group(2), variables)
            if val is not None:
                variables[m.group(1).lower()] = val
            continue
        executed.extend(em.group(1).lower() for em in _EXEC_VAR.finditer(s))

    recovered = [variables[v] for v in executed
                 if variables.get(v)
                 and re.search(r"(?is)\b(select|insert|update|merge|create)\b",
                               variables[v] or "")]
    if not recovered:
        return

    result.warnings.append(
        f"{filename}: recovered {len(recovered)} dynamic SQL statement(s) run "
        f"via EXEC/sp_executesql by resolving DECLARE/SET string variables "
        f"deterministically — edges are marked low-confidence; verify the "
        f"assumed variable values.")
    for j, sql in enumerate(recovered):
        parsed = None
        for dial in ("tsql", read, "postgres", None):
            try:
                parsed = sqlglot.parse_one(sql, read=dial or None)
                break
            except Exception:
                continue
        if parsed is None:
            result.warnings.append(
                f"{filename}: a recovered dynamic SQL statement could not be "
                f"parsed and was skipped.")
            continue
        _emit_statement(parsed, f"{filename}:sql:dyn:{j}", read, result, filename,
                        confidence="low",
                        note="recovered from dynamic SQL (EXEC sp_executesql)")

