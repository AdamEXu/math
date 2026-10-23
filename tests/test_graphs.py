import base64
import hashlib
import sqlite3
import uuid

import pytest
from pycrdt import Doc, Map, Text

import docstore
import graphs
from tests.conftest import FETCH, ORIGIN, new_graph

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def b64(data):
    return base64.b64encode(data).decode()


def post_updates(client, graph_id, updates, headers=FETCH, prefix="/api"):
    payload = {"updates": [{"id": uid, "ts": 1, "data": b64(data)} for uid, data in updates]}
    return client.post(f"{prefix}/graphs/{graph_id}/updates", json=payload, headers=headers)


class Writer:
    def __init__(self, client=None, graph_id=None):
        self.doc = Doc()
        if client is not None:
            self.doc.apply_update(client.get(f"/api/graphs/{graph_id}/doc").data)
        self.meta = self.doc.get("meta", type=Map)

    def edit(self, fn):
        before = self.doc.get_state()
        with self.doc.transaction():
            fn(self.meta)
        return str(uuid.uuid4()), self.doc.get_update(before)


def rows(app, sql, *args):
    conn = sqlite3.connect(app.config["DATA_DIR"] / "math.db")
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def load_doc(client, graph_id):
    res = client.get(f"/api/graphs/{graph_id}/doc")
    assert res.status_code == 200
    assert res.mimetype == "application/octet-stream" and res.headers["Cache-Control"] == "no-store"
    doc = Doc()
    doc.apply_update(res.data)
    return doc


def graph_list(client):
    res = client.get("/api/graphs")
    assert res.status_code == 200
    return res.get_json()["graphs"]


def test_health_is_public(app):
    assert app.test_client().get("/health").get_json() == {"status": "ok"}


def test_api_requires_login_with_401(app, graph_id):
    client = app.test_client()
    assert post_updates(client, graph_id, []).status_code == 401
    res = client.get("/api/graphs")
    assert res.status_code == 401 and res.get_json() == {"error": "signed_out"}


def test_new_graph_is_uuid7_with_graph_json(alice, graph_id):
    assert uuid.UUID(graph_id).version == 7
    res = alice.get(f"/api/graphs/{graph_id}")
    assert res.status_code == 200
    body = res.get_json()
    assert set(body) == {"id", "title", "updated_at", "thumbnail_at", "folder_id", "role", "owner"}
    assert body["role"] == "owner" and body["owner"]["id"] == alice.user_id and body["owner"]["handle"] == "alice"
    assert "email" not in body["owner"]
    assert body["id"] == graph_id and body["title"] == "Untitled Graph"
    assert body["thumbnail_at"] is None and body["folder_id"] is None and isinstance(body["updated_at"], int)


def test_create_returns_201_graph_json(alice):
    res = alice.post("/api/graphs", headers=FETCH)
    assert res.status_code == 201
    assert res.get_json() == alice.get(f"/api/graphs/{res.get_json()['id']}").get_json()


@pytest.mark.parametrize("body", ["[]", "null", "nope"])
def test_create_rejects_non_object_body(app, alice, body):
    res = alice.post("/api/graphs", data=body, content_type="application/json", headers=FETCH)
    assert res.status_code == 400 and res.get_json() == {"error": "Bad request."}
    assert rows(app, "SELECT COUNT(*) FROM graphs") == [(0,)]


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/api/graphs/{id}"),
        ("get", "/api/graphs/{id}/doc"),
        ("delete", "/api/graphs/{id}"),
        ("put", "/api/graphs/{id}/folder"),
        ("post", "/api/graphs/{id}/thumbnail"),
        ("post", "/api/graphs/{id}/updates"),
        ("post", "/graphs/{id}/updates"),
        ("get", "/graphs/{id}/thumbnail.png"),
    ],
)
def test_other_users_get_404(bob, graph_id, method, path):
    res = getattr(bob, method)(path.format(id=graph_id), headers=FETCH, data=PNG)
    assert res.status_code == 404
    if path.startswith("/api/"):
        assert res.get_json() == {"error": "not_found"}


def test_list_has_only_own_graphs_newest_first(app, alice, bob, graph_id):
    second = new_graph(alice)
    writer = Writer(alice, graph_id)
    assert post_updates(alice, graph_id, [writer.edit(lambda m: m.__setitem__("title", Text("Parabola")))]).status_code == 200
    listed = graph_list(alice)
    assert [g["id"] for g in listed] == [graph_id, second]
    assert listed[0]["title"] == "Parabola"
    assert listed[0]["updated_at"] >= listed[1]["updated_at"]
    assert graph_list(bob) == []


def test_malformed_ids_404(alice):
    res = alice.get("/api/graphs/not-a-uuid")
    assert res.status_code == 404 and res.get_json() == {"error": "not_found"}
    assert alice.get("/api/graphs/not-a-uuid/doc").status_code == 404
    assert alice.get("/images/xyz").status_code == 404


def test_updates_round_trip_and_title_mirror(app, alice, graph_id):
    writer = Writer(alice, graph_id)
    first = writer.edit(lambda m: m.__setitem__("title", Text("Hello")))
    second = writer.edit(lambda m: m["title"].insert(5, " world"))
    res = post_updates(alice, graph_id, [first, second])
    assert res.get_json() == {"acked": [first[0], second[0]], "seq": 3}
    assert str(load_doc(alice, graph_id).get("meta", type=Map)["title"]) == "Hello world"
    assert rows(app, "SELECT title FROM graphs WHERE id = ?", graph_id) == [("Hello world",)]
    assert alice.get(f"/api/graphs/{graph_id}").get_json()["title"] == "Hello world"


def test_legacy_updates_alias_still_saves(app, alice, graph_id):
    writer = Writer(alice, graph_id)
    first = writer.edit(lambda m: m.__setitem__("title", Text("Legacy")))
    assert post_updates(alice, graph_id, [first], headers={}, prefix="").status_code == 403
    res = post_updates(alice, graph_id, [first], prefix="")
    assert res.status_code == 200 and res.get_json() == {"acked": [first[0]], "seq": 2}
    assert post_updates(alice, graph_id, [first]).get_json() == {"acked": [first[0]], "seq": 2}
    assert rows(app, "SELECT title FROM graphs WHERE id = ?", graph_id) == [("Legacy",)]
    assert post_updates(alice, graph_id, [(str(uuid.uuid4()), b"garbage")], prefix="").status_code == 400
    assert post_updates(app.test_client(), graph_id, [first], prefix="").status_code == 401


def test_duplicate_update_ids_are_acked_but_not_appended(app, alice, graph_id):
    writer = Writer(alice, graph_id)
    first = writer.edit(lambda m: m.__setitem__("title", Text("a")))
    second = writer.edit(lambda m: m["title"].insert(1, "b"))
    assert post_updates(alice, graph_id, [first]).get_json()["seq"] == 2
    res = post_updates(alice, graph_id, [first, second])
    assert res.get_json() == {"acked": [first[0], second[0]], "seq": 3}
    assert post_updates(alice, graph_id, [first, second]).get_json()["seq"] == 3
    assert rows(app, "SELECT seq FROM updates WHERE graph_id = ? ORDER BY seq", graph_id) == [(1,), (2,), (3,)]


def test_checkpoint_written_and_load_uses_it(app, alice, graph_id, monkeypatch):
    monkeypatch.setattr(docstore, "CHECKPOINT_EVERY", 5)
    writer = Writer(alice, graph_id)
    batch = [writer.edit(lambda m: m.__setitem__("title", Text("")))]
    for i in range(11):
        batch.append(writer.edit(lambda m, i=i: m["title"].insert(len(str(m["title"])), str(i % 10))))
    for update in batch:
        assert post_updates(alice, graph_id, [update]).status_code == 200
    checkpoints = rows(app, "SELECT seq FROM checkpoints WHERE graph_id = ? ORDER BY seq", graph_id)
    assert checkpoints == [(5,), (10,)]
    assert rows(app, "SELECT COUNT(*) FROM updates WHERE graph_id = ?", graph_id) == [(13,)]
    assert str(load_doc(alice, graph_id).get("meta", type=Map)["title"]) == "01234567890"


def test_out_of_order_update_survives_checkpoint(app, alice, graph_id, monkeypatch):
    monkeypatch.setattr(docstore, "CHECKPOINT_EVERY", 1)
    writer = Writer(alice, graph_id)
    first = writer.edit(lambda m: m.__setitem__("title", Text("x")))
    second = writer.edit(lambda m: m["title"].insert(1, "y"))
    assert post_updates(alice, graph_id, [second]).status_code == 200
    assert post_updates(alice, graph_id, [first]).status_code == 200
    assert str(load_doc(alice, graph_id).get("meta", type=Map)["title"]) == "xy"


def test_invalid_update_rejected(alice, graph_id):
    res = post_updates(alice, graph_id, [(str(uuid.uuid4()), b"garbage")])
    assert res.status_code == 400 and res.get_json() == {"error": "Bad request."}
    res = alice.post(f"/api/graphs/{graph_id}/updates", json={"updates": [{"id": "nope", "data": "AA=="}]}, headers=FETCH)
    assert res.status_code == 400
    assert post_updates(alice, graph_id, []).status_code == 400


def test_logout_requires_same_origin(alice):
    assert alice.post("/auth/logout", headers={"Origin": "https://evil.example"}).status_code == 403
    assert alice.post("/auth/logout").status_code == 403
    assert alice.get("/api/me").status_code == 200
    res = alice.post("/auth/logout", headers={"Origin": ORIGIN})
    assert res.status_code == 302 and res.headers["Location"] == "/login"
    assert alice.get("/api/me").status_code == 401
    assert alice.get("/").headers["Location"] == "/login"


def test_thumbnail_upload_and_serve(alice, graph_id):
    assert alice.post(f"/api/graphs/{graph_id}/thumbnail", data=b"not a png", headers=FETCH).status_code == 400
    assert alice.get(f"/graphs/{graph_id}/thumbnail.png").status_code == 404
    res = alice.post(f"/api/graphs/{graph_id}/thumbnail", data=PNG, headers=FETCH)
    assert res.status_code == 200 and res.get_json() == {"ok": True}
    res = alice.get(f"/graphs/{graph_id}/thumbnail.png")
    assert res.data == PNG and res.mimetype == "image/png"
    assert res.headers["Cache-Control"] == "private, no-cache"
    thumbnail_at = alice.get(f"/api/graphs/{graph_id}").get_json()["thumbnail_at"]
    assert isinstance(thumbnail_at, int)
    assert graph_list(alice)[0]["thumbnail_at"] == thumbnail_at
    res = alice.get(f"/graphs/{graph_id}/thumbnail.png?v={thumbnail_at}")
    assert res.headers["Cache-Control"] == "private, max-age=31536000, immutable"


def test_thumbnail_rejects_oversized_png(alice, graph_id, monkeypatch):
    monkeypatch.setattr(graphs, "MAX_THUMBNAIL_BYTES", len(PNG) - 1)
    assert alice.post(f"/api/graphs/{graph_id}/thumbnail", data=PNG, headers=FETCH).status_code == 400


def test_image_upload_dedupes_and_any_signed_in_user_can_read(app, alice, bob):
    sha = hashlib.sha256(PNG).hexdigest()
    first = alice.post("/api/images", data=PNG, content_type="image/png", headers=FETCH)
    again = alice.post("/api/images", data=PNG, content_type="image/png", headers=FETCH)
    assert first.get_json() == again.get_json() == {"url": f"/images/{sha}"}
    assert rows(app, "SELECT COUNT(*) FROM images") == [(1,)]
    res = alice.get(f"/images/{sha}")
    assert res.data == PNG and res.mimetype == "image/png"
    assert res.headers["X-Content-Type-Options"] == "nosniff" and "sandbox" in res.headers["Content-Security-Policy"]
    assert bob.get(f"/images/{sha}").data == PNG
    assert bob.get(f"/images/{'0' * 64}").status_code == 404
    assert bob.post("/api/images", data=PNG, content_type="image/png", headers=FETCH).status_code == 200
    assert bob.get(f"/images/{sha}").data == PNG
    assert rows(app, "SELECT COUNT(*) FROM images") == [(1,)]
    assert rows(app, "SELECT COUNT(*) FROM image_owners") == [(2,)]


def test_image_upload_rejects_bad_type(alice):
    res = alice.post("/api/images", data=b"<html>", content_type="text/html", headers=FETCH)
    assert res.status_code == 400 and res.get_json() == {"error": "Bad request."}
    assert alice.post("/api/images", data=b"", content_type="image/png", headers=FETCH).status_code == 400


def test_images_need_login(app, alice):
    sha = hashlib.sha256(PNG).hexdigest()
    alice.post("/api/images", data=PNG, content_type="image/png", headers=FETCH)
    res = app.test_client().get(f"/images/{sha}")
    assert res.status_code == 302 and res.headers["Location"] == "/login"


def test_dev_login_only_in_debug(app, monkeypatch):
    monkeypatch.setenv("DEV_LOGIN_EMAIL", "dev@pinewood.edu")
    client = app.test_client()
    app.debug = False
    assert client.post("/auth/dev-login", headers={"Origin": ORIGIN}).status_code == 404
    assert "Dev sign-in" not in client.get("/login").get_data(as_text=True)
    app.debug = True
    try:
        assert "Dev sign-in as dev@pinewood.edu" in client.get("/login").get_data(as_text=True)
        assert client.post("/auth/dev-login").status_code == 403
        res = client.post("/auth/dev-login", headers={"Origin": ORIGIN})
        assert res.status_code == 302 and res.headers["Location"] == "/"
        assert client.get("/").headers["Location"] == "/welcome?next=/"
        assert client.get("/login").headers["Location"] == "/"
        other = app.test_client()
        assert other.post("/auth/dev-login", data={"email": "eve@gmail.com"}, headers={"Origin": ORIGIN}).status_code == 400
        res = other.post("/auth/dev-login", data={"email": "Second@Pinewood.edu"}, headers={"Origin": ORIGIN})
        assert res.status_code == 302
        assert other.get("/api/me").get_json()["email"] == "second@pinewood.edu"
    finally:
        app.debug = False


def test_dev_login_refuses_non_local_base_url(app, monkeypatch):
    monkeypatch.setenv("DEV_LOGIN_EMAIL", "dev@pinewood.edu")
    monkeypatch.setenv("BASE_URL", "https://math.pinewood.club")
    app.debug = True
    try:
        res = app.test_client().post("/auth/dev-login", headers={"Origin": "https://math.pinewood.club"})
        assert res.status_code == 404
    finally:
        app.debug = False


def test_login_page_shows_error_messages(app):
    client = app.test_client()
    page = client.get("/login?error=invalid_domain").get_data(as_text=True)
    assert "Sign in with your pinewood.edu account." in page and "/auth/google" in page
    assert "Sign-in failed, try again." in client.get("/login?error=whatever").get_data(as_text=True)


def test_delete_hides_graph_but_keeps_log(app, alice, bob, graph_id):
    writer = Writer(alice, graph_id)
    assert post_updates(alice, graph_id, [writer.edit(lambda m: m.__setitem__("title", Text("Gone")))]).status_code == 200
    assert bob.delete(f"/api/graphs/{graph_id}", headers=FETCH).status_code == 404
    assert alice.delete(f"/api/graphs/{graph_id}").status_code == 403
    res = alice.delete(f"/api/graphs/{graph_id}", headers=FETCH)
    assert res.status_code == 200 and res.get_json() == {"ok": True}
    assert graph_list(alice) == []
    assert alice.get(f"/api/graphs/{graph_id}").status_code == 404
    assert alice.get(f"/api/graphs/{graph_id}/doc").status_code == 404
    assert alice.delete(f"/api/graphs/{graph_id}", headers=FETCH).status_code == 404
    assert rows(app, "SELECT COUNT(*) FROM updates WHERE graph_id = ?", graph_id) == [(2,)]
    assert rows(app, "SELECT deleted_at IS NOT NULL FROM graphs WHERE id = ?", graph_id) == [(1,)]
