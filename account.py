from flask import Blueprint, g, redirect, render_template, request, url_for

from auth import login_required, safe_next, same_origin
from users import check_handle, suggest_handle, update_profile

account_bp = Blueprint("account", __name__)


def submitted_profile():
    return update_profile(g.user["id"], request.form.get("handle"), request.form.get("display_name"))


@account_bp.get("/welcome")
@login_required(handle=False)
def welcome():
    next_url = safe_next(request.args.get("next"))
    if g.user["handle"]:
        return redirect(next_url or url_for("graphs.library"))
    profile = {"handle": suggest_handle(g.user["email"]) or "", "display_name": g.user["display_name"]}
    return render_template("welcome.html", profile=profile, errors={}, next_url=next_url)


@account_bp.post("/welcome")
@login_required(handle=False)
@same_origin
def finish_welcome():
    next_url = safe_next(request.form.get("next"))
    if g.user["handle"]:
        return redirect(next_url or url_for("graphs.library"))
    profile, errors = submitted_profile()
    if errors:
        return render_template("welcome.html", profile=profile, errors=errors, next_url=next_url), 400
    return redirect(next_url or url_for("graphs.library"))


@account_bp.get("/handles/check")
@login_required(handle=False)
def handle_check():
    handle, error = check_handle(request.args.get("handle"), g.user["id"])
    return {"handle": handle, "available": error is None, "error": error}


@account_bp.get("/settings")
@login_required
def settings():
    profile = {"handle": g.user["handle"], "display_name": g.user["display_name"]}
    return render_template("settings.html", profile=profile, errors={}, saved="saved" in request.args)


@account_bp.post("/settings")
@login_required
@same_origin
def save_settings():
    profile, errors = submitted_profile()
    if errors:
        return render_template("settings.html", profile=profile, errors=errors, saved=False), 400
    return redirect(url_for("account.settings", saved=1))
