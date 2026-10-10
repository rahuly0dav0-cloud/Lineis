"""Python lineage extraction using the `ast` module.

We track the physical provenance of each DataFrame variable. Reads establish a
source dataset; transforms (merge/join/concat/filter/assignment) propagate the
set of upstream sources; writes emit an operation from those upstream sources to
the written target. Intermediate DataFrame variables are resolved away so the
graph shows physical-to-physical lineage (file/table -> file/table).
"""
from __future__ import annotations

import ast

from ..models import Dataset, Operation, ParseResult
from .naming import make_dataset

_READ_PREFIX = "read_"
_READ_METHODS = {"csv", "parquet", "json", "orc", "load", "table"}
_WRITE_METHODS = {
    "to_csv", "to_parquet", "to_json", "to_excel", "to_feather", "to_orc",
    "to_sql", "to_table", "saveastable", "save", "csv", "parquet", "insertinto",
}
_COMBINE_FUNCS = {"merge", "join", "concat", "append", "union", "unionall"}
_NAME_METHODS = {"to_sql", "to_table", "saveastable", "insertinto"}  # arg = table name
_PATH_KWARGS = {"path", "filepath_or_buffer", "name", "fname", "path_or_buf"}


def _root_name(node: ast.AST) -> str | None:
    """Leftmost Name in an attribute/subscript/call chain (the base variable)."""
    while True:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            node = node.value
        elif isinstance(node, ast.Call):
            node = node.func
        elif isinstance(node, ast.Subscript):
            node = node.value
        else:
            return None


def _chain_has_read(node: ast.AST) -> bool:
    for sub in ast.walk(node):
        if isinstance(sub, ast.Attribute) and (
            sub.attr.startswith(_READ_PREFIX) or sub.attr == "read"
        ):
            return True
    return False


class _Analyzer(ast.NodeVisitor):
    def __init__(self, filename: str):
        self.filename = filename
        self.var_sources: dict[str, set[str]] = {}
        self.datasets: dict[str, Dataset] = {}
        self.operations: list[Operation] = []
        self.str_consts: dict[str, str] = {}

    def _resolve_str(self, node: ast.AST) -> str | None:
        """Best-effort reconstruction of a string literal, f-string or name.

        Unknown interpolations resolve to ""; since dataset naming keeps only
        the final path component, a partially-resolved path is still useful.
        """
        if isinstance(node, ast.Constant):
            return node.value if isinstance(node.value, str) else None
        if isinstance(node, ast.Name):
            return self.str_consts.get(node.id)
        if isinstance(node, ast.JoinedStr):
            parts: list[str] = []
            has_literal = False
            for value in node.values:
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    parts.append(value.value)
                    has_literal = True
                elif isinstance(value, ast.FormattedValue):
                    parts.append(self._resolve_str(value.value) or "")
            return "".join(parts) if has_literal else None
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left = self._resolve_str(node.left)
            right = self._resolve_str(node.right)
            if left is not None and right is not None:
                return left + right
        return None

    def _str_arg(self, call: ast.Call) -> str | None:
        for arg in call.args:
            resolved = self._resolve_str(arg)
            if resolved:
                return resolved
        for kw in call.keywords:
            if kw.arg in _PATH_KWARGS:
                resolved = self._resolve_str(kw.value)
                if resolved:
                    return resolved
        return None

    def _register(self, raw: str, dtype_hint: str | None = None) -> str:
        ds = make_dataset(raw, self.filename, dtype_hint=dtype_hint)
        self.datasets.setdefault(ds.id, ds)
        return ds.id

    def _sources_of(self, node: ast.AST) -> set[str]:
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute):
                attr = func.attr.lower()
                if attr.startswith(_READ_PREFIX) or (
                    attr in _READ_METHODS and _chain_has_read(func)
                ):
                    path = self._str_arg(node)
                    if path:
                        return {self._register(path)}
                if attr in _COMBINE_FUNCS:
                    acc: set[str] = set()
                    acc |= self._sources_of(func.value)
                    for a in node.args:
                        acc |= self._sources_of(a)
                    return acc
                # generic df method: inherit from base + df args
                acc = self._sources_of(func.value)
                for a in node.args:
                    acc |= self._sources_of(a)
                return acc
            # module-level call like pd.concat([...]) / pd.merge(a, b)
            acc = set()
            for a in node.args:
                acc |= self._sources_of(a)
            return acc
        if isinstance(node, ast.Name):
            return set(self.var_sources.get(node.id, set()))
        if isinstance(node, (ast.Subscript, ast.Attribute)):
            return self._sources_of(node.value)
        if isinstance(node, (ast.List, ast.Tuple)):
            acc = set()
            for e in node.elts:
                acc |= self._sources_of(e)
            return acc
        if isinstance(node, (ast.BinOp,)):
            return self._sources_of(node.left) | self._sources_of(node.right)
        return set()

    def _maybe_write(self, call: ast.Call) -> None:
        func = call.func
        if not isinstance(func, ast.Attribute):
            return
        attr = func.attr.lower()
        if attr not in _WRITE_METHODS:
            return
        # csv/parquet/save are ambiguous; a read chain (spark.read.parquet) is
        # not a write.
        if _chain_has_read(func):
            return
        base = _root_name(func.value)
        if base is None:
            return
        sources = set(self.var_sources.get(base, set()))
        target_raw = self._str_arg(call)
        if target_raw is None:
            return
        dtype_hint = "table" if attr in _NAME_METHODS else None
        target_id = self._register(target_raw, dtype_hint=dtype_hint)
        self.operations.append(Operation(
            id=f"{self.filename}:py:{call.lineno}",
            kind="write",
            target=target_id,
            inputs=[s for s in sources if s != target_id],
            file=self.filename,
            language="python",
            line_start=call.lineno,
            snippet=ast.get_source_segment(self._source, call) or "",
            confidence="medium",
        ))

    # --- visitors -------------------------------------------------------
    def visit_Assign(self, node: ast.Assign) -> None:
        # Record module/function-level string constants for f-string resolution.
        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name):
                    self.str_consts[tgt.id] = node.value.value
        sources = self._sources_of(node.value)
        if sources:
            for tgt in node.targets:
                if isinstance(tgt, ast.Name):
                    self.var_sources[tgt.id] = sources
        # a write can also appear on the RHS of an assignment
        if isinstance(node.value, ast.Call):
            self._maybe_write(node.value)
        self.generic_visit(node)

    def visit_Expr(self, node: ast.Expr) -> None:
        if isinstance(node.value, ast.Call):
            self._maybe_write(node.value)
        self.generic_visit(node)


def parse(code: str, filename: str = "<python>") -> ParseResult:
    result = ParseResult()
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        result.warnings.append(f"{filename}: python syntax error ({exc})")
        return result

    analyzer = _Analyzer(filename)
    analyzer._source = code
    analyzer.visit(tree)

    result.datasets = analyzer.datasets
    result.operations = analyzer.operations
    return result
