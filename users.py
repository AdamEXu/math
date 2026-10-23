import hashlib
import re
import sqlite3
import unicodedata
from urllib.parse import urlsplit

from db import get_db, now_ms, uuid7

HANDLE_RE = re.compile(r"[a-z][a-z0-9_]{2,19}")
RESERVED_HANDLES = {
    "admin", "api", "auth", "login", "logout", "settings", "calculator", "graphs", "images", "health",
    "static", "math", "desmos", "root", "support", "help", "me", "new",
}
DEV_SUB_PREFIX = "dev:"
MAX_DISPLAY_NAME = 50


class EmailInUse(Exception):
    pass


def normalize_handle(raw):
    return (raw or "").strip().removeprefix("@").lower()


def handle_error(handle):
    if not 3 <= len(handle) <= 20:
        return "Handles are 3 to 20 characters."
    if not handle[0].isalpha() or not handle[0].isascii():
        return "Handles start with a letter."
    if not HANDLE_RE.fullmatch(handle):
        return "Use only letters, numbers and underscores."
    if handle in RESERVED_HANDLES:
        return "That handle is reserved."
    return None


def normalize_display_name(raw):
    return (raw or "").strip()


def display_name_error(name):
    if not name:
        return "Enter a display name."
    if len(name) > MAX_DISPLAY_NAME:
        return f"Display names are at most {MAX_DISPLAY_NAME} characters."
    if any(unicodedata.category(c) == "Cc" for c in name):
        return "Display names can't contain control characters."
    return None


def get_user(user_id):
    return get_db().execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def find_user(handle_or_email):
    value = (handle_or_email or "").strip()
    if "@" in value.lstrip("@"):
        return get_db().execute("SELECT * FROM users WHERE email = ?", (value,)).fetchone()
    return get_db().execute("SELECT * FROM users WHERE handle = ?", (normalize_handle(value),)).fetchone()


def handle_taken(handle, user_id=None):
    row = get_db().execute("SELECT id FROM users WHERE handle = ?", (handle,)).fetchone()
    return row is not None and row["id"] != user_id


def check_handle(raw, user_id=None):
    handle = normalize_handle(raw)
    error = handle_error(handle)
    if error is None and handle_taken(handle, user_id):
        error = "That handle is taken."
    return handle, error


def update_profile(user_id, raw_handle, raw_display_name):
    handle, handle_problem = check_handle(raw_handle, user_id)
    display_name = normalize_display_name(raw_display_name)
    errors = {"handle": handle_problem, "display_name": display_name_error(display_name)}
    if not any(errors.values()):
        try:
            get_db().execute(
                "UPDATE users SET handle = ?, display_name = ? WHERE id = ?", (handle, display_name, user_id)
            )
        except sqlite3.IntegrityError:
            errors["handle"] = "That handle is taken."
    return {"handle": handle, "display_name": display_name}, {k: v for k, v in errors.items() if v}


def suggest_handle(email):
    local = re.sub(r"[^a-z0-9_]", "_", email.split("@")[0].lower())
    local = re.sub(r"^[^a-z]+", "", local)[:20].rstrip("_")
    handle, error = check_handle(local)
    return None if error else handle


def _insert_user(google_sub, email, google_name):
    user_id = uuid7()
    display_name = normalize_display_name(google_name)[:MAX_DISPLAY_NAME] or email.split("@")[0]
    get_db().execute(
        "INSERT INTO users (id, google_sub, email, display_name, google_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (user_id, google_sub, email, display_name, google_name, now_ms()),
    )
    return get_user(user_id)


def upsert_google_user(google_sub, email, google_name):
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE google_sub = ?", (google_sub,)).fetchone()
    other = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if user is None and other is not None and other["google_sub"].startswith(DEV_SUB_PREFIX):
        db.execute(
            "UPDATE users SET google_sub = ?, google_name = ? WHERE id = ?", (google_sub, google_name, other["id"])
        )
        return get_user(other["id"])
    if other is not None and (user is None or other["id"] != user["id"]):
        raise EmailInUse(email)
    if user is None:
        return _insert_user(google_sub, email, google_name)
    if (user["email"], user["google_name"]) != (email, google_name):
        db.execute("UPDATE users SET email = ?, google_name = ? WHERE id = ?", (email, google_name, user["id"]))
    return get_user(user["id"])


def dev_user(email):
    user = get_db().execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if user is not None:
        return user
    name = " ".join(part.capitalize() for part in re.split(r"[._]", email.split("@")[0]) if part)
    return _insert_user(DEV_SUB_PREFIX + email, email, name)


def set_google_picture(user_id, url):
    url = url if url and urlsplit(url).scheme == "https" else None
    get_db().execute("UPDATE users SET google_picture_url = ? WHERE id = ?", (url, user_id))


def avatar_url(user):
    return user["google_picture_url"]


def avatar_initial(user):
    return (user["display_name"].strip()[:1] or "?").upper()


def avatar_hue(user):
    return int(hashlib.sha256(user["id"].encode()).hexdigest(), 16) % 360


def public_user_json(user):
    return {
        "id": user["id"],
        "handle": user["handle"] or None,
        "display_name": user["display_name"],
        "avatar_url": avatar_url(user),
        "avatar_hue": avatar_hue(user),
        "avatar_initial": avatar_initial(user),
    }


def search_users(query, exclude_id, limit=8):
    value = (query or "").strip()
    if "@" in value.lstrip("@"):
        row = get_db().execute("SELECT * FROM users WHERE email = ? AND id != ?", (value, exclude_id)).fetchone()
        return [row] if row else []
    prefix = normalize_handle(value)
    if not prefix:
        return []
    pattern = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    return get_db().execute(
        "SELECT * FROM users WHERE id != :me AND handle IS NOT NULL AND ("
        " handle LIKE :p ESCAPE '\\' OR display_name LIKE :p ESCAPE '\\'"
        " OR display_name LIKE '% ' || :p ESCAPE '\\' OR email LIKE :p ESCAPE '\\')"
        " ORDER BY handle LIKE :p ESCAPE '\\' DESC, display_name COLLATE NOCASE LIMIT :limit",
        {"me": exclude_id, "p": pattern, "limit": limit},
    ).fetchall()
