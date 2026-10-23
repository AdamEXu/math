import base64
import hashlib
import sqlite3
import uuid

import pytest
from pycrdt import Doc, Map, Text

import graphs
from tests.conftest import FETCH, ORIGIN

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def b64(data):
    return base64.b64encode(data).decode()


def post_updates(client, graph_id, updates, headers=FETCH):
    payload = {"updates": [{"id": uid, "ts": 1, "data": b64(data)} for uid, data in updates]}
    return client.post(f"/graphs/{graph_id}/updates", json=payload, headers=headers)


class Writer:
    def __init__(self):
        self.doc = Doc()
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
    res = client.get(f"/graphs/{graph_id}/doc")
    assert res.status_code == 200
    doc = Doc()
    doc.apply_update(res.data)
    return doc


def test_health_is_public(app):
    assert app.test_client().get("/health").get_json() == {"status": "ok"}


def test_library_requires_login(app):
    res = app.test_client().get("/")
    assert res.status_code == 302 and res.headers["Location"].endswith("/login")


def test_api_requires_login_with_401(app, graph_id):
    res = post_updates(app.test_client(), graph_id, [])
    assert res.status_code == 401


def test_new_graph_redirects_to_calculator_with_uuid7(alice, graph_id):
    assert uuid.UUID(graph_id).version == 7
    assert alice.get(f"/calculator/{graph_id}").status_code == 200


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/calculator/{id}"),
        ("get", "/graphs/{id}/doc"),
        ("get", "/graphs/{id}/thumbnail.png"),
        ("post", "/graphs/{id}/thumbnail"),
        ("post", "/graphs/{id}/updates"),
    ],
)
def test_other_users_get_404(bob, graph_id, method, path):
    res = getattr(bob, method)(path.format(id=graph_id), headers=FETCH, data=PNG)
    assert res.status_code == 404


def test_library_lists_only_own_graphs_newest_first(app, alice, bob, graph_id):
    second = alice.post("/graphs", headers={"Origin": ORIGIN}).headers["Location"].rsplit("/", 1)[1]
    writer = Writer()
    assert post_updates(alice, graph_id, [writer.edit(lambda m: m.__setitem__("title", Text("Parabola")))]).status_code == 200
    page = alice.get("/").get_data(as_text=True)
    assert page.index(graph_id) < page.index(second)
    assert "Parabola" in page
    assert graph_id not in bob.get("/").get_data(as_text=True)


def test_malformed_ids_404(alice):
    assert alice.get("/calculator/not-a-uuid").status_code == 404
    assert alice.get("/images/xyz").status_code == 404


def test_updates_round_trip_and_title_mirror(app, alice, graph_id):
    writer = Writer()
    first = writer.edit(lambda m: m.__setitem__("title", Text("Hello")))
    second = writer.edit(lambda m: m["title"].insert(5, " world"))
    res = post_updates(alice, graph_id, [first, second])
    assert res.get_json() == {"acked": [first[0], second[0]], "seq": 2}
    assert str(load_doc(alice, graph_id).get("meta", type=Map)["title"]) == "Hello world"
    assert rows(app, "SELECT title FROM graphs WHERE id = ?", graph_id) == [("Hello world",)]


def test_duplicate_update_ids_are_acked_but_not_appended(app, alice, graph_id):
    writer = Writer()
    first = writer.edit(lambda m: m.__setitem__("title", Text("a")))
    second = writer.edit(lambda m: m["title"].insert(1, "b"))
    assert post_updates(alice, graph_id, [first]).get_json()["seq"] == 1
    res = post_updates(alice, graph_id, [first, second])
    assert res.get_json() == {"acked": [first[0], second[0]], "seq": 2}
    assert post_updates(alice, graph_id, [first, second]).get_json()["seq"] == 2
    assert rows(app, "SELECT seq FROM updates WHERE graph_id = ? ORDER BY seq", graph_id) == [(1,), (2,)]


def test_checkpoint_written_and_load_uses_it(app, alice, graph_id, monkeypatch):
    monkeypatch.setattr(graphs, "CHECKPOINT_EVERY", 5)
    writer = Writer()
    batch = [writer.edit(lambda m: m.__setitem__("title", Text("")))]
    for i in range(11):
        batch.append(writer.edit(lambda m, i=i: m["title"].insert(len(str(m["title"])), str(i % 10))))
    for update in batch:
        assert post_updates(alice, graph_id, [update]).status_code == 200
    checkpoints = rows(app, "SELECT seq FROM checkpoints WHERE graph_id = ? ORDER BY seq", graph_id)
    assert checkpoints == [(5,), (10,)]
    assert rows(app, "SELECT COUNT(*) FROM updates WHERE graph_id = ?", graph_id) == [(12,)]
    assert str(load_doc(alice, graph_id).get("meta", type=Map)["title"]) == "01234567890"


def test_out_of_order_update_survives_checkpoint(app, alice, graph_id, monkeypatch):
    monkeypatch.setattr(graphs, "CHECKPOINT_EVERY", 1)
    writer = Writer()
    first = writer.edit(lambda m: m.__setitem__("title", Text("x")))
    second = writer.edit(lambda m: m["title"].insert(1, "y"))
    assert post_updates(alice, graph_id, [second]).status_code == 200
    assert post_updates(alice, graph_id, [first]).status_code == 200
    assert str(load_doc(alice, graph_id).get("meta", type=Map)["title"]) == "xy"


def test_invalid_update_rejected(alice, graph_id):
    assert post_updates(alice, graph_id, [(str(uuid.uuid4()), b"garbage")]).status_code == 400
    res = alice.post(f"/graphs/{graph_id}/updates", json={"updates": [{"id": "nope", "data": "AA=="}]}, headers=FETCH)
    assert res.status_code == 400


def test_csrf_rejections(app, alice, graph_id):
    writer = Writer()
    assert post_updates(alice, graph_id, [writer.edit(lambda m: m.__setitem__("k", 1))], headers={}).status_code == 403
    assert alice.post(f"/graphs/{graph_id}/thumbnail", data=PNG).status_code == 403
    assert alice.post("/images", data=PNG, content_type="image/png").status_code == 403
    assert alice.post("/graphs").status_code == 403
    assert alice.post("/graphs", headers={"Origin": "https://evil.example"}).status_code == 403
    assert alice.post("/auth/logout", headers={"Origin": "https://evil.example"}).status_code == 403
    assert alice.get("/").status_code == 200
    assert alice.post("/auth/logout", headers={"Origin": ORIGIN}).status_code == 302
    assert alice.get("/").status_code == 302


def test_thumbnail_upload_and_serve(alice, graph_id):
    assert alice.post(f"/graphs/{graph_id}/thumbnail", data=b"not a png", headers=FETCH).status_code == 400
    assert alice.get(f"/graphs/{graph_id}/thumbnail.png").status_code == 404
    assert alice.post(f"/graphs/{graph_id}/thumbnail", data=PNG, headers=FETCH).status_code == 200
    res = alice.get(f"/graphs/{graph_id}/thumbnail.png")
    assert res.data == PNG and res.mimetype == "image/png"
    assert f"/graphs/{graph_id}/thumbnail.png?v=" in alice.get("/").get_data(as_text=True)


def test_image_upload_dedupes_and_checks_ownership(app, alice, bob):
    sha = hashlib.sha256(PNG).hexdigest()
    first = alice.post("/images", data=PNG, content_type="image/png", headers=FETCH)
    again = alice.post("/images", data=PNG, content_type="image/png", headers=FETCH)
    assert first.get_json() == again.get_json() == {"url": f"/images/{sha}"}
    assert rows(app, "SELECT COUNT(*) FROM images") == [(1,)]
    assert alice.get(f"/images/{sha}").data == PNG
    assert bob.get(f"/images/{sha}").status_code == 404
    assert bob.post("/images", data=PNG, content_type="image/png", headers=FETCH).status_code == 200
    assert bob.get(f"/images/{sha}").data == PNG
    assert rows(app, "SELECT COUNT(*) FROM images") == [(1,)]
    assert rows(app, "SELECT COUNT(*) FROM image_owners") == [(2,)]


def test_image_upload_rejects_bad_type(alice):
    assert alice.post("/images", data=b"<html>", content_type="text/html", headers=FETCH).status_code == 400


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
        assert client.post("/auth/dev-login", headers={"Origin": ORIGIN}).status_code == 302
        assert client.get("/").status_code == 200
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


def test_delete_hides_graph_but_keeps_log(app, alice, bob, graph_id):
    writer = Writer()
    assert post_updates(alice, graph_id, [writer.edit(lambda m: m.__setitem__("title", Text("Gone")))]).status_code == 200
    assert bob.post(f"/graphs/{graph_id}/delete", headers={"Origin": ORIGIN}).status_code == 404
    assert alice.post(f"/graphs/{graph_id}/delete").status_code == 403
    assert alice.post(f"/graphs/{graph_id}/delete", headers={"Origin": ORIGIN}).status_code == 302
    assert graph_id not in alice.get("/").get_data(as_text=True)
    assert alice.get(f"/calculator/{graph_id}").status_code == 404
    assert rows(app, "SELECT COUNT(*) FROM updates WHERE graph_id = ?", graph_id) == [(1,)]
