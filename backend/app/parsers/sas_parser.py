"""SAS lineage extraction (regex / block based).

SAS has no good off-the-shelf lineage parser, so we scan for the constructs
that move data:
  * DATA step:   data OUT1 OUT2; set IN; merge A B; ... run;
  * PROC SQL:    reuse the SQL parser on the inner body
  * Generic PROC: proc sort data=IN out=OUT; (data= -> out=)

Line numbers are preserved by blanking PROC SQL regions with spaces (keeping
newlines) before scanning for DATA/PROC steps.
"""
from __future__ import annotations

import re

from ..models import Dataset, Operation, ParseResult
from . import sql_parser
from .naming import make_dataset, split_name

_COMMENT_BLOCK = re.compile(r"/\*.*?\*/", re.DOTALL)
_PROC_SQL = re.compile(r"\bproc\s+sql\b.*?\bquit\s*;", re.DOTALL | re.IGNORECASE)
_DATA_STEP = re.compile(
    r"\bdata\s+(?P<targets>[^;]+);(?P<body>.*?)\brun\s*;",
    re.DOTALL | re.IGNORECASE,
)
_INPUT_STMT = re.compile(
    r"\b(?:set|merge|update|modify)\b\s+(?P<ds>[^;]+);", re.IGNORECASE
)
_PROC_STEP = re.compile(
    r"\bproc\s+(?P<name>\w+)\b(?P<body>.*?)\b(?:run|quit)\s*;",
    re.DOTALL | re.IGNORECASE,
)
_DATA_OPT = re.compile(r"\bdata\s*=\s*(?P<ds>[^\s;()]+)", re.IGNORECASE)
_OUT_OPT = re.compile(r"\bout\s*=\s*(?P<ds>[^\s;()]+)", re.IGNORECASE)

_KEYWORDS = {"nobs", "where", "keep", "drop", "rename", "in", "end", "by", "obs"}


def _sanitize_sas_sql(sql: str) -> str:
    """Make PROC SQL bodies palatable to a standard SQL parser.

    SAS uses `.` as the missing/NULL literal and the `calculated` keyword to
    reference a derived column; neither is valid ANSI SQL.
    """
    sql = re.sub(r"(?i)\bcalculated\s+", "", sql)
    sql = re.sub(r"(?i)(\bthen|\belse|=)\s+\.(?=[\s,)])", r"\1 NULL", sql)
    ops = {"ne": "<>", "eq": "=", "gt": ">", "lt": "<", "ge": ">=", "le": "<="}
    sql = re.sub(r"(?i)\s(ne|eq|gt|lt|ge|le)\s",
                 lambda m: f" {ops[m.group(1).lower()]} ", sql)
    return sql


def _lineno(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _blank_region(text: str, start: int, end: int) -> str:
    region = text[start:end]
    blanked = "".join("\n" if c == "\n" else " " for c in region)
    return text[:start] + blanked + text[end:]


def _dataset_tokens(raw: str) -> list[str]:
    """Split a SET/MERGE/data= clause into individual dataset references."""
    raw = re.sub(r"\([^)]*\)", " ", raw)            # strip (where=...) options
    tokens = []
    for tok in re.split(r"[\s,]+", raw.strip()):
        tok = tok.strip()
        if not tok or "=" in tok:
            continue
        if tok.lower() in _KEYWORDS:
            continue
        tokens.append(tok)
    return tokens


def _register(datasets: dict[str, Dataset], raw: str, filename: str) -> str:
    ds = make_dataset(raw, filename)
    datasets.setdefault(ds.id, ds)
    return ds.id


def parse(code: str, filename: str = "<sas>") -> ParseResult:
    result = ParseResult()
    text = _COMMENT_BLOCK.sub(lambda m: _blank_region(m.group(0), 0, len(m.group(0))),
                              code)

    # 1) PROC SQL blocks -> reuse the SQL engine, then blank them out.
    for i, m in enumerate(list(_PROC_SQL.finditer(text))):
        inner = re.sub(r"^\s*proc\s+sql\s*;", "", m.group(0),
                       flags=re.IGNORECASE).rsplit("quit", 1)[0]
        sub = sql_parser.parse(_sanitize_sas_sql(inner), filename=filename, dialect="")
        base_line = _lineno(text, m.start()) - 1
        for op in sub.operations:
            op.language = "sas"
            op.line_start = base_line + op.line_start
            op.notes = "extracted from PROC SQL"
        result.merge(sub)
        text = _blank_region(text, m.start(), m.end())

    # 2) DATA steps.
    for i, m in enumerate(_DATA_STEP.finditer(text)):
        targets = _dataset_tokens(m.group("targets"))
        body = m.group("body")
        inputs: list[str] = []
        kind = "datastep"
        for im in _INPUT_STMT.finditer(body):
            if im.group(0).lower().lstrip().startswith("merge"):
                kind = "merge"
            inputs.extend(_dataset_tokens(im.group("ds")))
        if not targets or not inputs:
            continue
        input_ids = [_register(result.datasets, s, filename) for s in inputs]
        line = _lineno(text, m.start())
        for t in targets:
            tid = _register(result.datasets, t, filename)
            result.operations.append(Operation(
                id=f"{filename}:sas:data:{i}:{tid}",
                kind=kind,
                target=tid,
                inputs=[s for s in input_ids if s != tid],
                file=filename,
                language="sas",
                line_start=line,
                snippet=m.group(0)[:400].strip(),
                confidence="medium",
            ))

    # 3) Generic PROC steps with data= / out=.
    for i, m in enumerate(_PROC_STEP.finditer(text)):
        name = m.group("name").lower()
        if name == "sql":
            continue
        body = m.group("body")
        din = _DATA_OPT.search(body)
        dout = _OUT_OPT.search(body)
        if not din or not dout:
            continue
        in_id = _register(result.datasets, din.group("ds"), filename)
        out_id = _register(result.datasets, dout.group("ds"), filename)
        if in_id == out_id:
            continue
        result.operations.append(Operation(
            id=f"{filename}:sas:proc:{i}",
            kind="proc",
            target=out_id,
            inputs=[in_id],
            file=filename,
            language="sas",
            line_start=_lineno(text, m.start()),
            snippet=m.group(0)[:300].strip(),
            confidence="medium",
            notes=f"proc {name}",
        ))

    return result
