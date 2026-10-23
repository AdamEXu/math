import os
import sqlite3
import time
import uuid
from pathlib import Path

from flask import current_app, g

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    handle TEXT UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    google_name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS graphs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users (id),
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    thumbnail_at INTEGER,
    deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS graphs_owner_updated ON graphs (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS updates (
    graph_id TEXT NOT NULL REFERENCES graphs (id),
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    client_ts INTEGER,
    author_id TEXT NOT NULL REFERENCES users (id),
    client_update_id TEXT NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (graph_id, seq),
    UNIQUE (graph_id, client_update_id)
);

CREATE TABLE IF NOT EXISTS checkpoints (
    graph_id TEXT NOT NULL REFERENCES graphs (id),
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    state BLOB NOT NULL,
    PRIMARY KEY (graph_id, seq)
);

CREATE TABLE IF NOT EXISTS thumbnails (
    graph_id TEXT PRIMARY KEY REFERENCES graphs (id),
    png BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS images (
    sha256 TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS image_owners (
    sha256 TEXT NOT NULL REFERENCES images (sha256),
    owner_id TEXT NOT NULL REFERENCES users (id),
    PRIMARY KEY (sha256, owner_id)
);
"""

ADDED_COLUMNS = {
    "users": {"google_picture_url": "TEXT"},
}

_initialized = set()


def now_ms():
    return int(time.time() * 1000)


def uuid7():
    value = (now_ms() & ((1 << 48) - 1)) << 80 | int.from_bytes(os.urandom(10))
    value = value & ~(0xF << 76) | 0x7 << 76
    value = value & ~(0x3 << 62) | 0x2 << 62
    return str(uuid.UUID(int=value))


def add_missing_columns(conn):
    for table, columns in ADDED_COLUMNS.items():
        existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        for name, declaration in columns.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")


def db_path():
    return Path(current_app.config["DATA_DIR"]) / "math.db"


def get_db():
    if "db" not in g:
        path = db_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path, isolation_level=None, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        if path not in _initialized:
            conn.executescript(SCHEMA)
            add_missing_columns(conn)
            _initialized.add(path)
        g.db = conn
    return g.db


def close_db(_exc=None):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()
