from urllib.parse import quote
import pytest

from tests.conftest import ASSET, INDEX_HTML, ORIGIN, signed_in

GRAPH = "01a16761-f65e-7694-94d9-6244099f81d1"
APP_PATHS = ["/", f"/folders/{GRAPH}", "/shared", f"/calculator/{GRAPH}", "/settings", "/profile/alice"]
UNKNOWN_PATHS = ["/nope", "/folders", "/calculator", "/a/b/c"]
SERVER_PATHS = ["/static/nope.css", "/assets/nope.js", "/graphs/x", "/images/xyz", "/auth/nope", "/login/x", "/health/x"]


def assert_index(res, status=200):
    assert res.status_code == status
    assert res.get_data(as_text=True) == INDEX_HTML
    assert res.mimetype == "text/html" and res.headers["Cache-Control"] == "no-cache"


@pytest.mark.parametrize("path", APP_PATHS)
def test_app_routes_serve_index(alice, path):
    assert_index(alice.get(path))


def test_app_routes_do_not_check_ownership(alice, bob):
    folder = alice.post("/api/folders", json={"name": "Mine"}, headers={"X-Requested-With": "fetch"}).get_json()
    assert_index(bob.get(f"/folders/{folder['id']}"))
    assert_index(bob.get("/calculator/not-a-uuid"))


@pytest.mark.parametrize("path", APP_PATHS + ["/welcome"] + UNKNOWN_PATHS)
def test_signed_out_redirects_to_login(app, path):
    res = app.test_client().get(path)
    assert res.status_code == 302 and res.headers["Location"] == ("/login" if path == "/" else "/login?next=" + quote(path, safe="/"))


@pytest.mark.parametrize("path", APP_PATHS + UNKNOWN_PATHS)
def test_missing_handle_redirects_to_welcome_with_next(app, path):
    client = signed_in(app, "carol@pinewood.edu")
    res = client.get(path)
    assert res.status_code == 302 and res.headers["Location"] == f"/welcome?next={path}"


def test_welcome_serves_index_without_handle(app):
    client = signed_in(app, "carol@pinewood.edu")
    assert_index(client.get("/welcome?next=/settings"))


def test_welcome_with_handle_redirects(alice):
    assert alice.get("/welcome?next=/calculator/x").headers["Location"] == "/calculator/x"
    assert alice.get("/welcome").headers["Location"] == "/"
    assert alice.get("/welcome?next=//evil.example").headers["Location"] == "/"


@pytest.mark.parametrize("path", UNKNOWN_PATHS)
def test_unknown_path_serves_index_with_404(alice, path):
    assert_index(alice.get(path), 404)


@pytest.mark.parametrize("path", SERVER_PATHS)
def test_server_prefixes_never_fall_back_to_index(alice, path):
    res = alice.get(path)
    assert res.status_code == 404 and res.get_data(as_text=True) != INDEX_HTML


def test_post_to_page_route_is_not_the_app(alice):
    assert alice.post("/").status_code == 405
    assert alice.post("/nope").status_code == 404


def test_missing_dist_returns_503(app, alice, tmp_path):
    app.config["FRONTEND_DIST"] = tmp_path / "missing"
    for path in ("/", "/nope"):
        res = alice.get(path)
        assert res.status_code == 503 and res.mimetype == "text/plain"
        assert "Frontend not built" in res.get_data(as_text=True)


def test_assets_are_immutable(app):
    res = app.test_client().get("/" + ASSET)
    assert res.status_code == 200 and res.get_data(as_text=True) == "console.log('math')"
    assert res.headers["Cache-Control"] == "public, max-age=31536000, immutable"
    assert app.test_client().get("/assets/../index.html").status_code == 404


def test_static_files_still_served(app):
    assert app.test_client().get("/static/lucide/icons.json").status_code == 200


def test_login_page_redirects_when_signed_in(app, alice):
    assert alice.get("/login").headers["Location"] == "/"
    assert "Sign in with Google" in app.test_client().get("/login").get_data(as_text=True)


@pytest.mark.parametrize(
    "path", ["/", f"/calculator/{GRAPH}?x=1", "/welcome?next=/settings", "/nope", "/settings"]
)
def test_frontend_url_redirects_pages(app, monkeypatch, path):
    monkeypatch.setenv("FRONTEND_URL", "http://localhost:5173/")
    res = app.test_client().get(path)
    assert res.status_code == 302 and res.headers["Location"] == "http://localhost:5173" + path


def test_frontend_url_leaves_server_routes_alone(app, alice, monkeypatch):
    monkeypatch.setenv("FRONTEND_URL", "http://localhost:5173")
    assert alice.get("/api/me").status_code == 200
    assert alice.get("/health").status_code == 200
    assert app.test_client().get("/login").status_code == 200
    assert app.test_client().get("/" + ASSET).status_code == 200


def test_frontend_url_origin_is_accepted(app, monkeypatch):
    monkeypatch.setenv("DEV_LOGIN_EMAIL", "dev@pinewood.edu")
    monkeypatch.setenv("FRONTEND_URL", "http://localhost:5173")
    client = app.test_client()
    app.debug = True
    try:
        assert client.post("/auth/dev-login", headers={"Origin": "http://localhost:5174"}).status_code == 403
        assert client.post("/auth/dev-login", headers={"Origin": "http://localhost:5173"}).status_code == 302
        assert client.post("/auth/logout", headers={"Origin": "https://evil.example"}).status_code == 403
        assert client.post("/auth/logout", headers={"Origin": "http://localhost:5173"}).status_code == 302
    finally:
        app.debug = False


def test_frontend_origin_rejected_when_unset(app, alice):
    assert alice.post("/auth/logout", headers={"Origin": "http://localhost:5173"}).status_code == 403
    assert alice.post("/auth/logout", headers={"Origin": ORIGIN}).status_code == 302
