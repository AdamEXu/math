import unicodedata
import uuid

from flask import Blueprint, abort, g, request

from auth import fetch_only, login_required
from db import get_db, now_ms, uuid7, write_transaction

FOLDER_ICONS = (
    "folder", "star", "heart", "book", "flask-conical", "atom", "calculator", "sigma", "pi", "square-function",
    "chart-line", "shapes", "gamepad-2", "music", "palette", "rocket", "globe", "lightbulb", "graduation-cap",
    "pencil", "bookmark", "flag", "zap", "flame", "leaf", "sun", "moon", "cat", "dog", "code",
)
FOLDER_COLORS = {
    "#737373": "Grey",
    "#c74440": "Red",
    "#2d70b3": "Blue",
    "#388c46": "Green",
    "#6042a6": "Purple",
    "#fa7e19": "Orange",
    "#000000": "Black",
}
DEFAULT_ICON = "folder"
DEFAULT_COLOR = "#737373"
MAX_FOLDER_NAME = 60

folders_bp = Blueprint("folders", __name__)


def folder_json(row):
    return {key: row[key] for key in ("id", "name", "icon", "color")}


def user_folders(user_id):
    return get_db().execute(
        "SELECT * FROM folders WHERE owner_id = ? ORDER BY position, created_at", (user_id,)
    ).fetchall()


def owned_folder(folder_id):
    if not isinstance(folder_id, str):
        abort(404)
    try:
        folder_id = str(uuid.UUID(folder_id))
    except ValueError:
        abort(404)
    row = get_db().execute(
        "SELECT * FROM folders WHERE id = ? AND owner_id = ?", (folder_id, g.user["id"])
    ).fetchone()
    if row is None:
        abort(404)
    return row


def place_graph(db, user_id, graph_id, folder_id):
    if folder_id is None:
        db.execute("DELETE FROM graph_placements WHERE user_id = ? AND graph_id = ?", (user_id, graph_id))
    else:
        db.execute(
            "INSERT INTO graph_placements (user_id, graph_id, folder_id) VALUES (?, ?, ?)"
            " ON CONFLICT (user_id, graph_id) DO UPDATE SET folder_id = excluded.folder_id",
            (user_id, graph_id, folder_id),
        )


def folder_name_error(name):
    if not name:
        return "Enter a folder name."
    if len(name) > MAX_FOLDER_NAME:
        return f"Folder names are at most {MAX_FOLDER_NAME} characters."
    if any(unicodedata.category(c) == "Cc" for c in name):
        return "Folder names can't contain control characters."
    return None


def folder_changes(payload, require_name):
    if not isinstance(payload, dict):
        abort(400)
    changes = {}
    if "name" in payload or require_name:
        name = payload.get("name")
        name = name.strip() if isinstance(name, str) else ""
        error = folder_name_error(name)
        if error:
            abort(400, error)
        changes["name"] = name
    if "icon" in payload:
        if payload["icon"] not in FOLDER_ICONS:
            abort(400, "Unknown icon.")
        changes["icon"] = payload["icon"]
    if "color" in payload:
        if payload["color"] not in FOLDER_COLORS:
            abort(400, "Unknown color.")
        changes["color"] = payload["color"]
    return changes


@folders_bp.errorhandler(400)
def bad_request(error):
    return {"error": error.description if isinstance(error.description, str) else "Bad request."}, 400


@folders_bp.post("/folders")
@login_required
@fetch_only
def create():
    changes = folder_changes(request.get_json(silent=True), require_name=True)
    folder_id = uuid7()
    db = get_db()
    with write_transaction(db):
        position = db.execute(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM folders WHERE owner_id = ?", (g.user["id"],)
        ).fetchone()[0]
        db.execute(
            "INSERT INTO folders (id, owner_id, name, icon, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                folder_id, g.user["id"], changes["name"], changes.get("icon", DEFAULT_ICON),
                changes.get("color", DEFAULT_COLOR), position, now_ms(),
            ),
        )
    return folder_json(owned_folder(folder_id)), 201


@folders_bp.post("/folders/<folder_id>")
@login_required
@fetch_only
def update(folder_id):
    folder_id = owned_folder(folder_id)["id"]
    changes = folder_changes(request.get_json(silent=True), require_name=False)
    if changes:
        assignments = ", ".join(f"{column} = ?" for column in changes)
        get_db().execute(f"UPDATE folders SET {assignments} WHERE id = ?", (*changes.values(), folder_id))
    return folder_json(owned_folder(folder_id))


@folders_bp.post("/folders/<folder_id>/delete")
@login_required
@fetch_only
def delete(folder_id):
    folder_id = owned_folder(folder_id)["id"]
    db = get_db()
    with write_transaction(db):
        db.execute("DELETE FROM graph_placements WHERE folder_id = ?", (folder_id,))
        db.execute("UPDATE folders SET parent_id = NULL WHERE parent_id = ?", (folder_id,))
        db.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
    return {"ok": True}
