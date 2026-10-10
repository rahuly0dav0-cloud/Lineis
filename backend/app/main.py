"""FastAPI entry point for the Lineis lineage prototype."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
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

app = FastAPI(title="Lineis Lineage Engine", version="0.2.0")
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, same_site="lax")


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


_CODE_EXT = (".sql", ".sas", ".py")


def _current_user_id(request: Request) -> int | None:
    return request.session.get("user_id")


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


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------
@app.post("/api/auth/register")
async def register(request: Request) -> JSONResponse:
    data = await request.json()
    email = (data.get("email") or "").strip()
    password = data.get("password") or ""
    if "@" not in email or len(password) < 6:
        return JSONResponse(
            {"error": "Valid email and a password of 6+ characters required."},
            status_code=400)
    user = db.create_user(email, password)
    if user is None:
        return JSONResponse({"error": "That email is already registered."},
                            status_code=409)
    request.session["user_id"] = user["id"]
    return JSONResponse({"email": user["email"]})


@app.post("/api/auth/login")
async def login(request: Request) -> JSONResponse:
    data = await request.json()
    user = db.verify_user(data.get("email") or "", data.get("password") or "")
    if user is None:
        return JSONResponse({"error": "Invalid email or password."},
                            status_code=401)
    request.session["user_id"] = user["id"]
    return JSONResponse({"email": user["email"]})


@app.post("/api/auth/logout")
def logout(request: Request) -> JSONResponse:
    request.session.clear()
    return JSONResponse({"ok": True})


@app.get("/api/auth/me")
def me(request: Request) -> JSONResponse:
    uid = _current_user_id(request)
    if uid is None:
        return JSONResponse({"user": None})
    user = db.get_user(uid)
    return JSONResponse({"user": user, "agent": agent.agent_available()})


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
    return JSONResponse(agent.review(result))


app.mount("/static", StaticFiles(directory=FRONTEND_DIR / "static"), name="static")
