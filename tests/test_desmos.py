import base64
import json

import pytest
import requests
from pycrdt import Array, Doc, Map, Text

import desmos_com
from tests.conftest import FETCH, new_graph
from tests.test_folders import make_folder

HASH = "zukjgk9iry"
STATE = {
    "version": 11,
    "randomSeed": "seed",
    "graph": {"viewport": {"xmin": -10, "ymin": -10, "xmax": 10, "ymax": 10}},
    "expressions": {
        "list": [
            {"type": "expression", "id": "1", "latex": "y=x^2", "slider": {"min": "0"}},
            {"type": "table", "id": "2", "columns": [{"id": "3", "latex": "x_1", "values": ["1", ""]}]},
        ],
        "ticker": {"handlerLatex": "a\\to a+1", "open": True},
    },
}
PNG_URL = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16).decode()


class FakeResponse:
    def __init__(self, status=200, body=b"", headers=None):
        self.status_code = status
        self.body = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def iter_content(self, size):
        for start in range(0, len(self.body), size):
            yield self.body[start : start + size]


class FakeSession:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})
        route = self.routes.get((method, url))
        if route is None:
            raise AssertionError(f"unexpected request {method} {url}")
        if isinstance(route, Exception):
            raise route
        return route


@pytest.fixture
def desmos(monkeypatch):
    desmos_com.import_limiter.reset()
    desmos_com.export_limiter.reset()

    def install(routes):
        session = FakeSession(routes)
        monkeypatch.setattr(desmos_com, "SESSION", session)
        return session

    return install


def info(graph_hash=HASH, **extra):
    return {
        "hash": graph_hash,
        "title": "Parabolas",
        "stateUrl": f"https://www.desmos.com/calc-states/production/{graph_hash}",
        "product": "graphing",
        **extra,
    }


def graph_routes(graph_hash=HASH, **extra):
    return {
        ("GET", f"https://www.desmos.com/calculator/{graph_hash}"): FakeResponse(body=info(graph_hash, **extra)),
        ("GET", f"https://www.desmos.com/calc-states/production/{graph_hash}"): FakeResponse(body=STATE),
    }


def import_link(client, link, **extra):
    return client.post("/api/graphs/import-desmos", json={"link": link, **extra}, headers=FETCH)


@pytest.mark.parametrize(
    "link",
    [
        HASH,
        f"https://www.desmos.com/calculator/{HASH}",
        f"https://desmos.com/calculator/{HASH}",
        f"http://www.desmos.com/calculator/{HASH}/",
        f"www.desmos.com/calculator/{HASH}",
        f"desmos.com/calculator/{HASH}?lang=fr",
        f"  https://WWW.Desmos.com/calculator/{HASH}#x  ",
    ],
)
def test_parse_link_accepts_desmos_links(link):
    assert desmos_com.parse_link(link) == HASH


@pytest.mark.parametrize(
    "link",
    [
        None,
        "",
        "abcd",
        "ZUKJGK9IRY",
        "a" * 41,
        f"https://evil.com/calculator/{HASH}",
        f"https://www.desmos.com.evil.com/calculator/{HASH}",
        f"https://evil.com@www.desmos.com/calculator/{HASH}",
        f"https://www.desmos.com:8443/calculator/{HASH}",
        f"https://www.desmos.com/geometry/{HASH}",
        f"https://www.desmos.com/calculator/{HASH}/extra",
        f"https://www.desmos.com/calculator/../{HASH}",
        f"https://www.desmos.com/calculator/{HASH}%2F..",
        f"ftp://www.desmos.com/calculator/{HASH}",
        f"javascript://www.desmos.com/calculator/{HASH}",
    ],
)
def test_parse_link_rejects_everything_else(link):
    assert desmos_com.parse_link(link) is None


def test_import_creates_owned_graph_with_state_and_title(alice, desmos):
    session = desmos(graph_routes())
    res = import_link(alice, f"https://www.desmos.com/calculator/{HASH}")
    assert res.status_code == 201, res.get_json()
    graph = res.get_json()
    assert graph["title"] == "Parabolas" and graph["role"] == "owner" and graph["thumbnail_at"] is None

    first, second = session.calls
    assert first["headers"]["Accept"] == "application/json"
    assert all(call["allow_redirects"] is False and call["timeout"] and call["stream"] for call in session.calls)
    assert second["url"] == f"https://www.desmos.com/calc-states/production/{HASH}"

    doc = Doc()
    doc.apply_update(alice.get(f"/api/graphs/{graph['id']}/doc").data)
    assert str(doc.get("meta", type=Map)["title"]) == "Parabolas"
    assert doc.get("state", type=Map).to_py() == {"version": 11, "randomSeed": "seed"}
    assert doc.get("graph", type=Map)["viewport"] == STATE["graph"]["viewport"]
    assert list(doc.get("order", type=Array)) == ["1", "2"]
    items = doc.get("items", type=Map)
    assert isinstance(items["1"]["latex"], Text) and isinstance(items["1"]["slider"], Map)
    assert isinstance(items["1"]["slider"]["min"], Text)
    values = items["2"]["columns"][0]["values"]
    assert isinstance(values, Array) and [str(v) for v in values] == ["1", ""]
    assert isinstance(doc.get("ticker", type=Map)["handlerLatex"], Text)


def test_import_uses_inline_state_without_second_request(alice, desmos):
    session = desmos(
        {("GET", f"https://www.desmos.com/calculator/{HASH}"): FakeResponse(body=info(state=STATE))}
    )
    assert import_link(alice, HASH).status_code == 201
    assert len(session.calls) == 1


@pytest.mark.parametrize("title", [None, "", "  ", "Untitled Graph"])
def test_import_without_title_gets_default_name(alice, desmos, title):
    new_graph(alice)
    desmos(graph_routes(title=title))
    res = import_link(alice, HASH)
    assert res.status_code == 201 and res.get_json()["title"] == "Untitled Graph (2)"


def test_import_into_folder(alice, desmos):
    folder = make_folder(alice)
    desmos(graph_routes())
    res = import_link(alice, HASH, folder_id=folder["id"])
    assert res.status_code == 201 and res.get_json()["folder_id"] == folder["id"]


@pytest.mark.parametrize(
    "state_url",
    [
        "https://evil.com/calc-states/production/x",
        "http://www.desmos.com/calc-states/production/x",
        "https://www.desmos.com/api/v1/whatever",
        "https://www.desmos.com:444/calc-states/x",
        "https://www.desmos.com/calc-states/../calculator/x",
        "https://user@www.desmos.com/calc-states/x",
        None,
        42,
    ],
)
def test_import_refuses_state_url_off_host(alice, desmos, state_url):
    session = desmos(
        {("GET", f"https://www.desmos.com/calculator/{HASH}"): FakeResponse(body=info(stateUrl=state_url))}
    )
    res = import_link(alice, HASH)
    assert res.status_code == 502
    assert len(session.calls) == 1


def test_import_does_not_follow_redirects(alice, desmos):
    session = desmos(
        {
            ("GET", f"https://www.desmos.com/calculator/{HASH}"): FakeResponse(
                302, b"", {"Location": "https://evil.com/"}
            )
        }
    )
    assert import_link(alice, HASH).status_code == 502
    assert len(session.calls) == 1


@pytest.mark.parametrize("status", [401, 403, 404])
def test_import_missing_or_private_graph(alice, desmos, status):
    desmos({("GET", f"https://www.desmos.com/calculator/{HASH}"): FakeResponse(status, b"null")})
    res = import_link(alice, HASH)
    assert res.status_code == 404
    assert "isn't shared publicly" in res.get_json()["error"]
    assert alice.get("/api/graphs").get_json()["graphs"] == []


def test_import_network_failure(alice, desmos):
    desmos({("GET", f"https://www.desmos.com/calculator/{HASH}"): requests.ConnectTimeout()})
    res = import_link(alice, HASH)
    assert res.status_code == 502 and "Couldn't reach desmos.com" in res.get_json()["error"]


def test_import_size_cap(alice, desmos, monkeypatch):
    monkeypatch.setattr(desmos_com, "MAX_RESPONSE_BYTES", 1000)
    routes = graph_routes()
    routes[("GET", f"https://www.desmos.com/calc-states/production/{HASH}")] = FakeResponse(body=b"x" * 5000)
    desmos(routes)
    assert import_link(alice, HASH).status_code == 413

    routes[("GET", f"https://www.desmos.com/calc-states/production/{HASH}")] = FakeResponse(
        body=b"{}", headers={"Content-Length": "999999"}
    )
    assert import_link(alice, HASH).status_code == 413


@pytest.mark.parametrize(
    "body",
    [b"<html>", b"[]", json.dumps(info(product="graphing-3d")).encode()],
)
def test_import_rejects_unexpected_info(alice, desmos, body):
    desmos({("GET", f"https://www.desmos.com/calculator/{HASH}"): FakeResponse(body=body)})
    assert import_link(alice, HASH).status_code in (404, 422, 502)
    assert alice.get("/api/graphs").get_json()["graphs"] == []


@pytest.mark.parametrize("state", [{"graph": {}}, {"version": "11"}, {"version": 11, "expressions": {"list": [1]}}])
def test_import_rejects_invalid_state(alice, desmos, state):
    routes = graph_routes()
    routes[("GET", f"https://www.desmos.com/calc-states/production/{HASH}")] = FakeResponse(body=state)
    desmos(routes)
    assert import_link(alice, HASH).status_code == 422


@pytest.mark.parametrize("link", ["https://evil.com/calculator/zukjgk9iry", "", None, "nope"])
def test_import_rejects_bad_links_without_network(alice, desmos, link):
    session = desmos({})
    res = import_link(alice, link)
    assert res.status_code == 400 and "desmos.com/calculator" in res.get_json()["error"]
    assert session.calls == []


def test_import_requires_login_and_fetch_header(app, alice, desmos):
    desmos({})
    assert app.test_client().post("/api/graphs/import-desmos", json={"link": HASH}, headers=FETCH).status_code == 401
    assert alice.post("/api/graphs/import-desmos", json={"link": HASH}).status_code == 403


def test_import_rate_limited(alice, desmos, monkeypatch):
    monkeypatch.setattr(desmos_com, "import_limiter", desmos_com.RateLimiter(2, 600))
    desmos(graph_routes())
    assert [import_link(alice, HASH).status_code for _ in range(3)] == [201, 201, 429]


def save_route(response):
    return {("POST", "https://www.desmos.com/api/v1/calculator-shared/save"): response}


def export(client, graph_id, state=STATE, thumbnail=PNG_URL):
    return client.post(
        f"/api/graphs/{graph_id}/export-desmos", json={"state": state, "thumbnail": thumbnail}, headers=FETCH
    )


def test_export_request_shape(alice, graph_id, desmos, monkeypatch):
    monkeypatch.setattr(desmos_com, "random_hash", lambda: "abcde12345")
    session = desmos(save_route(FakeResponse(body={"hash": "abcde12345", "type": "quick-link"})))
    res = export(alice, graph_id)
    assert res.status_code == 200
    assert res.get_json() == {"hash": "abcde12345", "url": "https://www.desmos.com/calculator/abcde12345"}

    (call,) = session.calls
    assert call["method"] == "POST" and call["allow_redirects"] is False
    assert call["headers"]["Content-Type"] == "application/json"
    body = json.loads(call["data"])
    assert body == {
        "thumbnailData": PNG_URL,
        "hash": "abcde12345",
        "type": "quick-link",
        "title": "Untitled Graph",
        "state": body["state"],
        "product": "graphing",
        "lang": "en",
    }
    assert json.loads(body["state"]) == STATE


def test_random_hash_looks_like_desmos():
    hashes = {desmos_com.random_hash() for _ in range(50)}
    assert len(hashes) == 50
    assert all(len(h) == 10 and desmos_com.HASH_RE.fullmatch(h) for h in hashes)


def test_viewer_can_export(alice, bob, graph_id, desmos):
    res = alice.put(f"/api/graphs/{graph_id}/link", json={"access": "viewer"}, headers=FETCH)
    assert res.status_code == 200, res.get_json()
    desmos(save_route(FakeResponse(body={"hash": "abcde12345"})))
    assert export(bob, graph_id).status_code == 200


def test_export_needs_access(bob, graph_id, desmos):
    session = desmos({})
    assert export(bob, graph_id).status_code == 404
    assert session.calls == []


@pytest.mark.parametrize(
    "state,thumbnail",
    [
        (None, PNG_URL),
        ({"graph": {}}, PNG_URL),
        (STATE, None),
        (STATE, "data:image/jpeg;base64,AAAA"),
        (STATE, "data:image/png;base64,!!!"),
        (STATE, "data:image/png;base64," + base64.b64encode(b"GIF89a").decode()),
    ],
)
def test_export_validates_input(alice, graph_id, desmos, state, thumbnail):
    session = desmos({})
    assert export(alice, graph_id, state, thumbnail).status_code == 400
    assert session.calls == []


@pytest.mark.parametrize(
    "response,status",
    [
        (FakeResponse(500, b"oops"), 502),
        (FakeResponse(400, {"errors": [{"key": "bad"}]}), 502),
        (FakeResponse(429, b""), 503),
        (FakeResponse(200, b"<html>"), 502),
        (FakeResponse(200, {"hash": "../../x"}), 502),
        (FakeResponse(301, b"", {"Location": "https://evil.com"}), 502),
        (requests.ReadTimeout(), 502),
    ],
)
def test_export_errors_are_reported(alice, graph_id, desmos, response, status):
    desmos(save_route(response))
    res = export(alice, graph_id)
    assert res.status_code == status
    assert " " in res.get_json()["error"]


def test_export_rate_limited(alice, graph_id, desmos, monkeypatch):
    monkeypatch.setattr(desmos_com, "export_limiter", desmos_com.RateLimiter(1, 600))
    desmos(save_route(FakeResponse(body={"hash": "abcde12345"})))
    assert [export(alice, graph_id).status_code for _ in range(2)] == [200, 429]
