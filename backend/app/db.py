"""SQLite persistence for users and saved lineage analyses (stdlib only)."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone
from typing import Any, Optional

from .config import DATA_DIR, DB_PATH

_PBKDF2_ROUNDS = 200_000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_conn() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                email         TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                salt          TEXT NOT NULL,
                created_at    TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS analyses (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL,
                name        TEXT NOT NULL,
                source_type TEXT,
                created_at  TEXT NOT NULL,
                stats_json  TEXT,
                result_json TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_analyses_user
                ON analyses(user_id, created_at DESC);
            """
        )


# --- password hashing -------------------------------------------------------
def _hash_password(password: str, salt: bytes) -> str:
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ROUNDS)
    return dk.hex()


def create_user(email: str, password: str) -> Optional[dict[str, Any]]:
    salt = os.urandom(16)
    pwd_hash = _hash_password(password, salt)
    try:
        with get_conn() as conn:
            cur = conn.execute(
                "INSERT INTO users (email, password_hash, salt, created_at) "
                "VALUES (?, ?, ?, ?)",
                (email.lower(), pwd_hash, salt.hex(), _now()),
            )
            return {"id": cur.lastrowid, "email": email.lower()}
    except sqlite3.IntegrityError:
        return None  # email already registered


def verify_user(email: str, password: str) -> Optional[dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE email = ?", (email.lower(),)
        ).fetchone()
    if row is None:
        return None
    expected = _hash_password(password, bytes.fromhex(row["salt"]))
    if not _constant_time_eq(expected, row["password_hash"]):
        return None
    return {"id": row["id"], "email": row["email"]}


def _constant_time_eq(a: str, b: str) -> bool:
    import hmac
    return hmac.compare_digest(a, b)


def get_user(user_id: int) -> Optional[dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, email, created_at FROM users WHERE id = ?", (user_id,)
        ).fetchone()
    return dict(row) if row else None


# --- analyses ---------------------------------------------------------------
def save_analysis(user_id: int, name: str, source_type: str,
                  result: dict[str, Any]) -> dict[str, Any]:
    stats = result.get("stats", {})
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO analyses (user_id, name, source_type, created_at, "
            "stats_json, result_json) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, name, source_type, _now(),
             json.dumps(stats), json.dumps(result)),
        )
        return {"id": cur.lastrowid, "name": name}


def list_analyses(user_id: int) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, source_type, created_at, stats_json "
            "FROM analyses WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,),
        ).fetchall()
    out = []
    for r in rows:
        out.append({
            "id": r["id"],
            "name": r["name"],
            "source_type": r["source_type"],
            "created_at": r["created_at"],
            "stats": json.loads(r["stats_json"] or "{}"),
        })
    return out


def get_analysis(user_id: int, analysis_id: int) -> Optional[dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT result_json FROM analyses WHERE id = ? AND user_id = ?",
            (analysis_id, user_id),
        ).fetchone()
    return json.loads(row["result_json"]) if row else None


def delete_analysis(user_id: int, analysis_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM analyses WHERE id = ? AND user_id = ?",
            (analysis_id, user_id),
        )
        return cur.rowcount > 0
