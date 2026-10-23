from flask import Blueprint, abort, g, request

import realtime
from access import LINK_ROLES
from auth import ALLOWED_DOMAIN, login_required
from db import get_db, now_ms, write_transaction
from graphs import accessible_graph, owner_json
from users import find_user, public_user_json, search_users

MEMBER_ROLES = ("editor", "viewer")

sharing_bp = Blueprint("sharing", __name__)


def sharing_json(graph_id):
    row, role = accessible_graph(graph_id)
    members = get_db().execute(
        "SELECT users.*, graph_members.role FROM graph_members JOIN users ON users.id = graph_members.user_id"
        " WHERE graph_members.graph_id = ? ORDER BY graph_members.added_at, users.id",
        (row["id"],),
    ).fetchall()
    return {
        "role": role,
        "link_access": row["link_access"],
        "owner": owner_json(row),
        "members": [{**public_user_json(member), "role": member["role"]} for member in members],
    }


def payload_role(payload, allowed):
    role = payload.get("role") if isinstance(payload, dict) else None
    if role not in allowed:
        abort(400, "Choose a role.")
    return role


def remove_member(db, graph_id, user_id):
    db.execute("DELETE FROM graph_members WHERE graph_id = ? AND user_id = ?", (graph_id, user_id))
    db.execute("DELETE FROM graph_link_visits WHERE graph_id = ? AND user_id = ?", (graph_id, user_id))
    db.execute("DELETE FROM graph_placements WHERE graph_id = ? AND user_id = ?", (graph_id, user_id))


@sharing_bp.get("/graphs/<graph_id>/sharing")
@login_required
def show(graph_id):
    return sharing_json(graph_id)


@sharing_bp.post("/graphs/<graph_id>/members")
@login_required
def add(graph_id):
    row, _ = accessible_graph(graph_id, "owner")
    payload = request.get_json(silent=True)
    role = payload_role(payload, MEMBER_ROLES)
    query = payload.get("user")
    query = query.strip() if isinstance(query, str) else ""
    if "@" in query.lstrip("@") and not query.lower().endswith("@" + ALLOWED_DOMAIN):
        abort(400, f"Only {ALLOWED_DOMAIN} accounts can be added.")
    user = find_user(query) if query else None
    if user is None:
        abort(400, "No one with that handle or email has signed in yet.")
    if user["id"] == row["owner_id"]:
        abort(400, "You already own this graph.")
    db = get_db()
    with write_transaction(db):
        db.execute(
            "INSERT INTO graph_members (graph_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT (graph_id, user_id) DO UPDATE SET role = excluded.role",
            (row["id"], user["id"], role, g.user["id"], now_ms()),
        )
    realtime.reauthorize(row["id"])
    return sharing_json(row["id"])


@sharing_bp.patch("/graphs/<graph_id>/members/<user_id>")
@login_required
def change_role(graph_id, user_id):
    row, _ = accessible_graph(graph_id, "owner")
    role = payload_role(request.get_json(silent=True), MEMBER_ROLES)
    db = get_db()
    with write_transaction(db):
        changed = db.execute(
            "UPDATE graph_members SET role = ? WHERE graph_id = ? AND user_id = ?", (role, row["id"], user_id)
        ).rowcount
    if not changed:
        abort(404)
    realtime.reauthorize(row["id"])
    return sharing_json(row["id"])


@sharing_bp.delete("/graphs/<graph_id>/members/<user_id>")
@login_required
def remove(graph_id, user_id):
    leaving = user_id == g.user["id"]
    row, role = accessible_graph(graph_id, "viewer" if leaving else "owner")
    if leaving and role == "owner":
        abort(400, "Owners can't leave their own graph.")
    db = get_db()
    with write_transaction(db):
        remove_member(db, row["id"], user_id)
    realtime.reauthorize(row["id"])
    return {"ok": True} if leaving else sharing_json(row["id"])


@sharing_bp.put("/graphs/<graph_id>/link")
@login_required
def set_link(graph_id):
    row, _ = accessible_graph(graph_id, "owner")
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or "access" not in payload:
        abort(400)
    access = payload["access"]
    if access is not None and access not in LINK_ROLES:
        abort(400, "Choose who can open the link.")
    db = get_db()
    with write_transaction(db):
        db.execute("UPDATE graphs SET link_access = ? WHERE id = ?", (access, row["id"]))
    realtime.reauthorize(row["id"])
    return sharing_json(row["id"])


@sharing_bp.get("/users/search")
@login_required
def user_search():
    query = request.args.get("q", "")
    if len(query) > 100:
        return {"users": []}
    return {"users": [public_user_json(user) for user in search_users(query, g.user["id"])]}

