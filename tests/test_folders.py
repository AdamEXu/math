import uuid

import pytest

import lucide
from tests.conftest import FETCH, new_graph
from tests.test_graphs import graph_list, rows


def make_folder(client, name="Algebra", **extra):
    res = client.post("/api/folders", json={"name": name, **extra}, headers=FETCH)
    assert res.status_code == 201, res.get_json()
    return res.get_json()


def folder_list(client):
    res = client.get("/api/folders")
    assert res.status_code == 200
    return res.get_json()


def edit(client, folder_id, **changes):
    return client.patch(f"/api/folders/{folder_id}", json=changes, headers=FETCH)


def move(client, graph_id, folder_id):
    return client.put(f"/api/graphs/{graph_id}/folder", json={"folder_id": folder_id}, headers=FETCH)


def placement(app, user_id, graph_id):
    found = rows(app, "SELECT folder_id FROM graph_placements WHERE user_id = ? AND graph_id = ?", user_id, graph_id)
    return found[0][0] if found else None


def test_create_folder_defaults_and_order(app, alice):
    first = make_folder(alice, "  Algebra  ")
    second = make_folder(alice, "Calculus", icon="sigma", color="#c74440")
    assert uuid.UUID(first["id"]).version == 7
    assert first == {"id": first["id"], "name": "Algebra", "icon": "folder", "color": "#737373"}
    assert second["icon"] == "sigma" and second["color"] == "#c74440"
    assert rows(app, "SELECT name, position FROM folders ORDER BY position") == [("Algebra", 1), ("Calculus", 2)]
    assert folder_list(alice)["folders"] == [first, second]


def test_folders_require_login(app):
    assert app.test_client().get("/api/folders").status_code == 401


@pytest.mark.parametrize(
    "payload",
    [
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 61},
        {"name": "a\x00b"},
        {"name": 5},
        {},
        {"name": "ok", "icon": "not-an-icon"},
        {"name": "ok", "icon": "Folder"},
        {"name": "ok", "icon": ["folder"]},
        {"name": "ok", "icon": None},
        {"name": "ok", "color": "#ff0000"},
        {"name": "ok", "color": "red"},
        {"name": "ok", "color": ["#737373"]},
        ["Algebra"],
    ],
)
def test_create_folder_validation(app, alice, payload):
    res = alice.post("/api/folders", json=payload, headers=FETCH)
    assert res.status_code == 400
    assert isinstance(res.get_json()["error"], str)
    assert rows(app, "SELECT COUNT(*) FROM folders") == [(0,)]


@pytest.mark.parametrize(
    "payload,message",
    [
        ({"name": ""}, "Enter a folder name."),
        ({"name": "x" * 61}, "Folder names are at most 60 characters."),
        ({"name": "a\x00b"}, "Folder names can't contain control characters."),
        ({"name": "ok", "icon": "nope"}, "Unknown icon."),
        ({"name": "ok", "color": "red"}, "Unknown color."),
        ([], "Bad request."),
    ],
)
def test_validation_messages(alice, payload, message):
    assert alice.post("/api/folders", json=payload, headers=FETCH).get_json() == {"error": message}


def test_any_lucide_icon_is_accepted_and_its_markup_listed(alice):
    folder = make_folder(alice, "Bio", icon="dna", color="#388c46")
    make_folder(alice, "Plain")
    make_folder(alice, "Bio 2", icon="dna")
    assert folder["icon"] == "dna"
    data = folder_list(alice)
    assert set(data["icons"]) == {"dna", "folder"}
    assert data["icons"]["dna"] == lucide.ICON_MARKUP["dna"] and data["icons"]["dna"].startswith("<")


def test_icons_empty_without_folders(alice):
    assert folder_list(alice) == {"folders": [], "icons": {}}


def test_vendored_icon_set_matches_pinned_lucide():
    assert lucide.LUCIDE_VERSION == "1.61.0"
    assert len(lucide.ICON_NAMES) > 1500
    assert {"folder", "pi", "dna", "triangle", "sigma"} <= lucide.ICON_NAMES


def test_update_folder(alice):
    folder = make_folder(alice)
    res = edit(alice, folder["id"], name="Geometry", icon="shapes", color="#388c46")
    assert res.status_code == 200
    assert res.get_json() == {"id": folder["id"], "name": "Geometry", "icon": "shapes", "color": "#388c46"}
    assert edit(alice, folder["id"], icon="nope").status_code == 400
    assert edit(alice, folder["id"], color="#123456").status_code == 400
    assert edit(alice, folder["id"], name="").status_code == 400
    res = edit(alice, folder["id"], color="#000000")
    assert res.get_json()["name"] == "Geometry" and res.get_json()["color"] == "#000000"
    assert edit(alice, folder["id"]).get_json() == res.get_json()
    assert folder_list(alice)["folders"] == [res.get_json()]


def test_folder_ownership(app, alice, bob, graph_id):
    folder = make_folder(alice)
    bob_folder = make_folder(bob, "Bob's")
    bob_graph = new_graph(bob)
    res = edit(bob, folder["id"], name="Mine")
    assert res.status_code == 404 and res.get_json() == {"error": "not_found"}
    assert bob.delete(f"/api/folders/{folder['id']}", headers=FETCH).status_code == 404
    assert move(bob, graph_id, bob_folder["id"]).status_code == 404
    assert move(bob, bob_graph, folder["id"]).status_code == 404
    assert move(alice, graph_id, bob_folder["id"]).status_code == 404
    assert bob.post("/api/graphs", json={"folder_id": folder["id"]}, headers=FETCH).status_code == 404
    assert edit(alice, "not-a-uuid", name="x").status_code == 404
    assert alice.delete("/api/folders/not-a-uuid", headers=FETCH).status_code == 404
    assert move(alice, graph_id, 7).status_code == 404
    assert move(alice, graph_id, "").status_code == 404
    assert rows(app, "SELECT name FROM folders WHERE id = ?", folder["id"]) == [("Algebra",)]
    assert folder_list(alice)["folders"] == [folder]
    assert folder_list(bob)["folders"] == [bob_folder]
    assert rows(app, "SELECT COUNT(*) FROM graph_placements") == [(0,)]


def test_place_move_and_remove(app, alice, graph_id):
    algebra = make_folder(alice)
    calculus = make_folder(alice, "Calculus")
    other = new_graph(alice)
    assert move(alice, graph_id, algebra["id"]).get_json() == {"folder_id": algebra["id"]}
    assert placement(app, alice.user_id, graph_id) == algebra["id"]
    assert move(alice, graph_id, calculus["id"]).status_code == 200
    assert rows(app, "SELECT folder_id FROM graph_placements") == [(calculus["id"],)]
    assert {g["id"]: g["folder_id"] for g in graph_list(alice)} == {graph_id: calculus["id"], other: None}
    assert alice.get(f"/api/graphs/{graph_id}").get_json()["folder_id"] == calculus["id"]
    assert move(alice, graph_id, None).get_json() == {"folder_id": None}
    assert placement(app, alice.user_id, graph_id) is None
    assert alice.put(f"/api/graphs/{graph_id}/folder", json={}, headers=FETCH).status_code == 400
    assert alice.put(f"/api/graphs/{graph_id}/folder", json=[], headers=FETCH).status_code == 400


def test_delete_folder_keeps_graphs(app, alice, graph_id):
    folder = make_folder(alice)
    move(alice, graph_id, folder["id"])
    res = alice.delete(f"/api/folders/{folder['id']}", headers=FETCH)
    assert res.status_code == 200 and res.get_json() == {"ok": True}
    assert rows(app, "SELECT COUNT(*) FROM folders") == [(0,)]
    assert rows(app, "SELECT COUNT(*) FROM graph_placements") == [(0,)]
    assert rows(app, "SELECT deleted_at FROM graphs WHERE id = ?", graph_id) == [(None,)]
    assert alice.get(f"/api/graphs/{graph_id}").get_json()["folder_id"] is None
    assert edit(alice, folder["id"], name="x").status_code == 404
    assert alice.delete(f"/api/folders/{folder['id']}", headers=FETCH).status_code == 404


def test_new_graph_in_folder(app, alice):
    folder = make_folder(alice)
    graph_id = new_graph(alice, folder["id"])
    assert placement(app, alice.user_id, graph_id) == folder["id"]
    assert alice.get(f"/api/graphs/{graph_id}").get_json()["folder_id"] == folder["id"]
    plain = new_graph(alice)
    assert placement(app, alice.user_id, plain) is None
    res = alice.post("/api/graphs", json={"folder_id": None}, headers=FETCH)
    assert res.status_code == 201 and res.get_json()["folder_id"] is None
    res = alice.post("/api/graphs", json={"folder_id": str(uuid.uuid4())}, headers=FETCH)
    assert res.status_code == 404
    assert alice.post("/api/graphs", json={"folder_id": 3}, headers=FETCH).status_code == 404
    assert rows(app, "SELECT COUNT(*) FROM graphs") == [(3,)]


def test_shared_view_serves_the_app(alice, graph_id):
    res = alice.get("/shared")
    assert res.status_code == 200 and "<div id=root>" in res.get_data(as_text=True)
