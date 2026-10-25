import pytest

from tests.conftest import FETCH, signed_in
from tests.test_graphs import PNG, rows

GRAPH = "01a16761-f65e-7694-94d9-6244099f81d1"
MUTATIONS = [
    ("put", "/api/me", {"json": {"handle": "zed", "display_name": "Zed"}}),
    ("post", "/api/graphs", {}),
    ("delete", "/api/graphs/{graph}", {}),
    ("put", "/api/graphs/{graph}/folder", {"json": {"folder_id": "{folder}"}}),
    ("post", "/api/graphs/{graph}/updates", {"json": {"updates": []}}),
    ("post", "/api/graphs/{graph}/thumbnail", {"data": PNG}),
    ("post", "/api/images", {"data": PNG, "content_type": "image/png"}),
    ("post", "/api/folders", {"json": {"name": "New"}}),
    ("patch", "/api/folders/{folder}", {"json": {"name": "Renamed"}}),
    ("delete", "/api/folders/{folder}", {}),
]


def fill(value, ids):
    if isinstance(value, str):
        return value.format(**ids)
    if isinstance(value, dict):
        return {k: fill(v, ids) for k, v in value.items()}
    return value


@pytest.mark.parametrize("method,path,kwargs", MUTATIONS)
@pytest.mark.parametrize("header", [None, "XMLHttpRequest", ""])
def test_every_api_mutation_requires_fetch_header(app, alice, graph_id, method, path, kwargs, header):
    folder = alice.post("/api/folders", json={"name": "Algebra"}, headers=FETCH).get_json()
    ids = {"graph": graph_id, "folder": folder["id"]}
    before = rows(app, "SELECT (SELECT COUNT(*) FROM graphs WHERE deleted_at IS NULL), (SELECT COUNT(*) FROM folders),"
                       " (SELECT COUNT(*) FROM images), (SELECT COUNT(*) FROM graph_placements), (SELECT handle FROM users"
                       " WHERE id = ?)", alice.user_id)
    headers = {} if header is None else {"X-Requested-With": header}
    res = getattr(alice, method)(fill(path, ids), headers=headers, **fill(kwargs, ids))
    assert res.status_code == 403 and res.get_json() == {"error": "forbidden"}
    after = rows(app, "SELECT (SELECT COUNT(*) FROM graphs WHERE deleted_at IS NULL), (SELECT COUNT(*) FROM folders),"
                      " (SELECT COUNT(*) FROM images), (SELECT COUNT(*) FROM graph_placements), (SELECT handle FROM users"
                      " WHERE id = ?)", alice.user_id)
    assert before == after
    assert rows(app, "SELECT thumbnail_at FROM graphs WHERE id = ?", graph_id) == [(None,)]
    assert rows(app, "SELECT name FROM folders") == [("Algebra",)]


@pytest.mark.parametrize("method,path,kwargs", MUTATIONS)
def test_every_api_mutation_works_with_fetch_header(app, alice, graph_id, method, path, kwargs):
    folder = alice.post("/api/folders", json={"name": "Algebra"}, headers=FETCH).get_json()
    ids = {"graph": graph_id, "folder": folder["id"]}
    res = getattr(alice, method)(fill(path, ids), headers=FETCH, **fill(kwargs, ids))
    assert res.status_code in (400, 200, 201)
    assert res.status_code == 400 if path.endswith("/updates") else res.status_code in (200, 201)


@pytest.mark.parametrize("method", ["get", "post", "put", "patch", "delete"])
@pytest.mark.parametrize("path", ["/api/nope", "/api/graphs/x/y/z", "/api", "/api/"])
def test_unknown_api_paths_are_json_404(app, alice, method, path):
    for client in (alice, app.test_client()):
        res = getattr(client, method)(path, headers=FETCH)
        assert res.status_code == 404 and res.get_json() == {"error": "not_found"}


def test_wrong_method_is_json_405(alice, graph_id):
    res = alice.patch(f"/api/graphs/{graph_id}", headers=FETCH)
    assert res.status_code == 405 and res.get_json() == {"error": "method_not_allowed"}
    assert "DELETE" in res.headers["Allow"]
    assert alice.post("/api/me", headers=FETCH).status_code == 405


def test_too_large_is_json(app, alice):
    res = alice.post("/api/images", data=b"x" * (app.config["MAX_CONTENT_LENGTH"] + 1), content_type="image/png",
                     headers=FETCH)
    assert res.status_code == 413 and isinstance(res.get_json()["error"], str)


def test_api_is_json_even_without_fetch_header(app):
    res = app.test_client().get("/api/graphs")
    assert res.status_code == 401 and res.get_json() == {"error": "signed_out"}
    client = signed_in(app, "carol@pinewood.edu")
    res = client.get("/api/graphs")
    assert res.status_code == 403 and res.get_json() == {"error": "handle_required"}


def test_config_requires_login_and_returns_key(app, monkeypatch):
    monkeypatch.setenv("DESMOS_API_KEY", "desmos-key")
    res = app.test_client().get("/api/config")
    assert res.status_code == 401 and res.get_json() == {"error": "signed_out"}
    client = signed_in(app, "carol@pinewood.edu")
    assert client.get("/api/config").get_json() == {
        "desmos_scripts": ["https://www.desmos.com/api/v1.13/calculator.js?apiKey=desmos-key"]
    }


def test_doc_of_unknown_graph_is_json_404(alice):
    res = alice.get(f"/api/graphs/{GRAPH}/doc")
    assert res.status_code == 404 and res.get_json() == {"error": "not_found"}
