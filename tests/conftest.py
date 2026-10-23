import os

os.environ.setdefault("SECRET_KEY", "test")
os.environ.setdefault("BASE_URL", "http://localhost:5050")
os.environ.setdefault("DESMOS_API_KEY", "test")

import pytest

from app import app as flask_app
from users import dev_user, update_profile

ORIGIN = "http://localhost:5050"
FETCH = {"X-Requested-With": "fetch"}


@pytest.fixture
def app(tmp_path):
    flask_app.config.update(TESTING=True, DATA_DIR=tmp_path)
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


@pytest.fixture
def alice(app):
    return signed_in(app, "alice@pinewood.edu", "alice")


@pytest.fixture
def bob(app):
    return signed_in(app, "bob@pinewood.edu", "bob")


@pytest.fixture
def graph_id(alice):
    res = alice.post("/graphs", headers={"Origin": ORIGIN})
    assert res.status_code == 302
    return res.headers["Location"].rsplit("/", 1)[1]
