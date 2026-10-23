import os
from datetime import timedelta
from pathlib import Path

from flask import Flask, g, redirect, render_template, request, session, url_for

from account import account_bp
from auth import auth_bp, dev_login_email
from db import close_db
from folders import folders_bp
from graphs import MAX_IMAGE_BYTES, graphs_bp
from users import avatar_hue, avatar_initial, avatar_url

app = Flask(__name__)
app.secret_key = os.environ["SECRET_KEY"]
app.config.update(
    SESSION_COOKIE_SECURE=os.environ["BASE_URL"].startswith("https://"),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    DATA_DIR=os.environ.get("DATA_DIR", Path(__file__).parent / "data"),
    MAX_CONTENT_LENGTH=MAX_IMAGE_BYTES + (1 << 20),
)
app.register_blueprint(auth_bp)
app.register_blueprint(graphs_bp)
app.register_blueprint(account_bp)
app.register_blueprint(folders_bp)
app.teardown_appcontext(close_db)

LOGIN_ERRORS = {
    "invalid_domain": "Sign in with your pinewood.edu account.",
    "email_in_use": "That email is linked to a different account. Ask an admin for help.",
}


@app.context_processor
def current_user():
    return {
        "current_user": g.get("user"),
        "avatar_url": avatar_url,
        "avatar_initial": avatar_initial,
        "avatar_hue": avatar_hue,
    }


@app.get("/login")
def login():
    if "user_id" in session:
        return redirect(url_for("graphs.library"))
    error = request.args.get("error")
    message = LOGIN_ERRORS.get(error, "Sign-in failed, try again.") if error else None
    return render_template("login.html", error=message, dev_email=dev_login_email())


@app.get("/health")
def health():
    return {"status": "ok"}
