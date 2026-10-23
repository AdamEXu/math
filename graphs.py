import base64
import binascii
import hashlib
import re
import uuid

from flask import Blueprint, Response, abort, g, request, url_for
from pycrdt import Doc

import desmos_com
import realtime
from access import GRAPH_ACCESS_QUERY, LISTED, access_row, at_least, role_of
from auth import fetch_only, login_required
from db import INIT_HOOKS, get_db, now_ms, uuid7, write_transaction
from docstore import (
    EMPTY_UPDATE,
    MAX_TITLE,
    GraphDoc,
    append_server_update,
    graph_lock,
    imported_update,
    load_state,
    title_update,
)
from folders import owned_folder, place_graph
from users import public_user_json

MAX_UPDATES_PER_REQUEST = 500
MAX_UPDATE_BYTES = 1 << 20
MAX_THUMBNAIL_BYTES = 2 << 20
MAX_IMAGE_BYTES = 10 << 20
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}
SHA256_RE = re.compile(r"[0-9a-f]{64}")
DEFAULT_TITLE = "Untitled Graph"
DEFAULT_TITLE_RE = re.compile(r"Untitled Graph(?: \((\d+)\))?")

graphs_bp = Blueprint("graphs", __name__)
files_bp = Blueprint("files", __name__)


def parse_graph_id(graph_id):
    try:
        return str(uuid.UUID(graph_id))
    except ValueError:
        abort(404)


def accessible_graph(graph_id, minimum="viewer"):
    row = access_row(get_db(), parse_graph_id(graph_id), g.user["id"])
    role = role_of(row, g.user["id"]) if row else None
    if role is None:
        abort(404)
    if not at_least(role, minimum):
        abort(403)
    return row, role


def owner_json(row):
    return public_user_json(
        {
            "id": row["owner_id"],
            "handle": row["owner_handle"],
            "display_name": row["owner_display_name"],
            "google_picture_url": row["owner_google_picture_url"],
        }
    )


def graph_json(row):
    data = {key: row[key] for key in ("id", "title", "updated_at", "thumbnail_at", "folder_id")}
    data["role"] = role_of(row, g.user["id"])
    data["owner"] = owner_json(row)
    return data


def graph_by_id(graph_id):
    return graph_json(access_row(get_db(), graph_id, g.user["id"]))


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


def record_link_visit(db, row):
    if row["owner_id"] == g.user["id"] or row["member_role"] or not row["link_access"]:
        return
    db.execute(
        "INSERT INTO graph_link_visits (user_id, graph_id, opened_at) VALUES (?, ?, ?)"
        " ON CONFLICT (user_id, graph_id) DO UPDATE SET opened_at = excluded.opened_at",
        (g.user["id"], row["id"], now_ms()),
    )


@graphs_bp.get("/graphs")
@login_required
def list_graphs():
    rows = get_db().execute(
        GRAPH_ACCESS_QUERY + LISTED + " ORDER BY graphs.updated_at DESC", {"user": g.user["id"]}
    ).fetchall()
    return {"graphs": [graph_json(row) for row in rows]}


def payload_folder(payload):
    folder_id = payload.get("folder_id")
    return owned_folder(folder_id)["id"] if folder_id is not None else None


def insert_graph(folder_id, initial_update, title=None):
    graph_id = uuid7()
    now = now_ms()
    db = get_db()
    with write_transaction(db):
        title = title or default_title(db, g.user["id"])
        db.execute(
            "INSERT INTO graphs (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (graph_id, g.user["id"], title, now, now),
        )
        append_server_update(db, graph_id, g.user["id"], initial_update(title), now)
        if folder_id:
            place_graph(db, g.user["id"], graph_id, folder_id)
    return graph_by_id(graph_id)


def desmos_failure(error):
    return {"error": error.message}, error.status


@graphs_bp.post("/graphs")
@login_required
def create():
    payload = request.get_json(silent=True) if request.get_data() else {}
    if not isinstance(payload, dict):
        abort(400)
    folder_id = payload_folder(payload)
    return insert_graph(folder_id, lambda title: title_update(EMPTY_UPDATE, title)), 201


@graphs_bp.post("/graphs/import-desmos")
@login_required
def import_desmos():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        abort(400)
    folder_id = payload_folder(payload)
    graph_hash = desmos_com.parse_link(payload.get("link"))
    if graph_hash is None:
        return {"error": "Paste a desmos.com/calculator link."}, 400
    if not desmos_com.import_limiter.allow(g.user["id"]):
        return {"error": "Too many imports. Wait a few minutes and try again."}, 429
    try:
        graph = desmos_com.fetch_graph(graph_hash)
    except desmos_com.DesmosError as error:
        return desmos_failure(error)
    title = graph["title"][:MAX_TITLE].strip()
    if DEFAULT_TITLE_RE.fullmatch(title):
        title = ""
    return insert_graph(folder_id, lambda final: imported_update(final, graph["state"]), title), 201


@graphs_bp.get("/graphs/<graph_id>")
@login_required
def show(graph_id):
    row, _ = accessible_graph(graph_id)
    return graph_json(row)


@graphs_bp.delete("/graphs/<graph_id>")
@login_required
def delete(graph_id):
    graph_id = accessible_graph(graph_id, "owner")[0]["id"]
    db = get_db()
    with write_transaction(db):
        db.execute("UPDATE graphs SET deleted_at = ? WHERE id = ?", (now_ms(), graph_id))
    realtime.reauthorize(graph_id)
    return {"ok": True}


@graphs_bp.put("/graphs/<graph_id>/folder")
@login_required
def move(graph_id):
    graph_id = accessible_graph(graph_id)[0]["id"]
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or "folder_id" not in payload:
        abort(400)
    folder_id = payload["folder_id"]
    folder_id = owned_folder(folder_id)["id"] if folder_id is not None else None
    db = get_db()
    with write_transaction(db):
        place_graph(db, g.user["id"], graph_id, folder_id)
    return {"folder_id": folder_id}


@graphs_bp.get("/graphs/<graph_id>/doc")
@login_required
def load(graph_id):
    row, _ = accessible_graph(graph_id)
    db = get_db()
    record_link_visit(db, row)
    state, _ = load_state(db, row["id"])
    return Response(state, mimetype="application/octet-stream", headers={"Cache-Control": "no-store"})


@graphs_bp.post("/graphs/<graph_id>/updates")
@login_required
def append_updates(graph_id):
    graph_id = accessible_graph(graph_id, "editor")[0]["id"]
    parsed = parse_updates(request.get_json(silent=True))
    db = get_db()
    with graph_lock(graph_id):
        room = realtime.live_room(graph_id)
        graph_doc = room.graph_doc if room else GraphDoc(db, graph_id)
        try:
            seq, deltas = graph_doc.apply_logged(db, parsed, g.user["id"], now_ms())
        except BaseException:
            if room:
                realtime.discard(room)
            raise
    if room:
        room.broadcast_updates(deltas)
    return {"acked": [update_id for update_id, _, _ in parsed], "seq": seq}


@graphs_bp.post("/graphs/<graph_id>/export-desmos")
@login_required
def export_desmos(graph_id):
    row, _ = accessible_graph(graph_id)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        abort(400)
    state = payload.get("state")
    thumbnail = payload.get("thumbnail")
    if not desmos_com.valid_state(state) or not desmos_com.thumbnail_ok(thumbnail):
        abort(400)
    if not desmos_com.export_limiter.allow(g.user["id"]):
        return {"error": "Too many exports. Wait a few minutes and try again."}, 429
    try:
        saved_hash = desmos_com.publish(state, row["title"] or DEFAULT_TITLE, thumbnail)
    except desmos_com.DesmosError as error:
        return desmos_failure(error)
    return {"hash": saved_hash, "url": desmos_com.graph_url(saved_hash)}


@graphs_bp.post("/graphs/<graph_id>/thumbnail")
@login_required
def upload_thumbnail(graph_id):
    graph_id = accessible_graph(graph_id, "editor")[0]["id"]
    png = request.get_data()
    if not png.startswith(PNG_MAGIC) or len(png) > MAX_THUMBNAIL_BYTES:
        abort(400)
    db = get_db()
    with write_transaction(db):
        db.execute("INSERT OR REPLACE INTO thumbnails (graph_id, png) VALUES (?, ?)", (graph_id, png))
        db.execute("UPDATE graphs SET thumbnail_at = ? WHERE id = ?", (now_ms(), graph_id))
    return {"ok": True}


@graphs_bp.post("/images")
@login_required
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
    return {"url": url_for("files.image", sha=sha)}


files_bp.add_url_rule(
    "/graphs/<graph_id>/updates", "legacy_updates", fetch_only(append_updates), methods=["POST"]
)


@files_bp.get("/graphs/<graph_id>/thumbnail.png")
@login_required
def thumbnail(graph_id):
    graph_id = accessible_graph(graph_id)[0]["id"]
    row = get_db().execute("SELECT png FROM thumbnails WHERE graph_id = ?", (graph_id,)).fetchone()
    if row is None:
        abort(404)
    cache = "private, max-age=31536000, immutable" if "v" in request.args else "private, no-cache"
    return Response(row["png"], mimetype="image/png", headers={"Cache-Control": cache})


# Image URLs are content hashes, so knowing one already implies having seen the image in a graph you could
# open. Any signed-in user may read them, which keeps images working for everyone a graph is shared with.
@files_bp.get("/images/<sha>")
@login_required
def image(sha):
    if not SHA256_RE.fullmatch(sha):
        abort(404)
    row = get_db().execute("SELECT mime, data FROM images WHERE sha256 = ?", (sha,)).fetchone()
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
