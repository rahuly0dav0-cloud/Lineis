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

# When DATABASE_URL points at Postgres (e.g. Neon) use it for durable storage;
# otherwise fall back to local SQLite. Keeps dev friction-free while giving the
# hosted demo a database that survives redeploys.
_DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
_PG = _DATABASE_URL.startswith(("postgres://", "postgresql://"))

if _PG:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg import errors as _pg_errors
    _INTEGRITY_ERRORS: tuple = (sqlite3.IntegrityError, _pg_errors.UniqueViolation)
else:
    _INTEGRITY_ERRORS = (sqlite3.IntegrityError,)


def _q(sql: str) -> str:
    """Translate the SQLite `?` placeholder to Postgres `%s` when needed."""
    return sql.replace("?", "%s") if _PG else sql


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_conn():
    if _PG:
        return psycopg.connect(_DATABASE_URL, row_factory=dict_row)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _insert_id(conn, sql: str, params: tuple) -> int:
    """Run an INSERT and return the new row id on either backend."""
    if _PG:
        row = conn.execute(_q(sql) + " RETURNING id", params).fetchone()
        return int(row["id"])
    return conn.execute(sql, params).lastrowid


def init_db() -> None:
    if _PG:
        with get_conn() as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS users ("
                " id SERIAL PRIMARY KEY,"
                " username TEXT UNIQUE NOT NULL,"
                " password_hash TEXT NOT NULL,"
                " salt TEXT NOT NULL,"
                " created_at TEXT NOT NULL)")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS analyses ("
                " id SERIAL PRIMARY KEY,"
                " user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,"
                " name TEXT NOT NULL,"
                " source_type TEXT,"
                " created_at TEXT NOT NULL,"
                " stats_json TEXT,"
                " result_json TEXT)")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_analyses_user"
                " ON analyses(user_id, created_at DESC)")
        return
    with get_conn() as conn:
        # Migrate legacy 'email' column to 'username' for existing local DBs.
        cols = [r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
        if cols and "email" in cols and "username" not in cols:
            conn.execute("ALTER TABLE users RENAME COLUMN email TO username")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT UNIQUE NOT NULL,
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


def create_user(username: str, password: str) -> Optional[dict[str, Any]]:
    salt = os.urandom(16)
    pwd_hash = _hash_password(password, salt)
    try:
        with get_conn() as conn:
            new_id = _insert_id(
                conn,
                "INSERT INTO users (username, password_hash, salt, created_at) "
                "VALUES (?, ?, ?, ?)",
                (username.lower(), pwd_hash, salt.hex(), _now()),
            )
            return {"id": new_id, "username": username.lower()}
    except _INTEGRITY_ERRORS:
        return None  # username already taken


def verify_user(username: str, password: str) -> Optional[dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(
            _q("SELECT * FROM users WHERE username = ?"), (username.lower(),)
        ).fetchone()
    if row is None:
        return None
    expected = _hash_password(password, bytes.fromhex(row["salt"]))
    if not _constant_time_eq(expected, row["password_hash"]):
        return None
    return {"id": row["id"], "username": row["username"]}


def _constant_time_eq(a: str, b: str) -> bool:
    import hmac
    return hmac.compare_digest(a, b)


def get_user(user_id: int) -> Optional[dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(
            _q("SELECT id, username, created_at FROM users WHERE id = ?"), (user_id,)
        ).fetchone()
    return dict(row) if row else None


# --- analyses ---------------------------------------------------------------
def save_analysis(user_id: int, name: str, source_type: str,
                  result: dict[str, Any]) -> dict[str, Any]:
    stats = result.get("stats", {})
    with get_conn() as conn:
        new_id = _insert_id(
            conn,
            "INSERT INTO analyses (user_id, name, source_type, created_at, "
            "stats_json, result_json) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, name, source_type, _now(),
             json.dumps(stats), json.dumps(result)),
        )
        return {"id": new_id, "name": name}


def list_analyses(user_id: int) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            _q("SELECT id, name, source_type, created_at, stats_json "
               "FROM analyses WHERE user_id = ? ORDER BY created_at DESC"),
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
            _q("SELECT result_json FROM analyses WHERE id = ? AND user_id = ?"),
            (analysis_id, user_id),
        ).fetchone()
    return json.loads(row["result_json"]) if row else None


def delete_analysis(user_id: int, analysis_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            _q("DELETE FROM analyses WHERE id = ? AND user_id = ?"),
            (analysis_id, user_id),
        )
        return cur.rowcount > 0
