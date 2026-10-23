import base64
import binascii
import hashlib
import os
import re
import uuid

from flask import Blueprint, Response, abort, g, redirect, render_template, request, url_for
from pycrdt import Doc, Map, Text, merge_updates

from auth import fetch_only, login_required, same_origin
from db import INIT_HOOKS, get_db, now_ms, uuid7, write_transaction
from folders import FOLDER_COLORS, folder_json, owned_folder, place_graph, user_folders
from lucide import ICON_MARKUP, LUCIDE_VERSION

CHECKPOINT_EVERY = 200
MAX_UPDATES_PER_REQUEST = 500
MAX_UPDATE_BYTES = 1 << 20
MAX_THUMBNAIL_BYTES = 2 << 20
MAX_IMAGE_BYTES = 10 << 20
MAX_TITLE = 200
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}
SHA256_RE = re.compile(r"[0-9a-f]{64}")
DEFAULT_TITLE = "Untitled Graph"
DEFAULT_TITLE_RE = re.compile(r"Untitled Graph(?: \((\d+)\))?")
EMPTY_UPDATE = Doc().get_update()

graphs_bp = Blueprint("graphs", __name__)


def owned_graph(graph_id):
    try:
        graph_id = str(uuid.UUID(graph_id))
    except ValueError:
        abort(404)
    row = get_db().execute(
        "SELECT * FROM graphs WHERE id = ? AND owner_id = ? AND deleted_at IS NULL", (graph_id, g.user["id"])
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


def default_title(db, owner_id):
    used = set()
    for row in db.execute(
        "SELECT title FROM graphs WHERE owner_id = ? AND deleted_at IS NULL AND title LIKE ?",
        (owner_id, DEFAULT_TITLE + "%"),
    ):
        match = DEFAULT_TITLE_RE.fullmatch(row["title"])
        if match:
            used.add(int(match[1] or 1))
    n = 1
    while n in used:
        n += 1
    return DEFAULT_TITLE if n == 1 else f"{DEFAULT_TITLE} ({n})"


def title_update(state, title):
    doc = Doc()
    doc.apply_update(state)
    before = doc.get_state()
    meta = doc.get("meta", type=Map)
    with doc.transaction():
        current = meta.get("title")
        if isinstance(current, Text):
            del current[:]
            current += title
        else:
            meta["title"] = Text(title)
    return doc.get_update(before)


def append_server_update(db, graph_id, author_id, data, now):
    seq = db.execute("SELECT COALESCE(MAX(seq), 0) FROM updates WHERE graph_id = ?", (graph_id,)).fetchone()[0]
    db.execute(
        "INSERT INTO updates (graph_id, seq, ts, client_ts, author_id, client_update_id, data)"
        " VALUES (?, ?, ?, NULL, ?, ?, ?)",
        (graph_id, seq + 1, now, author_id, str(uuid.uuid4()), data),
    )


def backfill_untitled(db):
    rows = db.execute(
        "SELECT id, owner_id FROM graphs WHERE title = '' AND deleted_at IS NULL ORDER BY owner_id, created_at, id"
    ).fetchall()
    if not rows:
        return
    with write_transaction(db):
        for row in rows:
            title = default_title(db, row["owner_id"])
            state, _ = load_state(db, row["id"])
            now = now_ms()
            append_server_update(db, row["id"], row["owner_id"], title_update(state, title), now)
            db.execute("UPDATE graphs SET title = ? WHERE id = ?", (title, row["id"]))


INIT_HOOKS.append(backfill_untitled)


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


def render_library(view):
    rows = get_db().execute(
        "SELECT graphs.id, graphs.title, graphs.updated_at, graphs.thumbnail_at, graph_placements.folder_id"
        " FROM graphs LEFT JOIN graph_placements"
        " ON graph_placements.graph_id = graphs.id AND graph_placements.user_id = graphs.owner_id"
        " WHERE graphs.owner_id = ? AND graphs.deleted_at IS NULL ORDER BY graphs.updated_at DESC",
        (g.user["id"],),
    ).fetchall()
    folders = [folder_json(row) for row in user_folders(g.user["id"])]
    icons = {folder["icon"]: ICON_MARKUP.get(folder["icon"], "") for folder in folders}
    return render_template(
        "library.html", graphs=rows, folders=folders, view=view, folder_colors=FOLDER_COLORS, folder_icon_markup=icons,
        lucide_version=LUCIDE_VERSION,
    )


@graphs_bp.get("/")
@login_required
def library():
    return render_library("all")


@graphs_bp.get("/folders/<folder_id>")
@login_required
def folder(folder_id):
    return render_library(owned_folder(folder_id)["id"])


@graphs_bp.get("/shared")
@login_required
def shared():
    return render_library("shared")


@graphs_bp.post("/graphs")
@login_required
@same_origin
def create():
    folder_id = request.form.get("folder_id")
    folder_id = owned_folder(folder_id)["id"] if folder_id else None
    graph_id = uuid7()
    now = now_ms()
    db = get_db()
    with write_transaction(db):
        title = default_title(db, g.user["id"])
        db.execute(
            "INSERT INTO graphs (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (graph_id, g.user["id"], title, now, now),
        )
        append_server_update(db, graph_id, g.user["id"], title_update(EMPTY_UPDATE, title), now)
        if folder_id:
            place_graph(db, g.user["id"], graph_id, folder_id)
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


@graphs_bp.post("/graphs/<graph_id>/folder")
@login_required
@fetch_only
def move(graph_id):
    graph_id = owned_graph(graph_id)["id"]
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or "folder_id" not in payload:
        abort(400)
    folder_id = payload["folder_id"]
    folder_id = owned_folder(folder_id)["id"] if folder_id is not None else None
    db = get_db()
    with write_transaction(db):
        place_graph(db, g.user["id"], graph_id, folder_id)
    return {"folder_id": folder_id}


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
                "INSERT OR IGNORE INTO updates (graph_id, seq, ts, client_ts, author_id, client_update_id, data)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (graph_id, seq + 1, now, client_ts, g.user["id"], update_id, data),
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
        db.execute("INSERT OR IGNORE INTO image_owners (sha256, owner_id) VALUES (?, ?)", (sha, g.user["id"]))
    return {"url": url_for("graphs.image", sha=sha)}


@graphs_bp.get("/images/<sha>")
@login_required
def image(sha):
    if not SHA256_RE.fullmatch(sha):
        abort(404)
    row = get_db().execute(
        "SELECT images.mime, images.data FROM images JOIN image_owners USING (sha256)"
        " WHERE sha256 = ? AND owner_id = ?",
        (sha, g.user["id"]),
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
