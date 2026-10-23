import base64
import binascii
import hashlib
import os
import re
import uuid
from contextlib import contextmanager

from flask import Blueprint, Response, abort, redirect, render_template, request, session, url_for
from pycrdt import Doc, Map, merge_updates

from auth import fetch_only, login_required, same_origin
from db import get_db, now_ms, uuid7

CHECKPOINT_EVERY = 200
MAX_UPDATES_PER_REQUEST = 500
MAX_UPDATE_BYTES = 1 << 20
MAX_THUMBNAIL_BYTES = 2 << 20
MAX_IMAGE_BYTES = 10 << 20
MAX_TITLE = 200
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}
SHA256_RE = re.compile(r"[0-9a-f]{64}")
EMPTY_UPDATE = Doc().get_update()

graphs_bp = Blueprint("graphs", __name__)


@contextmanager
def write_transaction(db):
    db.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        db.execute("ROLLBACK")
        raise
    db.execute("COMMIT")


def owned_graph(graph_id):
    try:
        graph_id = str(uuid.UUID(graph_id))
    except ValueError:
        abort(404)
    row = get_db().execute(
        "SELECT * FROM graphs WHERE id = ? AND owner_email = ? AND deleted_at IS NULL", (graph_id, session["email"])
    ).fetchone()
    if row is None:
        abort(404)
    return row


def load_state(db, graph_id):
    checkpoint = db.execute(
        "SELECT seq, state FROM checkpoints WHERE graph_id = ? ORDER BY seq DESC LIMIT 1", (graph_id,)
    ).fetchone()
    since = checkpoint["seq"] if checkpoint else 0
    rows = db.execute(
        "SELECT data FROM updates WHERE graph_id = ? AND seq > ? ORDER BY seq", (graph_id, since)
    ).fetchall()
    parts = ([checkpoint["state"]] if checkpoint else []) + [row["data"] for row in rows]
    return (merge_updates(*parts) if parts else EMPTY_UPDATE), len(rows)


def title_of(state):
    doc = Doc()
    doc.apply_update(state)
    title = doc.get("meta", type=Map).get("title")
    return "" if title is None else str(title).strip()[:MAX_TITLE]


def parse_updates(payload):
    items = payload.get("updates") if isinstance(payload, dict) else None
    if not isinstance(items, list) or not 0 < len(items) <= MAX_UPDATES_PER_REQUEST:
        abort(400)
    parsed = []
    for item in items:
        try:
            update_id = str(uuid.UUID(item["id"]))
            data = base64.b64decode(item["data"], validate=True)
            client_ts = item.get("ts")
            if client_ts is not None:
                client_ts = int(client_ts)
            if not data or len(data) > MAX_UPDATE_BYTES:
                raise ValueError
            Doc().apply_update(data)
        except (KeyError, TypeError, ValueError, binascii.Error):
            abort(400)
        parsed.append((update_id, client_ts, data))
    return parsed


@graphs_bp.get("/")
@login_required
def library():
    rows = get_db().execute(
        "SELECT id, title, updated_at, thumbnail_at FROM graphs"
        " WHERE owner_email = ? AND deleted_at IS NULL ORDER BY updated_at DESC",
        (session["email"],),
    ).fetchall()
    return render_template("library.html", graphs=rows)


@graphs_bp.post("/graphs")
@login_required
@same_origin
def create():
    graph_id = uuid7()
    now = now_ms()
    db = get_db()
    with write_transaction(db):
        db.execute(
            "INSERT INTO graphs (id, owner_email, title, created_at, updated_at) VALUES (?, ?, '', ?, ?)",
            (graph_id, session["email"], now, now),
        )
    return redirect(url_for("graphs.calculator", graph_id=graph_id))


@graphs_bp.post("/graphs/<graph_id>/delete")
@login_required
@same_origin
def delete(graph_id):
    graph_id = owned_graph(graph_id)["id"]
    db = get_db()
    with write_transaction(db):
        db.execute("UPDATE graphs SET deleted_at = ? WHERE id = ?", (now_ms(), graph_id))
    return redirect(url_for("graphs.library"))


@graphs_bp.get("/calculator/<graph_id>")
@login_required
def calculator(graph_id):
    graph = owned_graph(graph_id)
    return render_template("calculator.html", graph=graph, api_key=os.environ["DESMOS_API_KEY"])


@graphs_bp.get("/graphs/<graph_id>/doc")
@login_required
def load(graph_id):
    graph = owned_graph(graph_id)
    state, _ = load_state(get_db(), graph["id"])
    return Response(state, mimetype="application/octet-stream", headers={"Cache-Control": "no-store"})


@graphs_bp.post("/graphs/<graph_id>/updates")
@login_required
@fetch_only
def append_updates(graph_id):
    graph_id = owned_graph(graph_id)["id"]
    parsed = parse_updates(request.get_json(silent=True))
    db = get_db()
    now = now_ms()
    with write_transaction(db):
        seq = db.execute("SELECT COALESCE(MAX(seq), 0) FROM updates WHERE graph_id = ?", (graph_id,)).fetchone()[0]
        added = 0
        for update_id, client_ts, data in parsed:
            inserted = db.execute(
                "INSERT OR IGNORE INTO updates (graph_id, seq, ts, client_ts, author_email, client_update_id, data)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (graph_id, seq + 1, now, client_ts, session["email"], update_id, data),
            ).rowcount
            seq += inserted
            added += inserted
        if added:
            state, since_checkpoint = load_state(db, graph_id)
            db.execute(
                "UPDATE graphs SET title = ?, updated_at = ? WHERE id = ?", (title_of(state), now, graph_id)
            )
            if since_checkpoint >= CHECKPOINT_EVERY:
                db.execute(
                    "INSERT INTO checkpoints (graph_id, seq, ts, state) VALUES (?, ?, ?, ?)",
                    (graph_id, seq, now, state),
                )
    return {"acked": [update_id for update_id, _, _ in parsed], "seq": seq}


@graphs_bp.post("/graphs/<graph_id>/thumbnail")
@login_required
@fetch_only
def upload_thumbnail(graph_id):
    graph_id = owned_graph(graph_id)["id"]
    png = request.get_data()
    if not png.startswith(PNG_MAGIC) or len(png) > MAX_THUMBNAIL_BYTES:
        abort(400)
    db = get_db()
    with write_transaction(db):
        db.execute("INSERT OR REPLACE INTO thumbnails (graph_id, png) VALUES (?, ?)", (graph_id, png))
        db.execute("UPDATE graphs SET thumbnail_at = ? WHERE id = ?", (now_ms(), graph_id))
    return {"ok": True}


@graphs_bp.get("/graphs/<graph_id>/thumbnail.png")
@login_required
def thumbnail(graph_id):
    graph_id = owned_graph(graph_id)["id"]
    row = get_db().execute("SELECT png FROM thumbnails WHERE graph_id = ?", (graph_id,)).fetchone()
    if row is None:
        abort(404)
    cache = "private, max-age=31536000, immutable" if "v" in request.args else "private, no-cache"
    return Response(row["png"], mimetype="image/png", headers={"Cache-Control": cache})


@graphs_bp.post("/images")
@login_required
@fetch_only
def upload_image():
    data = request.get_data()
    if request.mimetype not in IMAGE_TYPES or not data or len(data) > MAX_IMAGE_BYTES:
        abort(400)
    sha = hashlib.sha256(data).hexdigest()
    db = get_db()
    with write_transaction(db):
        db.execute(
            "INSERT OR IGNORE INTO images (sha256, mime, data, created_at) VALUES (?, ?, ?, ?)",
            (sha, request.mimetype, data, now_ms()),
        )
        db.execute("INSERT OR IGNORE INTO image_owners (sha256, owner_email) VALUES (?, ?)", (sha, session["email"]))
    return {"url": url_for("graphs.image", sha=sha)}


@graphs_bp.get("/images/<sha>")
@login_required
def image(sha):
    if not SHA256_RE.fullmatch(sha):
        abort(404)
    row = get_db().execute(
        "SELECT images.mime, images.data FROM images JOIN image_owners USING (sha256)"
        " WHERE sha256 = ? AND owner_email = ?",
        (sha, session["email"]),
    ).fetchone()
    if row is None:
        abort(404)
    return Response(
        row["data"],
        mimetype=row["mime"],
        headers={
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
    )
