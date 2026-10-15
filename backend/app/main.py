"""FastAPI entry point for the Lineis lineage prototype."""
from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.middleware.sessions import SessionMiddleware

from . import agent, db
from .config import SECRET_KEY
from .graph import analyze
from .models import ParseResult
from .parsers import parse_many

BASE_DIR = Path(__file__).resolve().parent.parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
SAMPLES_DIR = BASE_DIR / "samples"
BATCHES_DIR = BASE_DIR / "test_batches"

_USERNAME_RE = re.compile(r"[A-Za-z0-9_.-]{3,30}")

app = FastAPI(title="Lineis Lineage Engine", version="0.2.0")
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, same_site="lax")


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


_CODE_EXT = (".sql", ".sas", ".py")


def _current_user_id(request: Request) -> int | None:
    return request.session.get("user_id")


def _load_report_pack(directory: Path) -> dict | None:
    """Return the CDE catalogue shipped alongside a batch, if present."""
    pack = directory / "report_pack.json"
    if not pack.is_file():
        return None
    try:
        return json.loads(pack.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _parse_dir(directory: Path, dialect: str) -> JSONResponse:
    payload: list[tuple[str, str]] = []
    if directory.exists():
        for path in sorted(directory.rglob("*")):
            if path.suffix.lower() in _CODE_EXT:
                payload.append((path.name, path.read_text(encoding="utf-8")))
    if not payload:
        return JSONResponse(analyze(ParseResult(
            warnings=[f"No code files found in {directory.name}/"])))
    result = analyze(parse_many(payload, dialect=dialect))
    report_pack = _load_report_pack(directory)
    if report_pack is not None:
        result["report_pack"] = report_pack
    return JSONResponse(result)


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
            pack = _load_report_pack(sub)
            batches.append({
                "id": sub.name,
                "name": sub.name.replace("_", " ").title(),
                "files": len(files),
                "languages": ["python" if l == "py" else l for l in langs],
                "lines": lines,
                "report_pack": bool(pack),
                "report_name": (pack or {}).get("report", {}).get("name") if pack else None,
                "cde_count": len((pack or {}).get("cdes", [])) if pack else 0,
            })
    return JSONResponse({"batches": batches})


@app.get("/api/reports")
def list_reports() -> JSONResponse:
    """Catalogue of business reports that ship with a wired report pack.

    Powers the Reports landing screen: each entry carries the report metadata
    plus a lightweight code summary of the batch that produces it.
    """
    reports = []
    if BATCHES_DIR.exists():
        for sub in sorted(p for p in BATCHES_DIR.iterdir() if p.is_dir()):
            pack = _load_report_pack(sub)
            if not pack:
                continue
            files = [f for f in sorted(sub.rglob("*")) if f.suffix.lower() in _CODE_EXT]
            if not files:
                continue
            langs = sorted({f.suffix.lower().lstrip(".") for f in files})
            lines = sum(len(f.read_text(encoding="utf-8").splitlines()) for f in files)
            meta = pack.get("report", {})
            cdes = pack.get("cdes", [])
            hero = next((c for c in cdes if c.get("hero")), cdes[0] if cdes else None)
            reports.append({
                "batch": sub.name,
                "id": meta.get("id") or sub.name,
                "name": meta.get("name") or sub.name.replace("_", " ").title(),
                "framework": meta.get("framework"),
                "domain": meta.get("domain"),
                "report_type": meta.get("report_type"),
                "owner": meta.get("owner"),
                "frequency": meta.get("frequency"),
                "version": meta.get("version"),
                "last_updated": meta.get("last_updated"),
                "unit": meta.get("unit"),
                "description": meta.get("description"),
                "cde_count": len(cdes),
                "hero_cde": (hero or {}).get("business_name"),
                "files": len(files),
                "languages": ["python" if l == "py" else l for l in langs],
                "lines": lines,
            })
    return JSONResponse({"reports": reports})


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


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------
@app.post("/api/auth/register")
async def register(request: Request) -> JSONResponse:
    data = await request.json()
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    if not _USERNAME_RE.fullmatch(username) or len(password) < 6:
        return JSONResponse(
            {"error": "Username must be 3-30 characters (letters, digits, . _ -) "
                      "and password at least 6 characters."},
            status_code=400)
    user = db.create_user(username, password)
    if user is None:
        return JSONResponse({"error": "That username is already taken."},
                            status_code=409)
    request.session["user_id"] = user["id"]
    return JSONResponse({"username": user["username"]})


@app.post("/api/auth/login")
async def login(request: Request) -> JSONResponse:
    data = await request.json()
    user = db.verify_user(data.get("username") or "", data.get("password") or "")
    if user is None:
        return JSONResponse({"error": "Invalid username or password."},
                            status_code=401)
    request.session["user_id"] = user["id"]
    return JSONResponse({"username": user["username"]})


@app.post("/api/auth/logout")
def logout(request: Request) -> JSONResponse:
    request.session.clear()
    return JSONResponse({"ok": True})


@app.get("/api/auth/me")
def me(request: Request) -> JSONResponse:
    uid = _current_user_id(request)
    agent_on = agent.agent_available()
    if uid is None:
        return JSONResponse({"user": None, "agent": agent_on})
    user = db.get_user(uid)
    return JSONResponse({"user": user, "agent": agent_on})


# ---------------------------------------------------------------------------
# History (requires login)
# ---------------------------------------------------------------------------
@app.get("/api/history")
def history(request: Request) -> JSONResponse:
    uid = _current_user_id(request)
    if uid is None:
        return JSONResponse({"error": "Not signed in."}, status_code=401)
    return JSONResponse({"analyses": db.list_analyses(uid)})


@app.post("/api/history")
async def save_history(request: Request) -> JSONResponse:
    uid = _current_user_id(request)
    if uid is None:
        return JSONResponse({"error": "Not signed in."}, status_code=401)
    data = await request.json()
    name = (data.get("name") or "Untitled analysis").strip()
    source_type = data.get("source_type") or "upload"
    result = data.get("result") or {}
    saved = db.save_analysis(uid, name, source_type, result)
    return JSONResponse(saved)


@app.get("/api/history/{analysis_id}")
def load_history(analysis_id: int, request: Request) -> JSONResponse:
    uid = _current_user_id(request)
    if uid is None:
        return JSONResponse({"error": "Not signed in."}, status_code=401)
    result = db.get_analysis(uid, analysis_id)
    if result is None:
        return JSONResponse({"error": "Not found."}, status_code=404)
    return JSONResponse(result)


@app.delete("/api/history/{analysis_id}")
def remove_history(analysis_id: int, request: Request) -> JSONResponse:
    uid = _current_user_id(request)
    if uid is None:
        return JSONResponse({"error": "Not signed in."}, status_code=401)
    ok = db.delete_analysis(uid, analysis_id)
    return JSONResponse({"ok": ok})


# ---------------------------------------------------------------------------
# AI review agent
# ---------------------------------------------------------------------------
@app.post("/api/agent/review")
async def agent_review(request: Request) -> JSONResponse:
    data = await request.json()
    result = data.get("result") or {}
    # Offload to a worker thread so the blocking HTTP call + rate-limit backoff
    # sleeps never freeze the event loop.
    review = await run_in_threadpool(agent.review, result)
    return JSONResponse(review)


app.mount("/static", StaticFiles(directory=FRONTEND_DIR / "static"), name="static")
