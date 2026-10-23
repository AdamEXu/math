import os

os.environ.setdefault("SECRET_KEY", "test")
os.environ.setdefault("BASE_URL", "http://localhost:5050")
os.environ.setdefault("DESMOS_API_KEY", "test")

import pytest

from app import app as flask_app

ORIGIN = "http://localhost:5050"
FETCH = {"X-Requested-With": "fetch"}


@pytest.fixture
def app(tmp_path):
    flask_app.config.update(TESTING=True, DATA_DIR=tmp_path)
    yield flask_app


def signed_in(app, email):
    client = app.test_client()
    with client.session_transaction() as sess:
        sess["email"] = email
        sess["name"] = email
    return client


@pytest.fixture
def alice(app):
    return signed_in(app, "alice@pinewood.edu")


@pytest.fixture
def bob(app):
    return signed_in(app, "bob@pinewood.edu")


@pytest.fixture
def graph_id(alice):
    res = alice.post("/graphs", headers={"Origin": ORIGIN})
    assert res.status_code == 302
    return res.headers["Location"].rsplit("/", 1)[1]
