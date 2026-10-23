import hmac
import os
import secrets
from functools import wraps
from urllib.parse import urlencode, urlsplit

import requests
from flask import Blueprint, abort, current_app, g, redirect, request, session, url_for

from users import EmailInUse, dev_user, get_user, upsert_google_user

ALLOWED_DOMAIN = "pinewood.edu"
GOOGLE_TIMEOUT = (3.05, 15)

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")


def _redirect_uri():
    return f"{os.environ['BASE_URL'].rstrip('/')}/auth/google/callback"


def _base_origin():
    base = urlsplit(os.environ["BASE_URL"])
    return f"{base.scheme}://{base.netloc}"


def safe_next(target):
    return target if target and target.startswith("/") and not target.startswith("//") else None


def login_required(view=None, *, handle=True):
    if view is None:
        return lambda v: login_required(v, handle=handle)

    @wraps(view)
    def wrapped(*args, **kwargs):
        api = bool(request.headers.get("X-Requested-With"))
        user = get_user(session["user_id"]) if "user_id" in session else None
        if user is None:
            session.clear()
            return ({"error": "signed_out"}, 401) if api else redirect(url_for("login"))
        g.user = user
        if handle and not user["handle"]:
            if api:
                return {"error": "handle_required"}, 403
            target = request.full_path.rstrip("?") if request.method == "GET" else None
            return redirect(url_for("account.welcome", next=target))
        return view(*args, **kwargs)

    return wrapped


def sign_in(user):
    session.clear()
    session.permanent = True
    session["user_id"] = user["id"]


def same_origin(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if request.headers.get("Origin") != _base_origin():
            abort(403)
        return view(*args, **kwargs)

    return wrapped


def fetch_only(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if request.headers.get("X-Requested-With") != "fetch":
            abort(403)
        return view(*args, **kwargs)

    return wrapped


def dev_login_email():
    email = os.environ.get("DEV_LOGIN_EMAIL")
    local = urlsplit(os.environ["BASE_URL"]).hostname in ("localhost", "127.0.0.1")
    return email if current_app.debug and local and email else None


@auth_bp.get("/google")
def google():
    state = secrets.token_urlsafe(32)
    session["google_oauth_state"] = state
    params = {
        "client_id": os.environ["GOOGLE_CLIENT_ID"],
        "redirect_uri": _redirect_uri(),
        "response_type": "code",
        "scope": "email profile",
        "hd": ALLOWED_DOMAIN,
        "state": state,
    }
    return redirect("https://accounts.google.com/o/oauth2/auth?" + urlencode(params))


def _fail(error):
    return redirect(url_for("login", error=error))


@auth_bp.get("/google/callback")
def google_callback():
    expected_state = session.pop("google_oauth_state", None)
    if not expected_state or not hmac.compare_digest(request.args.get("state", ""), expected_state):
        return _fail("invalid_state")

    code = request.args.get("code")
    if not code:
        return _fail("no_code")

    try:
        token = requests.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": os.environ["GOOGLE_CLIENT_ID"],
                "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": _redirect_uri(),
            },
            timeout=GOOGLE_TIMEOUT,
        ).json()
        if "access_token" not in token:
            return _fail("token_failed")

        user = requests.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {token['access_token']}"},
            timeout=GOOGLE_TIMEOUT,
        ).json()
    except (requests.RequestException, ValueError):
        return _fail("google_unreachable")

    # The hd URL param only filters Google's account picker; the hd claim is what proves the domain.
    if user.get("hd") != ALLOWED_DOMAIN or not user.get("verified_email"):
        return _fail("invalid_domain")

    try:
        sign_in(upsert_google_user(user["id"], user["email"], user.get("name") or user["email"]))
    except EmailInUse:
        return _fail("email_in_use")
    return redirect(url_for("graphs.library"))


@auth_bp.post("/dev-login")
@same_origin
def dev_login():
    email = dev_login_email()
    if not email:
        abort(404)
    sign_in(dev_user(email))
    return redirect(url_for("graphs.library"))


@auth_bp.post("/logout")
@same_origin
def logout():
    session.clear()
    return redirect(url_for("login"))
