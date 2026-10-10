"""SAS lineage extraction (regex / block based).

SAS has no good off-the-shelf lineage parser, so we scan for the constructs
that actually move data:

  * DATA step:        data OUT1 OUT2; set IN; merge A B; ... run;
  * PROC SQL:         create table T as select ... from A join B;
                      select ... into :macro from X   (macro read -> dynamic)
  * PROC EXPORT:      proc export data=X outfile="...xlsx";   (dataset -> file)
  * Generic PROC:     proc sort/means/univariate data=IN ... out=OUT;

It also flags dynamic constructs that cannot be resolved statically:
  * inline macro-variable execution  (&code.;)  -- code injected at runtime
  * select ... into :macro                       -- logic driven by table data

Line numbers are preserved by blanking comment / PROC SQL regions with spaces
(keeping newlines) before scanning.
"""
from __future__ import annotations

import re

from ..models import Dataset, Operation, ParseResult
from .naming import make_dataset

# --- dataset names we must never treat as real tables -----------------------
_SKIP = {
    "_null_", "_data_", "_last_",
    # statement keywords that can slip into SET/MERGE/data= clauses
    "nobs", "where", "keep", "drop", "rename", "in", "end", "by", "obs",
    "firstobs", "point", "nway",
}

_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
# SAS statement comment: "* ... ;" or "%* ... ;" where * begins a statement.
_STAR_COMMENT = re.compile(r"(?:(?<=;)|(?<=\n)|\A)[ \t\r\n]*%?\*[^;]*;")

_PROC_SQL = re.compile(r"\bproc\s+sql\b.*?\bquit\s*;", re.DOTALL | re.IGNORECASE)
_DATA_STEP = re.compile(
    r"\bdata\s+(?P<targets>[^;]+);(?P<body>.*?)\brun\s*;",
    re.DOTALL | re.IGNORECASE,
)
_INPUT_STMT = re.compile(
    r"\b(?P<kw>set|merge|update|modify)\b\s+(?P<ds>[^;]+);", re.IGNORECASE
)
_PROC_STEP = re.compile(
    r"\bproc\s+(?P<name>\w+)\b(?P<body>.*?)\b(?:run|quit)\s*;",
    re.DOTALL | re.IGNORECASE,
)
_DATA_OPT = re.compile(r"\bdata\s*=\s*(?P<ds>[^\s;()]+)", re.IGNORECASE)
_OUT_OPT = re.compile(r"\bout\s*=\s*(?P<ds>[^\s;()]+)", re.IGNORECASE)
_OUTFILE = re.compile(r'\boutfile\s*=\s*["\']?(?P<path>[^"\';\s]+)', re.IGNORECASE)

_CREATE_TABLE = re.compile(r"\bcreate\s+table\s+(?P<t>[\w.]+)\s+as\b", re.IGNORECASE)
_FROM_JOIN = re.compile(r"\b(?:from|join)\s+(?P<t>[\w.]+)", re.IGNORECASE)
_SELECT_INTO = re.compile(r"\binto\s*:", re.IGNORECASE)
# inline macro execution as its own statement: &name.  ;
_MACRO_EXEC = re.compile(r"(?:(?<=;)|(?<=\n)|\A)\s*&(?P<name>\w+)\s*\.?\s*;")


# --- helpers ----------------------------------------------------------------
def _lineno(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _blank_region(text: str, start: int, end: int) -> str:
    region = text[start:end]
    blanked = "".join("\n" if c == "\n" else " " for c in region)
    return text[:start] + blanked + text[end:]


def _blank_all(pattern: re.Pattern, text: str) -> str:
    for m in list(pattern.finditer(text)):
        text = _blank_region(text, m.start(), m.end())
    return text


def _strip_balanced_parens(s: str) -> str:
    """Remove everything inside (possibly nested) parentheses."""
    out, depth = [], 0
    for c in s:
        if c == "(":
            depth += 1
        elif c == ")":
            depth = max(0, depth - 1)
        elif depth == 0:
            out.append(c)
    return "".join(out)


def _dataset_tokens(raw: str) -> list[str]:
    """Split a SET / MERGE / data= clause into individual dataset references."""
    raw = _strip_balanced_parens(raw)
    tokens = []
    for tok in re.split(r"[\s,]+", raw.strip()):
        tok = tok.strip()
        if not tok or "=" in tok or tok.startswith("&"):
            continue
        if tok.lower() in _SKIP:
            continue
        tokens.append(tok)
    return tokens


def _register(datasets: dict[str, Dataset], raw: str, filename: str,
              dtype_hint: str | None = None) -> str:
    ds = make_dataset(raw, filename, dtype_hint)
    datasets.setdefault(ds.id, ds)
    return ds.id


def _register_file(datasets: dict[str, Dataset], path: str, filename: str) -> str:
    """File outputs get their own namespace so they never collide with a
    same-named work dataset (e.g. bcm.sales vs sales.xlsx)."""
    fname = re.split(r"[\\/]", path)[-1] or path
    fid = "file::" + fname.lower()
    datasets.setdefault(fid, Dataset(id=fid, name=fname, type="file",
                                     source_file=filename))
    return fid


# --- PROC SQL (SAS flavour) -------------------------------------------------
def _parse_proc_sql(block: str, base_line: int, filename: str,
                    result: ParseResult, idx: int) -> None:
    for stmt in block.split(";"):
        s = stmt.strip()
        if not s:
            continue
        ct = _CREATE_TABLE.search(s)
        tables = [m.group("t") for m in _FROM_JOIN.finditer(s)]
        if ct:
            target = ct.group("t")
            tid = _register(result.datasets, target, filename)
            input_ids = []
            for t in tables:
                did = _register(result.datasets, t, filename)
                if did != tid and did not in input_ids:
                    input_ids.append(did)
            result.operations.append(Operation(
                id=f"{filename}:sas:sql:{idx}:{tid}",
                kind="ctas",
                target=tid,
                inputs=input_ids,
                file=filename,
                language="sas",
                line_start=base_line,
                snippet=("create table " + s)[:400].strip(),
                confidence="high",
                notes="PROC SQL create table",
            ))
        elif _SELECT_INTO.search(s) and tables:
            for t in tables:
                _register(result.datasets, t, filename)
            result.warnings.append(
                f"{filename}: PROC SQL reads {', '.join(tables)} into a macro "
                f"variable (SELECT INTO :). Downstream logic is injected at "
                f"runtime and cannot be traced statically — candidate for AI review."
            )


# --- main -------------------------------------------------------------------
def parse(code: str, filename: str = "<sas>") -> ParseResult:
    result = ParseResult()

    # 1) Strip comments (block, then SAS star/macro comments), preserving lines.
    text = _blank_all(_BLOCK_COMMENT, code)
    text = _blank_all(_STAR_COMMENT, text)

    # 2) Flag dynamic inline macro execution (&code.;) before anything else.
    seen_macros: set[str] = set()
    for m in _MACRO_EXEC.finditer(text):
        name = m.group("name").lower()
        if name in seen_macros:
            continue
        seen_macros.add(name)
        result.warnings.append(
            f"{filename}: dynamic SAS macro '&{m.group('name')}' is executed "
            f"inline (line {_lineno(text, m.start())}). The datasets/columns it "
            f"creates are resolved at runtime — lineage here may be incomplete "
            f"(candidate for AI review)."
        )

    # 3) PROC SQL blocks, then blank them out so later scans skip them.
    for i, m in enumerate(list(_PROC_SQL.finditer(text))):
        inner = re.sub(r"(?is)^\s*proc\s+sql\b[^;]*;", "", m.group(0))
        inner = inner.rsplit("quit", 1)[0]
        _parse_proc_sql(inner, _lineno(text, m.start()), filename, result, i)
        text = _blank_region(text, m.start(), m.end())

    # 4) DATA steps.
    for i, m in enumerate(_DATA_STEP.finditer(text)):
        targets = [t for t in _dataset_tokens(m.group("targets"))
                   if t.lower() not in _SKIP]
        body = m.group("body")
        inputs: list[str] = []
        kind = "datastep"
        for im in _INPUT_STMT.finditer(body):
            if im.group("kw").lower() == "merge":
                kind = "merge"
            inputs.extend(_dataset_tokens(im.group("ds")))
        if not targets:
            continue
        dynamic = "&" in body
        input_ids = [_register(result.datasets, s, filename) for s in inputs]
        line = _lineno(text, m.start())
        for t in targets:
            tid = _register(result.datasets, t, filename)
            ins = [s for s in input_ids if s != tid]
            if not ins and not dynamic:
                conf, note = "low", "generated from constants/arrays"
                op_kind = "generate"
            elif dynamic:
                conf = "low"
                note = "contains macro-injected code (&macro) — logic resolved at runtime"
                op_kind = kind
            else:
                conf, note, op_kind = "medium", None, kind
            result.operations.append(Operation(
                id=f"{filename}:sas:data:{i}:{tid}",
                kind=op_kind,
                target=tid,
                inputs=ins,
                file=filename,
                language="sas",
                line_start=line,
                snippet=m.group(0)[:400].strip(),
                confidence=conf,
                notes=note,
            ))

    # 5) Generic PROC steps (export -> file, sort/means/univariate out=, ...).
    for i, m in enumerate(_PROC_STEP.finditer(text)):
        name = m.group("name").lower()
        if name == "sql":
            continue
        body = m.group("body")
        din = _DATA_OPT.search(body)
        if not din:
            continue
        in_id = _register(result.datasets, din.group("ds"), filename)

        if name == "export":
            fm = _OUTFILE.search(body)
            if not fm:
                continue
            out_id = _register_file(result.datasets, fm.group("path"), filename)
            result.operations.append(Operation(
                id=f"{filename}:sas:export:{i}",
                kind="export", target=out_id, inputs=[in_id],
                file=filename, language="sas",
                line_start=_lineno(text, m.start()),
                snippet=m.group(0)[:300].strip(),
                confidence="high", notes="proc export",
            ))
            continue

        dout = _OUT_OPT.search(body)
        if not dout:
            continue  # in-place proc (sort/print/contents) — no lineage change
        out_id = _register(result.datasets, dout.group("ds"), filename)
        if in_id == out_id:
            continue
        result.operations.append(Operation(
            id=f"{filename}:sas:proc:{i}",
            kind="proc", target=out_id, inputs=[in_id],
            file=filename, language="sas",
            line_start=_lineno(text, m.start()),
            snippet=m.group(0)[:300].strip(),
            confidence="medium", notes=f"proc {name}",
        ))

    return result
