from flask import Blueprint, abort, jsonify, request
from werkzeug.exceptions import MethodNotAllowed

from account import account_bp
from folders import folders_bp
from graphs import graphs_bp

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

api_bp = Blueprint("api", __name__, url_prefix="/api")
api_bp.register_blueprint(account_bp)
api_bp.register_blueprint(graphs_bp)
api_bp.register_blueprint(folders_bp)


@api_bp.before_request
def require_fetch_header():
    if request.method not in SAFE_METHODS and request.headers.get("X-Requested-With") != "fetch":
        abort(403)


def is_api_path(path):
    return path == "/api" or path.startswith("/api/")


def api_error(error):
    if error.code == 400:
        message = error.description if error.description != type(error).description else "Bad request."
    else:
        message = error.name.lower().replace(" ", "_")
    response = jsonify(error=message)
    response.status_code = error.code
    if isinstance(error, MethodNotAllowed) and error.valid_methods:
        response.headers["Allow"] = ", ".join(error.valid_methods)
    return response
