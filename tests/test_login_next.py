from urllib.parse import parse_qs, urlsplit

import pytest

from auth import safe_next

ORIGIN = "http://localhost:5050"


def test_signed_out_page_redirects_to_login_with_next(app):
    res = app.test_client().get("/calculator/abc?x=1")
    assert res.status_code == 302
    parts = urlsplit(res.headers["Location"])
    assert parts.path == "/login"
    assert parse_qs(parts.query)["next"] == ["/calculator/abc?x=1"]


def test_root_redirects_to_plain_login(app):
    assert app.test_client().get("/").headers["Location"] == "/login"


def test_login_page_threads_next_into_google_link(app):
    html = app.test_client().get("/login?next=/calculator/abc").get_data(as_text=True)
    assert "/auth/google?next=/calculator/abc" in html


def test_google_start_stores_only_safe_next(app, monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "id")
    client = app.test_client()
    client.get("/auth/google?next=/calculator/abc")
    with client.session_transaction() as sess:
        assert sess["login_next"] == "/calculator/abc"
    client.get("/auth/google?next=https://evil.example")
    with client.session_transaction() as sess:
        assert sess["login_next"] is None


@pytest.mark.parametrize(
    "target",
    ["https://evil.example", "//evil.example", "/\\evil.example", "/ok\nLocation: x", "", None, "relative"],
)
def test_safe_next_rejects_offsite(target):
    assert safe_next(target) is None


def test_safe_next_accepts_local_paths():
    assert safe_next("/calculator/abc?x=1") == "/calculator/abc?x=1"


def test_signed_in_login_follows_next(alice):
    assert alice.get("/login?next=/calculator/abc").headers["Location"] == "/calculator/abc"
