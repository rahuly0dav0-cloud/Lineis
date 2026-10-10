"""FastAPI entry point for the BCBS 239 lineage prototype."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .graph import analyze
from .models import ParseResult
from .parsers import parse_many

BASE_DIR = Path(__file__).resolve().parent.parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
SAMPLES_DIR = BASE_DIR / "samples"
BATCHES_DIR = BASE_DIR / "test_batches"

app = FastAPI(title="BCBS 239 Lineage Parser", version="0.1.0")

_CODE_EXT = (".sql", ".sas", ".py")


def _parse_dir(directory: Path, dialect: str) -> JSONResponse:
    payload: list[tuple[str, str]] = []
    if directory.exists():
        for path in sorted(directory.rglob("*")):
            if path.suffix.lower() in _CODE_EXT:
                payload.append((path.name, path.read_text(encoding="utf-8")))
    if not payload:
        return JSONResponse(analyze(ParseResult(
            warnings=[f"No code files found in {directory.name}/"])))
    return JSONResponse(analyze(parse_many(payload, dialect=dialect)))


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/api/batches")
def list_batches() -> JSONResponse:
    batches = []
    if BATCHES_DIR.exists():
        for sub in sorted(p for p in BATCHES_DIR.iterdir() if p.is_dir()):
            files = [f for f in sorted(sub.rglob("*")) if f.suffix.lower() in _CODE_EXT]
            if not files:
                continue
            langs = sorted({f.suffix.lower().lstrip(".") for f in files})
            lines = sum(len(f.read_text(encoding="utf-8").splitlines()) for f in files)
            batches.append({
                "id": sub.name,
                "name": sub.name.replace("_", " ").title(),
                "files": len(files),
                "languages": ["python" if l == "py" else l for l in langs],
                "lines": lines,
            })
    return JSONResponse({"batches": batches})


@app.post("/api/parse")
async def parse_endpoint(
    files: list[UploadFile] = File(...),
    dialect: str = Form(""),
) -> JSONResponse:
    payload: list[tuple[str, str]] = []
    for f in files:
        raw = await f.read()
        payload.append((f.filename, raw.decode("utf-8", errors="replace")))
    result = parse_many(payload, dialect=dialect)
    return JSONResponse(analyze(result))


@app.post("/api/parse-samples")
def parse_samples(dialect: str = Form("")) -> JSONResponse:
    return _parse_dir(SAMPLES_DIR, dialect)


@app.post("/api/parse-batch")
def parse_batch(name: str = Form(...), dialect: str = Form("")) -> JSONResponse:
    target = (BATCHES_DIR / name).resolve()
    if BATCHES_DIR not in target.parents or not target.is_dir():
        return JSONResponse(analyze(ParseResult(warnings=["Unknown batch"])))
    return _parse_dir(target, dialect)


app.mount("/static", StaticFiles(directory=FRONTEND_DIR / "static"), name="static")
