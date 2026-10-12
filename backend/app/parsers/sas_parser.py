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
# Inline-data blocks: `cards;`/`datalines;` (and the `4` variants) hold literal
# text, not SAS statements. Blank them so words like "Data set" inside the data
# aren't mistaken for a SET statement. cards4/datalines4 end on a `;;;;` line;
# cards/datalines end on a lone `;` line.
_DATALINES = re.compile(
    r"\b(?:datalines4|cards4)\s*;.*?^[ \t]*;;;;[ \t]*$"
    r"|\b(?:datalines|cards)\s*;.*?^[ \t]*;[ \t]*$",
    re.DOTALL | re.IGNORECASE | re.MULTILINE,
)

_PROC_SQL = re.compile(r"\bproc\s+sql\b.*?\bquit\s*;", re.DOTALL | re.IGNORECASE)
_DATA_STEP = re.compile(
    # `(?!\s*=)` so we don't mistake a PROC's `data = X` option for a DATA step.
    r"\bdata\b(?!\s*=)\s+(?P<targets>[^;]+);(?P<body>.*?)\brun\s*;",
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
# `ods output label=dataset ...;` redirects a proc's output objects into datasets.
_ODS_OUTPUT = re.compile(r"\bods\s+output\b(?P<pairs>[^;]*);", re.IGNORECASE)

_CREATE_TABLE = re.compile(r"\bcreate\s+table\s+(?P<t>[\w.&]+)\s+as\b", re.IGNORECASE)
_FROM_JOIN = re.compile(r"\b(?:from|join)\s+(?P<t>[\w.&]+)", re.IGNORECASE)
_SELECT_INTO = re.compile(r"\binto\s*:", re.IGNORECASE)
# inline macro execution as its own statement: &name.  ;
_MACRO_EXEC = re.compile(r"(?:(?<=;)|(?<=\n)|\A)\s*&(?P<name>\w+)\s*\.?\s*;")

# --- deterministic macro-variable resolution --------------------------------
# %let NAME = VALUE;  -> constant we can propagate into dataset names.
_LET = re.compile(r"%let\s+(?P<name>\w+)\s*=\s*(?P<val>[^;]*);", re.IGNORECASE)
# %let VAR = %scan(&LIST., &i.);  -> VAR iterates over the tokens of &LIST.
_SCAN_LET = re.compile(
    r"%let\s+(?P<var>\w+)\s*=\s*%scan\(\s*&(?P<list>\w+)\.?", re.IGNORECASE)
_MACRO_REF = re.compile(r"&(?P<name>\w+)\.?")
# PROC SQL INSERT INTO ... SELECT ... FROM/JOIN ...
_INSERT_INTO = re.compile(r"\binsert\s+into\s+(?P<t>[\w.&]+)", re.IGNORECASE)
# PROC IMPORT / CSVIMPORT source file option.
_DATAFILE = re.compile(
    r'\b(?:datafile|infile)\s*=\s*["\']?(?P<path>[^"\';\s]+)', re.IGNORECASE)

# PROCs that render a terminal artifact (chart / report) rather than a dataset,
# so their input is really a FINAL output of the flow, not a dead end.
_VISUAL_PROCS = {
    "gplot": "chart", "sgplot": "chart", "gchart": "chart", "gmap": "chart",
    "sgpanel": "chart", "sgscatter": "chart", "sgpie": "chart", "boxplot": "chart",
    "gbarline": "chart", "gcontour": "chart", "g3d": "chart", "gradar": "chart",
    "gareabar": "chart", "sgrender": "chart",
    "report": "report", "tabulate": "report",
}


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


def _used_macro_defs(body: str, macro_defs: set[str]) -> list[str]:
    """Which SELECT-INTO macro variables a step references (e.g. &miss_dnd_list.)."""
    if not macro_defs:
        return []
    found = {n.lower() for n in re.findall(r"&(\w+)", body)}
    return sorted(found & macro_defs)


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


def _dataset_tokens(raw: str, scalars: dict[str, str] | None = None) -> list[str]:
    """Split a SET / MERGE / data= clause into individual dataset references.

    A token that *starts* with a macro variable (``&LIB..TABLE``) is otherwise
    silently dropped; if `scalars` resolves it to a concrete name we keep it so
    the lineage is not lost. Tokens that merely *embed* a macro var
    (``plot_&grp``) are left untouched so existing output is unchanged."""
    raw = _strip_balanced_parens(raw)
    tokens = []
    for tok in re.split(r"[\s,]+", raw.strip()):
        tok = tok.strip()
        if not tok or "=" in tok:
            continue
        if tok.startswith("&"):
            resolved = _subst_scalars(tok, scalars) if scalars else tok
            if resolved.startswith("&"):
                continue  # still a runtime-built name — can't resolve
            tok = resolved
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


def _register_runtime(datasets: dict[str, Dataset], filename: str) -> str:
    """Semantic-layer node for code that SAS injects at runtime via macro
    variables (SELECT INTO :macro -> &macro.;). We cannot resolve what it
    produces statically, but we CAN show which tables feed it — so its source
    tables stay connected to the lineage instead of looking like orphans."""
    rid = "runtime::" + filename.lower()
    datasets.setdefault(rid, Dataset(id=rid, name="⟨runtime-injected code⟩",
                                     type="process", source_file=filename))
    return rid


def _register_visual(datasets: dict[str, Dataset], proc: str, input_id: str,
                     artifact: str, filename: str) -> str:
    """Terminal chart/report artifact produced by a visual PROC (gplot, report…).
    Keyed on its input so repeated plots of the same table collapse to one node."""
    label = "Chart" if artifact == "chart" else "Report"
    src = datasets.get(input_id)
    src_name = src.name if src else input_id
    vid = f"{artifact}::{input_id}"
    datasets.setdefault(vid, Dataset(id=vid, name=f"{src_name} · {label}",
                                     type=artifact, source_file=filename))
    return vid


# --- macro-variable resolution ---------------------------------------------
def _collect_macro_vars(text: str) -> tuple[dict[str, str], dict[str, list[str]]]:
    """Harvest %let constants and loop lists for deterministic substitution.

    Returns (scalars, loop_lists):
      * scalars    — %let NAME = literal;  (single-line, non-function values)
      * loop_lists — VAR -> [tokens]  for the  %do i=1 %to countw(&LIST.);
                     %let VAR=%scan(&LIST.,&i.)  idiom, so `&VAR.` can be
                     unrolled over the list values.
    """
    scalars: dict[str, str] = {}
    for m in _LET.finditer(text):
        val = m.group("val").strip()
        # Function-valued (%scan/%sysfunc/...) or multi-line values are not
        # static scalars — skip so we never inject newlines (line numbers stay
        # intact) or guess runtime results.
        if val.startswith("%") or "\n" in val:
            continue
        scalars[m.group("name").lower()] = val
    # Resolve nested references inside values (&A used within another %let).
    for _ in range(3):
        changed = False
        for k, v in list(scalars.items()):
            nv = _MACRO_REF.sub(
                lambda mm: scalars.get(mm.group("name").lower(), mm.group(0)), v)
            if nv != v:
                scalars[k] = nv
                changed = True
        if not changed:
            break
    loop_lists: dict[str, list[str]] = {}
    for m in _SCAN_LET.finditer(text):
        lst = m.group("list").lower()
        if lst in scalars and len(scalars[lst].split()) > 1:
            loop_lists[m.group("var").lower()] = scalars[lst].split()
    return scalars, loop_lists


def _subst_scalars(text: str, scalars: dict[str, str]) -> str:
    """Replace &NAME. / &NAME with its %let constant everywhere. Values are
    single-line, so newline count — and therefore every line number — is
    preserved."""
    if not scalars:
        return text
    return _MACRO_REF.sub(
        lambda m: scalars.get(m.group("name").lower(), m.group(0)), text)


def _expand_ref(raw: str, loop_lists: dict[str, list[str]]) -> list[str]:
    """Unroll a dataset reference that embeds a known loop variable into one
    concrete reference per list value (e.g. ASSETS_&country. over ES PT DE UK).
    References without a loop variable are returned unchanged."""
    for var, vals in loop_lists.items():
        pat = re.compile(r"&" + re.escape(var) + r"\b\.?", re.IGNORECASE)
        if pat.search(raw):
            return [pat.sub(v, raw) for v in vals] or [raw]
    return [raw]


# --- PROC SQL (SAS flavour) -------------------------------------------------
def _parse_proc_sql(block: str, base_line: int, filename: str,
                    result: ParseResult, idx: int,
                    macro_defs: set[str],
                    loop_lists: dict[str, list[str]]) -> None:
    for si, stmt in enumerate(block.split(";")):
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
        elif (ins := _INSERT_INTO.search(s)) and tables:
            # INSERT INTO target SELECT ... FROM sources. Loop variables in the
            # table names are unrolled over their list values (one input per
            # country, etc.) so the dynamic hop is surfaced, not dropped.
            raw_refs = [ins.group("t"), *tables]
            had_macro = any("&" in r for r in raw_refs)
            for target in _expand_ref(ins.group("t"), loop_lists):
                tid = _register(result.datasets, target, filename)
                input_ids = []
                for t in tables:
                    for sr in _expand_ref(t, loop_lists):
                        did = _register(result.datasets, sr, filename)
                        if did != tid and did not in input_ids:
                            input_ids.append(did)
                result.operations.append(Operation(
                    id=f"{filename}:sas:insert:{idx}:{si}:{tid}",
                    kind="insert",
                    target=tid,
                    inputs=input_ids,
                    file=filename,
                    language="sas",
                    line_start=base_line,
                    snippet=("insert into " + s)[:400].strip(),
                    confidence="low" if had_macro else "high",
                    notes="PROC SQL insert"
                          + (" — macro loop unrolled (assumed list values)"
                             if had_macro else ""),
                ))
            if had_macro:
                result.warnings.append(
                    f"{filename}: PROC SQL INSERT at line {base_line} builds a "
                    f"dataset name from a macro loop; inputs were unrolled over "
                    f"assumed list values — verify downstream completeness."
                )
        elif _SELECT_INTO.search(s) and tables:
            # SELECT ... INTO :macro — the table's values become macro-injected
            # code we can't resolve statically. Wire the source tables into a
            # runtime node so they stay connected and the dynamic hop is visible.
            dyn_id = _register_runtime(result.datasets, filename)
            after = s[s.lower().find("into"):]
            for mv in re.findall(r":(\w+)", after):
                macro_defs.add(mv.lower())  # so we can wire the runtime node forward
            input_ids = []
            for t in tables:
                did = _register(result.datasets, t, filename)
                if did != dyn_id and did not in input_ids:
                    input_ids.append(did)
            result.operations.append(Operation(
                id=f"{filename}:sas:macro:{idx}:{si}",
                kind="macro_read",
                target=dyn_id,
                inputs=input_ids,
                file=filename,
                language="sas",
                line_start=base_line,
                snippet=("select into : " + s)[:300].strip(),
                confidence="low",
                notes="SELECT INTO :macro — feeds runtime-generated code (AI review)",
            ))
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
    # 1b) Blank cards/datalines inline-data blocks (literal text, not statements).
    text = _blank_all(_DATALINES, text)

    # 1c) Deterministic %let constant propagation: resolve dataset names that
    # are built from macro variables (&LIB..&CTRY) to concrete tables so the
    # lineage stitches end-to-end instead of silently dropping. Resolution is
    # applied narrowly — only to macro-var-led tokens that would otherwise be
    # dropped, never to names that merely embed a macro var (plot_&grp) — so
    # already-correct output is unchanged. Loop lists are captured for unrolling
    # the  %do / %scan  idiom later.
    scalars, loop_lists = _collect_macro_vars(text)

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
    macro_defs: set[str] = set()  # macro vars populated by SELECT ... INTO :name
    for i, m in enumerate(list(_PROC_SQL.finditer(text))):
        inner = re.sub(r"(?is)^\s*proc\s+sql\b[^;]*;", "", m.group(0))
        inner = inner.rsplit("quit", 1)[0]
        _parse_proc_sql(inner, _lineno(text, m.start()), filename, result, i,
                        macro_defs, loop_lists)
        text = _blank_region(text, m.start(), m.end())

    # 4) DATA steps.
    for i, m in enumerate(_DATA_STEP.finditer(text)):
        targets = [t for t in _dataset_tokens(m.group("targets"), scalars)
                   if t.lower() not in _SKIP]
        body = m.group("body")
        inputs: list[str] = []
        kind = "datastep"
        for im in _INPUT_STMT.finditer(body):
            if im.group("kw").lower() == "merge":
                kind = "merge"
            inputs.extend(_dataset_tokens(im.group("ds"), scalars))
        if not targets:
            # Surface the gap instead of silently dropping: a DATA step whose
            # output name is built from an unresolved macro variable still
            # represents a real write we could not place.
            if "&" in m.group("targets"):
                result.warnings.append(
                    f"{filename}: DATA step at line {_lineno(text, m.start())} "
                    f"writes a macro-built dataset name "
                    f"({m.group('targets').strip()}) that could not be resolved "
                    f"statically — skipped; lineage may be incomplete.")
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
            # If this step consumes a SELECT-INTO macro var, the runtime node
            # feeds it — wire runtime -> target so runtime is an intermediate
            # hop, not a dead-end "output".
            used = _used_macro_defs(body, macro_defs)
            if used:
                rid = _register_runtime(result.datasets, filename)
                result.operations.append(Operation(
                    id=f"{filename}:sas:macroapply:{i}:{tid}",
                    kind="macro_apply", target=tid, inputs=[rid],
                    file=filename, language="sas", line_start=line,
                    snippet=m.group(0)[:300].strip(),
                    confidence="low",
                    notes="uses &" + ", &".join(used) + " from SELECT INTO :macro (runtime)",
                ))

    # 5) Generic PROC steps (export -> file, sort/means/univariate out=, ...).
    for i, m in enumerate(_PROC_STEP.finditer(text)):
        name = m.group("name").lower()
        if name == "sql":
            continue
        body = m.group("body")
        if name in ("import", "csvimport"):
            # proc import datafile="..." out=TABLE;  (external file -> dataset)
            fm = _DATAFILE.search(body)
            om = _OUT_OPT.search(body)
            if fm and om:
                path = _subst_scalars(fm.group("path"), scalars)
                out = _subst_scalars(om.group("ds"), scalars)
                in_id = _register(result.datasets, path, filename)
                out_id = _register(result.datasets, out, filename)
                if in_id != out_id:
                    unresolved = "&" in (path + out)
                    result.operations.append(Operation(
                        id=f"{filename}:sas:import:{i}",
                        kind="import", target=out_id, inputs=[in_id],
                        file=filename, language="sas",
                        line_start=_lineno(text, m.start()),
                        snippet=m.group(0)[:300].strip(),
                        confidence="medium",
                        notes="proc import (file \u2192 table)"
                              + ("; unresolved macro reference"
                                 if unresolved else ""),
                    ))
                    if unresolved:
                        result.warnings.append(
                            f"{filename}: PROC IMPORT at line "
                            f"{_lineno(text, m.start())} uses a macro-built file "
                            f"or table name that could not be resolved — lineage "
                            f"may be incomplete.")
            continue
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

        if name in _VISUAL_PROCS:
            artifact = _VISUAL_PROCS[name]
            out_id = _register_visual(result.datasets, name, in_id, artifact, filename)
            result.operations.append(Operation(
                id=f"{filename}:sas:viz:{i}",
                kind=artifact, target=out_id, inputs=[in_id],
                file=filename, language="sas",
                line_start=_lineno(text, m.start()),
                snippet=m.group(0)[:300].strip(),
                confidence="high", notes=f"proc {name} → {artifact}",
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
        used = _used_macro_defs(body, macro_defs)
        if used:
            rid = _register_runtime(result.datasets, filename)
            result.operations.append(Operation(
                id=f"{filename}:sas:macroapply:proc:{i}",
                kind="macro_apply", target=out_id, inputs=[rid],
                file=filename, language="sas",
                line_start=_lineno(text, m.start()),
                snippet=m.group(0)[:300].strip(),
                confidence="low",
                notes="uses &" + ", &".join(used) + " from SELECT INTO :macro (runtime)",
            ))

    # 6) ODS OUTPUT: `ods output label=ds;` sends the NEXT proc's output object
    # into a dataset — so that dataset is really an OUTPUT of that proc (derived
    # from the proc's data= input), not a source table.
    proc_spans = [(pm.start(), pm.group("name").lower(), pm.group("body"))
                  for pm in _PROC_STEP.finditer(text)]
    for m in _ODS_OUTPUT.finditer(text):
        pairs = re.findall(r"(\w+)\s*=\s*([\w.&]+)", m.group("pairs"))
        if not pairs:
            continue
        nxt = next((p for p in proc_spans if p[0] > m.start()), None)
        if not nxt:
            continue
        _, pname, pbody = nxt
        din = _DATA_OPT.search(pbody)
        in_ids = [_register(result.datasets, din.group("ds"), filename)] if din else []
        line = _lineno(text, m.start())
        for label, ds in pairs:
            out_id = _register(result.datasets, ds, filename)
            ins = [s for s in in_ids if s != out_id]
            result.operations.append(Operation(
                id=f"{filename}:sas:ods:{label.lower()}:{out_id}",
                kind="ods_output", target=out_id, inputs=ins,
                file=filename, language="sas", line_start=line,
                snippet=m.group(0)[:200].strip(),
                confidence="medium",
                notes=f"ods output {label} from proc {pname}",
            ))

    return result
