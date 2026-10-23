import os
from datetime import timedelta

from flask import Flask, redirect, render_template, request, session, url_for

from auth import auth_bp, login_required

app = Flask(__name__)
app.secret_key = os.environ["SECRET_KEY"]
app.config.update(
    SESSION_COOKIE_SECURE=os.environ["BASE_URL"].startswith("https://"),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)
app.register_blueprint(auth_bp)

LOGIN_ERRORS = {
    "invalid_domain": "Sign in with your pinewood.edu account.",
}


@app.get("/")
@login_required
def index():
    return render_template("index.html", api_key=os.environ["DESMOS_API_KEY"])


@app.get("/login")
def login():
    if "email" in session:
        return redirect(url_for("index"))
    error = request.args.get("error")
    message = LOGIN_ERRORS.get(error, "Sign-in failed, try again.") if error else None
    return render_template("login.html", error=message)


@app.get("/health")
def health():
    return {"status": "ok"}
