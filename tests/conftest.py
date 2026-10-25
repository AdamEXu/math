import os

os.environ.setdefault("SECRET_KEY", "test")
os.environ.setdefault("BASE_URL", "http://localhost:5050")
os.environ.setdefault("DESMOS_API_KEY", "test")
os.environ["DESMOS_SELF_HOST"] = "0"

import pytest

from app import app as flask_app
from users import dev_user, update_profile

ORIGIN = "http://localhost:5050"
FETCH = {"X-Requested-With": "fetch"}
INDEX_HTML = "<!doctype html><title>math</title><div id=root></div>"
ASSET = "assets/index-abc123.js"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.delenv("FRONTEND_URL", raising=False)
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(INDEX_HTML)
    (dist / ASSET).write_text("console.log('math')")
    flask_app.config.update(TESTING=True, DATA_DIR=tmp_path / "data", FRONTEND_DIST=dist)
    yield flask_app


def make_user(app, email, handle=None):
    with app.app_context():
        user = dev_user(email)
        if handle:
            assert update_profile(user["id"], handle, user["display_name"])[1] == {}
        return user["id"]


def signed_in(app, email, handle=None):
    user_id = make_user(app, email, handle)
    client = app.test_client()
    with client.session_transaction() as sess:
        sess["user_id"] = user_id
    client.user_id = user_id
    return client


def new_graph(client, folder_id=None):
    payload = {"folder_id": folder_id} if folder_id else None
    res = client.post("/api/graphs", json=payload, headers=FETCH) if payload else client.post("/api/graphs", headers=FETCH)
    assert res.status_code == 201, res.get_json()
    return res.get_json()["id"]


@pytest.fixture
def alice(app):
    return signed_in(app, "alice@pinewood.edu", "alice")


@pytest.fixture
def bob(app):
    return signed_in(app, "bob@pinewood.edu", "bob")


@pytest.fixture
def graph_id(alice):
    return new_graph(alice)
