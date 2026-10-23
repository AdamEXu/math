import hmac
import os
import secrets
from functools import wraps
from urllib.parse import urlencode

import requests
from flask import Blueprint, redirect, request, session, url_for

ALLOWED_DOMAIN = "pinewood.edu"
GOOGLE_TIMEOUT = (3.05, 15)

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")


def _redirect_uri():
    return f"{os.environ['BASE_URL'].rstrip('/')}/auth/google/callback"


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if "email" not in session:
            return redirect(url_for("login"))
        return view(*args, **kwargs)

    return wrapped


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

    session.clear()
    session.permanent = True
    session["email"] = user["email"]
    session["name"] = user.get("name", user["email"])
    return redirect(url_for("index"))


@auth_bp.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))
