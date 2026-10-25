import os
from functools import wraps
from pathlib import Path

from flask import Blueprint, Response, current_app, g, redirect, request, send_from_directory

from auth import login_required, safe_next

SERVER_PREFIXES = {"api", "auth", "static", "assets", "desmos", "images", "graphs", "health", "login", "ws"}
NOT_BUILT = "Frontend not built. Run `pnpm build` in frontend/, or use the Vite dev server."

spa_bp = Blueprint("spa", __name__)


def dist_dir():
    return Path(current_app.config["FRONTEND_DIST"])


def index_html(status=200):
    index = dist_dir() / "index.html"
    if not index.is_file():
        return Response(NOT_BUILT, 503, mimetype="text/plain", headers={"Cache-Control": "no-cache"})
    return Response(index.read_bytes(), status, mimetype="text/html", headers={"Cache-Control": "no-cache"})


def dev_frontend_redirect(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        frontend = os.environ.get("FRONTEND_URL")
        if frontend:
            return redirect(frontend.rstrip("/") + request.full_path.rstrip("?"))
        return view(*args, **kwargs)

    return wrapped


@spa_bp.get("/")
@spa_bp.get("/folders/<folder_id>")
@spa_bp.get("/shared")
@spa_bp.get("/calculator/<graph_id>")
@spa_bp.get("/settings")
@spa_bp.get("/profile/<handle>")
@dev_frontend_redirect
@login_required
def page(**_):
    return index_html()


@spa_bp.get("/welcome")
@dev_frontend_redirect
@login_required(handle=False)
def welcome():
    if g.user["handle"]:
        return redirect(safe_next(request.args.get("next")) or "/")
    return index_html()


@spa_bp.get("/assets/<path:filename>")
def asset(filename):
    response = send_from_directory(dist_dir() / "assets", filename)
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


def is_spa_path(path):
    return path.split("/")[1] not in SERVER_PREFIXES


@dev_frontend_redirect
@login_required
def not_found_page():
    return index_html(404)
