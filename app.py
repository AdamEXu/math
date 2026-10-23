import os
from datetime import timedelta
from pathlib import Path

from flask import Flask, redirect, render_template, request, session
from werkzeug.exceptions import HTTPException

from api import api_bp, api_error, is_api_path
from auth import auth_bp, dev_login_email, safe_next
from db import close_db
from graphs import MAX_IMAGE_BYTES, files_bp
from spa import is_spa_path, not_found_page, spa_bp

app = Flask(__name__)
app.secret_key = os.environ["SECRET_KEY"]
app.config.update(
    SESSION_COOKIE_SECURE=os.environ["BASE_URL"].startswith("https://"),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    DATA_DIR=os.environ.get("DATA_DIR", Path(__file__).parent / "data"),
    FRONTEND_DIST=Path(__file__).parent / "frontend" / "dist",
    MAX_CONTENT_LENGTH=MAX_IMAGE_BYTES + (1 << 20),
)
app.register_blueprint(auth_bp)
app.register_blueprint(api_bp)
app.register_blueprint(files_bp)
app.register_blueprint(spa_bp)
app.teardown_appcontext(close_db)

LOGIN_ERRORS = {
    "invalid_domain": "Sign in with your pinewood.edu account.",
    "email_in_use": "That email is linked to a different account. Ask an admin for help.",
}


@app.errorhandler(HTTPException)
def http_error(error):
    if is_api_path(request.path):
        return api_error(error)
    if error.code == 404 and request.method in ("GET", "HEAD") and is_spa_path(request.path):
        return not_found_page()
    return error


@app.get("/login")
def login():
    target = safe_next(request.args.get("next"))
    if "user_id" in session:
        return redirect(target or "/")
    error = request.args.get("error")
    message = LOGIN_ERRORS.get(error, "Sign-in failed, try again.") if error else None
    return render_template("login.html", error=message, dev_email=dev_login_email(), next=target)


@app.get("/health")
def health():
    return {"status": "ok"}
