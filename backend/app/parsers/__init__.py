"""Language detection and the parser dispatch entry point."""
from __future__ import annotations

import os

from ..models import ParseResult
from . import sql_parser, sas_parser, python_parser

_EXT_LANG = {
    ".sql": "sql",
    ".sas": "sas",
    ".py": "python",
}


def detect_language(filename: str, code: str) -> str | None:
    ext = os.path.splitext(filename)[1].lower()
    if ext in _EXT_LANG:
        return _EXT_LANG[ext]

    lowered = code.lower()
    if "proc sql" in lowered or "\ndata " in lowered or lowered.startswith("data "):
        return "sas"
    if "import pandas" in lowered or "def " in lowered or "pd.read" in lowered:
        return "python"
    if "select " in lowered and "from " in lowered:
        return "sql"
    return None


def parse_file(filename: str, code: str, dialect: str = "") -> ParseResult:
    lang = detect_language(filename, code)
    if lang == "sql":
        return sql_parser.parse(code, filename, dialect=dialect)
    if lang == "sas":
        return sas_parser.parse(code, filename)
    if lang == "python":
        return python_parser.parse(code, filename)

    return ParseResult(warnings=[f"Could not detect a supported language for {filename}"])


def parse_many(files: list[tuple[str, str]], dialect: str = "") -> ParseResult:
    """Parse all files and merge into one stitched lineage result."""
    combined = ParseResult()
    for filename, code in files:
        try:
            combined.merge(parse_file(filename, code, dialect=dialect))
        except Exception as exc:  # keep one bad file from killing the batch
            combined.warnings.append(f"{filename}: parse error - {exc}")
    return combined
