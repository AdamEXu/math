import base64
import binascii
import json
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from urllib.parse import urlsplit

import requests

HOST = "www.desmos.com"
ORIGIN = f"https://{HOST}"
HASH_RE = re.compile(r"[a-z0-9]{5,40}")
LINK_HOSTS = {"desmos.com", HOST}
LINK_PATH_RE = re.compile(r"/calculator/([^/]+)/?")
STATE_PATH_PREFIX = "/calc-states/"
SAVE_PATH = "/api/v1/calculator-shared/save"
HASH_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
HASH_LENGTH = 10
MAX_RESPONSE_BYTES = 20 << 20
MAX_THUMBNAIL_BYTES = 2 << 20
PNG_DATA_URL = "data:image/png;base64,"
TIMEOUT = (5, 20)
USER_AGENT = "math.pinewood.club (+https://math.pinewood.club)"

SESSION = requests.Session()


class DesmosError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.message = message
        self.status = status


UNREACHABLE = "Couldn't reach desmos.com. Try again in a minute."
UNEXPECTED = "desmos.com sent back something unexpected. Try again later."


def graph_url(graph_hash):
    return f"{ORIGIN}/calculator/{graph_hash}"


def parse_link(text):
    if not isinstance(text, str):
        return None
    text = text.strip()
    if HASH_RE.fullmatch(text):
        return text
    if "://" not in text:
        text = "https://" + text
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or port is not None or parts.username or parts.password:
        return None
    if (parts.hostname or "") not in LINK_HOSTS:
        return None
    match = LINK_PATH_RE.fullmatch(parts.path)
    if not match or not HASH_RE.fullmatch(match[1]):
        return None
    return match[1]


def pinned(url, path_prefix):
    try:
        parts = urlsplit(url)
        port = parts.port
    except (ValueError, TypeError, AttributeError):
        return False
    return (
        parts.scheme == "https"
        and parts.hostname == HOST
        and port is None
        and not parts.username
        and not parts.password
        and parts.path.startswith(path_prefix)
        and ".." not in parts.path
    )


def _send(method, url, path_prefix, body=None):
    if not pinned(url, path_prefix):
        raise DesmosError(UNEXPECTED)
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if body is not None:
        headers["Content-Type"] = "application/json"
    try:
        with SESSION.request(
            method,
            url,
            headers=headers,
            data=None if body is None else json.dumps(body),
            timeout=TIMEOUT,
            allow_redirects=False,
            stream=True,
        ) as response:
            declared = response.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > MAX_RESPONSE_BYTES:
                raise DesmosError("That Desmos graph is too big to import.", 413)
            chunks = []
            size = 0
            for chunk in response.iter_content(64 << 10):
                size += len(chunk)
                if size > MAX_RESPONSE_BYTES:
                    raise DesmosError("That Desmos graph is too big to import.", 413)
                chunks.append(chunk)
            return response.status_code, b"".join(chunks)
    except requests.RequestException:
        raise DesmosError(UNREACHABLE) from None


def _json(content):
    try:
        return json.loads(content)
    except (ValueError, UnicodeDecodeError):
        raise DesmosError(UNEXPECTED) from None


def fetch_graph(graph_hash):
    if not HASH_RE.fullmatch(graph_hash or ""):
        raise DesmosError("That doesn't look like a Desmos graph link.", 400)
    status, content = _send("GET", graph_url(graph_hash), "/calculator/")
    if status in (401, 403, 404, 410):
        raise DesmosError("That Desmos graph doesn't exist or isn't shared publicly.", 404)
    if status != 200:
        raise DesmosError(UNEXPECTED)
    info = _json(content)
    if not isinstance(info, dict):
        raise DesmosError("That Desmos graph doesn't exist or isn't shared publicly.", 404)
    if info.get("product", "graphing") != "graphing":
        raise DesmosError("Only Desmos graphing calculator graphs can be imported.", 422)
    state = info.get("state")
    if not isinstance(state, dict):
        state_url = info.get("stateUrl")
        if not pinned(state_url, STATE_PATH_PREFIX):
            raise DesmosError(UNEXPECTED)
        status, content = _send("GET", state_url, STATE_PATH_PREFIX)
        if status != 200:
            raise DesmosError(UNEXPECTED)
        state = _json(content)
    if not valid_state(state):
        raise DesmosError("That Desmos graph couldn't be read.", 422)
    title = info.get("title")
    return {"hash": graph_hash, "title": title.strip() if isinstance(title, str) else "", "state": state}


def valid_state(state):
    if not isinstance(state, dict) or isinstance(state.get("version"), bool):
        return False
    if not isinstance(state.get("version"), int):
        return False
    graph = state.get("graph", {})
    expressions = state.get("expressions", {})
    if not isinstance(graph, dict) or not isinstance(expressions, dict):
        return False
    items = expressions.get("list", [])
    ticker = expressions.get("ticker", {})
    return (
        isinstance(items, list)
        and all(isinstance(item, dict) and "id" in item for item in items)
        and isinstance(ticker, dict)
    )


def thumbnail_ok(data_url):
    if not isinstance(data_url, str) or not data_url.startswith(PNG_DATA_URL):
        return False
    try:
        png = base64.b64decode(data_url[len(PNG_DATA_URL) :], validate=True)
    except (binascii.Error, ValueError):
        return False
    return png.startswith(b"\x89PNG\r\n\x1a\n") and len(png) <= MAX_THUMBNAIL_BYTES


def random_hash():
    return "".join(secrets.choice(HASH_ALPHABET) for _ in range(HASH_LENGTH))


def save_body(state, title, thumbnail, graph_hash):
    return {
        "thumbnailData": thumbnail,
        "hash": graph_hash,
        "type": "quick-link",
        "title": title,
        "state": json.dumps(state, separators=(",", ":")),
        "product": "graphing",
        "lang": "en",
    }


def publish(state, title, thumbnail):
    graph_hash = random_hash()
    status, content = _send("POST", ORIGIN + SAVE_PATH, SAVE_PATH, save_body(state, title, thumbnail, graph_hash))
    if status == 429:
        raise DesmosError("desmos.com is busy right now. Try again in a minute.", 503)
    if status != 200:
        raise DesmosError("desmos.com didn't accept the export.")
    saved = _json(content)
    saved_hash = saved.get("hash") if isinstance(saved, dict) else None
    if not isinstance(saved_hash, str) or not HASH_RE.fullmatch(saved_hash):
        raise DesmosError("desmos.com didn't accept the export.")
    return saved_hash


class RateLimiter:
    def __init__(self, limit, window_s):
        self.limit = limit
        self.window_s = window_s
        self._hits = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key):
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > self.window_s:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True

    def reset(self):
        with self._lock:
            self._hits.clear()


import_limiter = RateLimiter(30, 600)
export_limiter = RateLimiter(10, 600)
