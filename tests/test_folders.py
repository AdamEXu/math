import uuid

import pytest

from tests.conftest import FETCH, ORIGIN
from tests.test_graphs import rows


def make_folder(client, name="Algebra", **extra):
    res = client.post("/folders", json={"name": name, **extra}, headers=FETCH)
    assert res.status_code == 201, res.get_json()
    return res.get_json()


def new_graph(client, folder_id=None):
    data = {"folder_id": folder_id} if folder_id else {}
    res = client.post("/graphs", data=data, headers={"Origin": ORIGIN})
    assert res.status_code == 302
    return res.headers["Location"].rsplit("/", 1)[1]


def move(client, graph_id, folder_id):
    return client.post(f"/graphs/{graph_id}/folder", json={"folder_id": folder_id}, headers=FETCH)


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
    page = alice.get("/").get_data(as_text=True)
    assert page.index("Algebra") < page.index("Calculus")
    assert "All Graphs" in page and "Shared with you" in page


@pytest.mark.parametrize(
    "payload",
    [
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 61},
        {"name": "a\x00b"},
        {"name": 5},
        {"name": "ok", "icon": "not-an-icon"},
        {"name": "ok", "icon": "Folder"},
        {"name": "ok", "icon": ["folder"]},
        {"name": "ok", "icon": None},
        {"name": "ok", "color": "#ff0000"},
        {"name": "ok", "color": "red"},
    ],
)
def test_create_folder_validation(app, alice, payload):
    res = alice.post("/folders", json=payload, headers=FETCH)
    assert res.status_code == 400
    assert "error" in res.get_json()
    assert rows(app, "SELECT COUNT(*) FROM folders") == [(0,)]


def test_any_lucide_icon_is_accepted_and_rendered_server_side(alice):
    folder = make_folder(alice, "Bio", icon="dna", color="#388c46")
    assert folder["icon"] == "dna"
    page = alice.get(f"/folders/{folder['id']}").get_data(as_text=True)
    assert '<svg xmlns="http://www.w3.org/2000/svg"' in page and 'class="lucide lucide-dna"' in page
    assert '"icons": {"dna": "\\u003c' in page


def test_vendored_icon_set_matches_pinned_lucide():
    import lucide

    assert lucide.LUCIDE_VERSION == "1.61.0"
    assert len(lucide.ICON_NAMES) > 1500
    assert {"folder", "pi", "dna", "triangle", "sigma"} <= lucide.ICON_NAMES


def test_update_folder(alice):
    folder = make_folder(alice)
    res = alice.post(f"/folders/{folder['id']}", json={"name": "Geometry", "icon": "shapes", "color": "#388c46"}, headers=FETCH)
    assert res.get_json() == {"id": folder["id"], "name": "Geometry", "icon": "shapes", "color": "#388c46"}
    assert alice.post(f"/folders/{folder['id']}", json={"icon": "nope"}, headers=FETCH).status_code == 400
    assert alice.post(f"/folders/{folder['id']}", json={"color": "#123456"}, headers=FETCH).status_code == 400
    assert alice.post(f"/folders/{folder['id']}", json={"name": ""}, headers=FETCH).status_code == 400
    res = alice.post(f"/folders/{folder['id']}", json={"color": "#000000"}, headers=FETCH)
    assert res.get_json()["name"] == "Geometry" and res.get_json()["color"] == "#000000"


def test_folder_endpoints_require_fetch_header(alice, graph_id):
    folder = make_folder(alice)
    assert alice.post("/folders", json={"name": "x"}).status_code == 403
    assert alice.post(f"/folders/{folder['id']}", json={"name": "x"}).status_code == 403
    assert alice.post(f"/folders/{folder['id']}/delete").status_code == 403
    assert alice.post(f"/graphs/{graph_id}/folder", json={"folder_id": folder["id"]}).status_code == 403
    assert alice.post("/graphs", data={"folder_id": folder["id"]}).status_code == 403


def test_folder_ownership(app, alice, bob, graph_id):
    folder = make_folder(alice)
    bob_folder = make_folder(bob, "Bob's")
    bob_graph = new_graph(bob)
    assert bob.get(f"/folders/{folder['id']}").status_code == 404
    assert bob.post(f"/folders/{folder['id']}", json={"name": "Mine"}, headers=FETCH).status_code == 404
    assert bob.post(f"/folders/{folder['id']}/delete", headers=FETCH).status_code == 404
    assert move(bob, graph_id, bob_folder["id"]).status_code == 404
    assert move(bob, bob_graph, folder["id"]).status_code == 404
    assert move(alice, graph_id, bob_folder["id"]).status_code == 404
    assert bob.post("/graphs", data={"folder_id": folder["id"]}, headers={"Origin": ORIGIN}).status_code == 404
    assert alice.get("/folders/not-a-uuid").status_code == 404
    assert move(alice, graph_id, 7).status_code == 404
    assert rows(app, "SELECT name FROM folders WHERE id = ?", folder["id"]) == [("Algebra",)]
    assert "Bob&#39;s" not in alice.get("/").get_data(as_text=True)
    assert rows(app, "SELECT COUNT(*) FROM graph_placements") == [(0,)]


def test_place_move_and_remove(app, alice, graph_id):
    algebra = make_folder(alice)
    calculus = make_folder(alice, "Calculus")
    assert move(alice, graph_id, algebra["id"]).get_json() == {"folder_id": algebra["id"]}
    assert placement(app, alice.user_id, graph_id) == algebra["id"]
    assert move(alice, graph_id, calculus["id"]).status_code == 200
    assert rows(app, "SELECT folder_id FROM graph_placements") == [(calculus["id"],)]
    page = alice.get(f"/folders/{calculus['id']}").get_data(as_text=True)
    assert f'data-id="{graph_id}" data-folder="{calculus["id"]}"' in page
    assert "<title>Calculus - math</title>" in page
    assert move(alice, graph_id, None).get_json() == {"folder_id": None}
    assert placement(app, alice.user_id, graph_id) is None
    assert alice.post(f"/graphs/{graph_id}/folder", json={}, headers=FETCH).status_code == 400


def test_folder_view_hides_graphs_outside_folder(alice, graph_id):
    folder = make_folder(alice)
    other = new_graph(alice)
    move(alice, graph_id, folder["id"])
    page = alice.get(f"/folders/{folder['id']}").get_data(as_text=True)
    assert f'data-id="{other}" data-folder="" data-title="untitled graph (2)" draggable="true" hidden' in page
    assert f'data-id="{graph_id}" data-folder="{folder["id"]}" data-title="untitled graph" draggable="true">' in page


def test_delete_folder_keeps_graphs(app, alice, graph_id):
    folder = make_folder(alice)
    move(alice, graph_id, folder["id"])
    assert alice.post(f"/folders/{folder['id']}/delete", headers=FETCH).get_json() == {"ok": True}
    assert rows(app, "SELECT COUNT(*) FROM folders") == [(0,)]
    assert rows(app, "SELECT COUNT(*) FROM graph_placements") == [(0,)]
    assert rows(app, "SELECT deleted_at FROM graphs WHERE id = ?", graph_id) == [(None,)]
    assert alice.get(f"/calculator/{graph_id}").status_code == 200
    assert alice.get(f"/folders/{folder['id']}").status_code == 404


def test_new_graph_in_folder(app, alice):
    folder = make_folder(alice)
    graph_id = new_graph(alice, folder["id"])
    assert placement(app, alice.user_id, graph_id) == folder["id"]
    plain = new_graph(alice)
    assert placement(app, alice.user_id, plain) is None
    res = alice.post("/graphs", data={"folder_id": str(uuid.uuid4())}, headers={"Origin": ORIGIN})
    assert res.status_code == 404
    assert rows(app, "SELECT COUNT(*) FROM graphs") == [(2,)]


def test_shared_view_is_empty(alice, graph_id):
    page = alice.get("/shared").get_data(as_text=True)
    assert "<title>Shared with you - math</title>" in page
    assert f'data-id="{graph_id}"' in page and "Nothing shared with you yet" in page
