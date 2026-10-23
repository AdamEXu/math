import hmac
import os
import secrets
from functools import wraps
from urllib.parse import urlencode, urlsplit

import requests
from flask import Blueprint, abort, current_app, g, redirect, request, session, url_for

from users import EmailInUse, dev_user, get_user, set_google_picture, upsert_google_user

ALLOWED_DOMAIN = "pinewood.edu"
GOOGLE_TIMEOUT = (3.05, 15)

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")


def _redirect_uri():
    return f"{os.environ['BASE_URL'].rstrip('/')}/auth/google/callback"


def _origin(url):
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def allowed_origins():
    origins = {_origin(os.environ["BASE_URL"])}
    if os.environ.get("FRONTEND_URL"):
        origins.add(_origin(os.environ["FRONTEND_URL"]))
    return origins


def safe_next(target):
    if not target or not target.startswith("/") or target.startswith("//") or "\\" in target:
        return None
    return None if any(ord(c) < 32 for c in target) else target


def login_url(target=None):
    target = safe_next(target)
    return url_for("login", next=target) if target and target != "/" else url_for("login")


def login_required(view=None, *, handle=True):
    if view is None:
        return lambda v: login_required(v, handle=handle)

    @wraps(view)
    def wrapped(*args, **kwargs):
        api = request.path.startswith("/api/") or bool(request.headers.get("X-Requested-With"))
        user = get_user(session["user_id"]) if "user_id" in session else None
        if user is None:
            session.clear()
            if api:
                return {"error": "signed_out"}, 401
            return redirect(login_url(request.full_path.rstrip("?") if request.method == "GET" else None))
        g.user = user
        if handle and not user["handle"]:
            if api:
                return {"error": "handle_required"}, 403
            target = request.full_path.rstrip("?") if request.method == "GET" else None
            return redirect(url_for("spa.welcome", next=target))
        return view(*args, **kwargs)

    return wrapped


def sign_in(user):
    session.clear()
    session.permanent = True
    session["user_id"] = user["id"]


def same_origin(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if request.headers.get("Origin") not in allowed_origins():
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
    session["login_next"] = safe_next(request.args.get("next"))
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
    return redirect(url_for("login", error=error, next=safe_next(session.pop("login_next", None))))


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
        account = upsert_google_user(user["id"], user["email"], user.get("name") or user["email"])
    except EmailInUse:
        return _fail("email_in_use")
    set_google_picture(account["id"], user.get("picture"))
    target = safe_next(session.pop("login_next", None))
    sign_in(account)
    return redirect(target or "/")


@auth_bp.post("/dev-login")
@same_origin
def dev_login():
    email = dev_login_email()
    if not email:
        abort(404)
    chosen = (request.form.get("email") or request.args.get("email") or "").strip().lower()
    if chosen:
        local, _, domain = chosen.partition("@")
        if domain != ALLOWED_DOMAIN or not local:
            abort(400)
        email = chosen
    sign_in(dev_user(email))
    return redirect(safe_next(request.args.get("next")) or "/")


@auth_bp.post("/logout")
@same_origin
def logout():
    session.clear()
    return redirect(url_for("login"))
