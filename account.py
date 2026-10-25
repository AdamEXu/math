import os

from flask import Blueprint, abort, g, request

from auth import login_required
from desmos_bundle import script_urls
from users import avatar_hue, avatar_initial, avatar_url, check_handle, get_user, suggest_handle, update_profile

account_bp = Blueprint("account", __name__)


def me_json(user):
    return {
        "id": user["id"],
        "email": user["email"],
        "handle": user["handle"] or None,
        "display_name": user["display_name"],
        "avatar_url": avatar_url(user),
        "avatar_hue": avatar_hue(user),
        "avatar_initial": avatar_initial(user),
        "suggested_handle": None if user["handle"] else suggest_handle(user["email"]),
    }


def text_field(payload, key):
    value = payload.get(key)
    return value if isinstance(value, str) else None


@account_bp.get("/me")
@login_required(handle=False)
def me():
    return me_json(g.user)


@account_bp.put("/me")
@login_required(handle=False)
def update_me():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        abort(400)
    profile, errors = update_profile(g.user["id"], text_field(payload, "handle"), text_field(payload, "display_name"))
    if errors:
        return {"error": "invalid", "errors": errors, "profile": profile}, 400
    return me_json(get_user(g.user["id"]))


@account_bp.get("/handles/check")
@login_required(handle=False)
def handle_check():
    handle, error = check_handle(request.args.get("handle"), g.user["id"])
    return {"handle": handle, "available": error is None, "error": error}


@account_bp.get("/config")
@login_required(handle=False)
def config():
    return {"desmos_scripts": script_urls(os.environ["DESMOS_API_KEY"])}
