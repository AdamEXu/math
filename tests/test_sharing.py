import pytest
from pycrdt import Text

from tests.conftest import FETCH, make_user, signed_in
from tests.test_graphs import PNG, Writer, graph_list, post_updates, rows


@pytest.fixture
def carol(app):
    return signed_in(app, "carol.jones@pinewood.edu", "carol")


def share(client, graph_id, user, role="viewer"):
    return client.post(f"/api/graphs/{graph_id}/members", json={"user": user, "role": role}, headers=FETCH)


def set_link(client, graph_id, access):
    return client.put(f"/api/graphs/{graph_id}/link", json={"access": access}, headers=FETCH)


def rename(client, graph_id, title):
    return post_updates(client, graph_id, [Writer(client, graph_id).edit(lambda m: m.__setitem__("title", Text(title)))])


def listed(client):
    return {graph["id"]: graph for graph in graph_list(client)}


def test_owner_shares_by_handle_and_viewer_can_only_read(app, alice, bob, graph_id):
    res = share(alice, graph_id, "@Bob")
    assert res.status_code == 200
    body = res.get_json()
    assert body["role"] == "owner" and body["link_access"] is None
    assert [(m["handle"], m["role"]) for m in body["members"]] == [("bob", "viewer")]
    assert all("email" not in m for m in body["members"]) and "email" not in body["owner"]

    assert bob.get(f"/api/graphs/{graph_id}").get_json()["role"] == "viewer"
    assert bob.get(f"/api/graphs/{graph_id}/doc").status_code == 200
    assert rename(bob, graph_id, "Nope").status_code == 403
    assert bob.post(f"/api/graphs/{graph_id}/thumbnail", data=PNG, headers=FETCH).status_code == 403
    assert bob.delete(f"/api/graphs/{graph_id}", headers=FETCH).status_code == 403
    assert alice.post(f"/api/graphs/{graph_id}/thumbnail", data=PNG, headers=FETCH).status_code == 200
    assert bob.get(f"/graphs/{graph_id}/thumbnail.png").data == PNG

    shared = listed(bob)[graph_id]
    assert shared["role"] == "viewer" and shared["owner"]["handle"] == "alice"
    assert listed(alice)[graph_id]["role"] == "owner"


def test_viewer_sees_members_but_cannot_manage(app, alice, bob, carol, graph_id):
    share(alice, graph_id, "bob")
    share(alice, graph_id, "carol", "editor")
    sharing = bob.get(f"/api/graphs/{graph_id}/sharing").get_json()
    assert sharing["role"] == "viewer" and [m["handle"] for m in sharing["members"]] == ["bob", "carol"]
    for client in (bob, carol):
        assert share(client, graph_id, "dave@pinewood.edu").status_code == 403
        assert set_link(client, graph_id, "viewer").status_code == 403
        other = alice.user_id if client is bob else bob.user_id
        assert client.patch(f"/api/graphs/{graph_id}/members/{other}", json={"role": "editor"}, headers=FETCH).status_code == 403
        assert client.delete(f"/api/graphs/{graph_id}/members/{carol.user_id if client is bob else bob.user_id}", headers=FETCH).status_code == 403
    assert len(alice.get(f"/api/graphs/{graph_id}/sharing").get_json()["members"]) == 2


def test_editor_can_edit_and_rename_but_not_delete(app, alice, carol, graph_id):
    share(alice, graph_id, "carol.jones@pinewood.edu", "editor")
    assert carol.get(f"/api/graphs/{graph_id}").get_json()["role"] == "editor"
    assert rename(carol, graph_id, "Carol's edit").status_code == 200
    assert alice.get(f"/api/graphs/{graph_id}").get_json()["title"] == "Carol's edit"
    authors = rows(app, "SELECT author_id FROM updates WHERE graph_id = ? ORDER BY seq", graph_id)
    assert authors == [(alice.user_id,), (carol.user_id,)]
    assert carol.post(f"/api/graphs/{graph_id}/thumbnail", data=PNG, headers=FETCH).status_code == 200
    assert carol.delete(f"/api/graphs/{graph_id}", headers=FETCH).status_code == 403
    assert alice.delete(f"/api/graphs/{graph_id}", headers=FETCH).status_code == 200
    assert carol.get(f"/api/graphs/{graph_id}").status_code == 404
    assert graph_id not in listed(carol)


@pytest.mark.parametrize(
    "user,message",
    [
        ("someone@gmail.com", "Only pinewood.edu accounts can be added."),
        ("ghost@pinewood.edu", "No one with that handle or email has signed in yet."),
        ("@ghost", "No one with that handle or email has signed in yet."),
        ("", "No one with that handle or email has signed in yet."),
        ("alice", "You already own this graph."),
    ],
)
def test_add_member_errors(alice, graph_id, user, message):
    res = share(alice, graph_id, user)
    assert res.status_code == 400 and res.get_json() == {"error": message}


def test_add_member_requires_valid_role_and_fetch_header(alice, bob, graph_id):
    assert share(alice, graph_id, "bob", "owner").status_code == 400
    assert alice.post(f"/api/graphs/{graph_id}/members", json={"user": "bob", "role": "viewer"}).status_code == 403
    assert alice.put(f"/api/graphs/{graph_id}/link", json={"access": "viewer"}).status_code == 403
    assert alice.delete(f"/api/graphs/{graph_id}/members/{bob.user_id}").status_code == 403


def test_resharing_changes_role_and_patch_and_remove(app, alice, bob, graph_id):
    share(alice, graph_id, "bob")
    body = share(alice, graph_id, "bob", "editor").get_json()
    assert [(m["handle"], m["role"]) for m in body["members"]] == [("bob", "editor")]
    res = alice.patch(f"/api/graphs/{graph_id}/members/{bob.user_id}", json={"role": "viewer"}, headers=FETCH)
    assert res.get_json()["members"][0]["role"] == "viewer"
    assert alice.patch(f"/api/graphs/{graph_id}/members/{alice.user_id}", json={"role": "viewer"}, headers=FETCH).status_code == 404

    folder = bob.post("/api/folders", json={"name": "From Alice"}, headers=FETCH).get_json()
    assert bob.put(f"/api/graphs/{graph_id}/folder", json={"folder_id": folder["id"]}, headers=FETCH).status_code == 200
    assert listed(bob)[graph_id]["folder_id"] == folder["id"]
    assert listed(alice)[graph_id]["folder_id"] is None

    res = alice.delete(f"/api/graphs/{graph_id}/members/{bob.user_id}", headers=FETCH)
    assert res.status_code == 200 and res.get_json()["members"] == []
    assert bob.get(f"/api/graphs/{graph_id}").status_code == 404
    assert graph_id not in listed(bob)
    assert rows(app, "SELECT COUNT(*) FROM graph_placements WHERE user_id = ?", bob.user_id) == [(0,)]


def test_member_can_leave_but_owner_cannot(alice, bob, graph_id):
    share(alice, graph_id, "bob", "editor")
    res = bob.delete(f"/api/graphs/{graph_id}/members/{bob.user_id}", headers=FETCH)
    assert res.status_code == 200 and res.get_json() == {"ok": True}
    assert graph_id not in listed(bob)
    res = alice.delete(f"/api/graphs/{graph_id}/members/{alice.user_id}", headers=FETCH)
    assert res.status_code == 400


def test_link_sharing_viewer_then_editor_then_restricted(app, alice, carol, graph_id):
    assert carol.get(f"/api/graphs/{graph_id}").status_code == 404
    assert set_link(alice, graph_id, "viewer").get_json()["link_access"] == "viewer"

    assert carol.get(f"/api/graphs/{graph_id}").get_json()["role"] == "viewer"
    assert graph_id not in listed(carol)
    assert carol.get(f"/api/graphs/{graph_id}/doc").status_code == 200
    assert listed(carol)[graph_id]["role"] == "viewer"
    assert rename(carol, graph_id, "Nope").status_code == 403
    assert carol.get(f"/api/graphs/{graph_id}/sharing").get_json()["members"] == []

    set_link(alice, graph_id, "editor")
    assert listed(carol)[graph_id]["role"] == "editor"
    assert rename(carol, graph_id, "Linked edit").status_code == 200

    assert set_link(alice, graph_id, None).get_json()["link_access"] is None
    assert carol.get(f"/api/graphs/{graph_id}").status_code == 404
    assert graph_id not in listed(carol)
    set_link(alice, graph_id, "viewer")
    assert listed(carol)[graph_id]["role"] == "viewer"

    res = carol.delete(f"/api/graphs/{graph_id}/members/{carol.user_id}", headers=FETCH)
    assert res.get_json() == {"ok": True}
    assert graph_id not in listed(carol)
    assert carol.get(f"/api/graphs/{graph_id}").status_code == 200


def test_link_access_validation(alice, graph_id):
    assert set_link(alice, graph_id, "owner").status_code == 400
    assert alice.put(f"/api/graphs/{graph_id}/link", json={}, headers=FETCH).status_code == 400


def test_member_role_and_link_role_take_the_higher(alice, bob, graph_id):
    share(alice, graph_id, "bob", "viewer")
    set_link(alice, graph_id, "editor")
    assert bob.get(f"/api/graphs/{graph_id}").get_json()["role"] == "editor"
    set_link(alice, graph_id, None)
    assert bob.get(f"/api/graphs/{graph_id}").get_json()["role"] == "viewer"


def test_strangers_get_404_on_sharing_endpoints(alice, bob, graph_id):
    assert bob.get(f"/api/graphs/{graph_id}/sharing").status_code == 404
    assert share(bob, graph_id, "bob").status_code == 404
    assert set_link(bob, graph_id, "viewer").status_code == 404
    assert bob.delete(f"/api/graphs/{graph_id}/members/{bob.user_id}", headers=FETCH).status_code == 404


def search(client, q):
    res = client.get("/api/users/search", query_string={"q": q})
    assert res.status_code == 200
    return res.get_json()["users"]


def test_user_search_never_reveals_emails(app, alice, bob, carol):
    make_user(app, "nohandle@pinewood.edu")
    assert [u["handle"] for u in search(alice, "bo")] == ["bob"]
    assert [u["handle"] for u in search(alice, "@car")] == ["carol"]
    assert [u["handle"] for u in search(alice, "jon")] == ["carol"]
    assert [u["handle"] for u in search(alice, "carol.j")] == ["carol"]
    assert search(alice, "al") == []
    assert search(alice, "") == [] and search(alice, "%") == [] and search(alice, "_") == []
    assert search(alice, "nohandle") == []
    exact = search(alice, "NoHandle@pinewood.edu")
    assert len(exact) == 1 and exact[0]["handle"] is None
    assert search(alice, "bob@pinewood.ed") == []
    for user in search(alice, "c") + exact:
        assert set(user) == {"id", "handle", "display_name", "avatar_url", "avatar_hue", "avatar_initial"}
    assert app.test_client().get("/api/users/search?q=bo").status_code == 401
