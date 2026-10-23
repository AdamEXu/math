import json

import pytest
from pycrdt import Doc, Map
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import realtime
from asgi import app as asgi_app
from realtime import ACK_MESSAGE, Reader, awareness_message, role_message, sync_message
from tests.conftest import FETCH, ORIGIN, make_user, new_graph
from tests.test_graphs import Writer, post_updates, rows


OPEN = []


@pytest.fixture
def server(app):
    with TestClient(asgi_app, base_url=ORIGIN) as client:
        try:
            yield client
        finally:
            while OPEN:
                OPEN[-1].close()
    assert realtime._rooms == {}


def cookie(app, user_id):
    return app.session_interface.get_signing_serializer(app).dumps({"user_id": user_id, "_permanent": True})


class Peer:
    def __init__(self, server, app, graph_id, user_id, origin=ORIGIN):
        headers = {"origin": origin}
        if user_id:
            headers["cookie"] = f"session={cookie(app, user_id)}"
        self.socket = server.websocket_connect(f"/ws/graphs/{graph_id}", headers=headers)
        self.ws = self.socket.__enter__()
        self.doc = Doc()
        self.pending = []
        OPEN.append(self)

    def close(self):
        if self in OPEN:
            OPEN.remove(self)
            try:
                self.socket.__exit__(None, None, None)
            except Exception:
                pass

    def recv(self):
        if self.pending:
            return self.pending.pop(0)
        data = self.ws.receive_bytes()
        reader = Reader(data)
        kind = reader.uint()
        if kind == realtime.MESSAGE_SYNC:
            return ("sync", reader.uint(), reader.bytes())
        if kind == realtime.MESSAGE_AWARENESS:
            body = Reader(reader.bytes())
            return ("awareness", [(body.uint(), body.uint(), json.loads(body.string())) for _ in range(body.uint())])
        if kind == realtime.MESSAGE_ROLE:
            return ("role", reader.string())
        return ("ack",) if data == ACK_MESSAGE else ("unknown", data)

    def handshake(self, role):
        assert self.recv() == ("role", role)
        kind, step, state_vector = self.recv()
        assert (kind, step) == ("sync", realtime.SYNC_STEP1)
        self.ws.send_bytes(sync_message(realtime.SYNC_STEP1, self.doc.get_state()))
        early = []
        while (message := self.recv())[:2] != ("sync", realtime.SYNC_STEP2):
            early.append(message)
        self.doc.apply_update(message[2])
        self.pending = early + self.pending
        return state_vector

    def edit(self, fn):
        before = self.doc.get_state()
        with self.doc.transaction():
            fn(self.doc.get("meta", type=Map))
        update = self.doc.get_update(before)
        self.ws.send_bytes(sync_message(realtime.SYNC_UPDATE, update))
        return update

    def receive_update(self):
        kind, step, update = self.recv()
        assert (kind, step) == ("sync", realtime.SYNC_UPDATE)
        self.doc.apply_update(update)

    def title(self):
        return str(self.doc.get("meta", type=Map)["title"])


def share(alice, graph_id, handle, role):
    res = alice.post(f"/api/graphs/{graph_id}/members", json={"user": handle, "role": role}, headers=FETCH)
    assert res.status_code == 200


def set_title(meta, value):
    title = meta["title"]
    del title[:]
    title += value


def close_code(peer):
    with pytest.raises(WebSocketDisconnect) as info:
        peer.recv()
    peer.close()
    return info.value.code


def test_rejects_foreign_origin(server, app, alice, graph_id):
    with pytest.raises(WebSocketDisconnect) as info:
        Peer(server, app, graph_id, alice.user_id, origin="https://evil.example")
    assert info.value.code == realtime.CLOSE_FORBIDDEN


def test_rejects_signed_out_and_strangers(server, app, bob, graph_id):
    assert close_code(Peer(server, app, graph_id, None)) == realtime.CLOSE_UNAUTHORIZED
    assert close_code(Peer(server, app, graph_id, bob.user_id)) == realtime.CLOSE_NOT_FOUND
    with pytest.raises(WebSocketDisconnect) as info:
        Peer(server, app, "not-a-uuid", bob.user_id)
    assert info.value.code == realtime.CLOSE_NOT_FOUND
    no_handle = make_user(app, "new@pinewood.edu")
    assert close_code(Peer(server, app, graph_id, no_handle)) == realtime.CLOSE_UNAUTHORIZED


def test_sync_handshake_and_live_edits_are_logged_with_author(server, app, alice, bob, graph_id):
    share(alice, graph_id, "bob", "editor")
    a = Peer(server, app, graph_id, alice.user_id)
    b = Peer(server, app, graph_id, bob.user_id)
    a.handshake("owner")
    b.handshake("editor")
    assert a.title() == b.title() == "Untitled Graph"

    a.edit(lambda m: set_title(m, "Shared"))
    assert a.recv() == ("ack",)
    b.receive_update()
    assert b.title() == "Shared"

    update = b.edit(lambda m: m["title"].insert(6, "!"))
    assert b.recv() == ("ack",)
    a.receive_update()
    assert a.title() == "Shared!"

    b.ws.send_bytes(sync_message(realtime.SYNC_UPDATE, update))
    assert b.recv() == ("ack",)
    authors = rows(app, "SELECT author_id FROM updates WHERE graph_id = ? ORDER BY seq", graph_id)
    assert authors == [(alice.user_id,), (alice.user_id,), (bob.user_id,)]
    assert alice.get(f"/api/graphs/{graph_id}").get_json()["title"] == "Shared!"
    a.close()
    b.close()


def test_offline_edits_sync_on_reconnect_via_step2(server, app, alice, graph_id):
    a = Peer(server, app, graph_id, alice.user_id)
    a.handshake("owner")
    a.close()
    offline = a.doc
    before = offline.get_state()
    with offline.transaction():
        set_title(offline.get("meta", type=Map), "Offline edit")

    again = Peer(server, app, graph_id, alice.user_id)
    again.doc = offline
    server_state = again.handshake("owner")
    again.ws.send_bytes(sync_message(realtime.SYNC_STEP2, offline.get_update(server_state)))
    assert again.recv() == ("ack",)
    assert alice.get(f"/api/graphs/{graph_id}").get_json()["title"] == "Offline edit"
    again.ws.send_bytes(sync_message(realtime.SYNC_STEP2, offline.get_update(before)))
    assert again.recv() == ("ack",)
    assert rows(app, "SELECT COUNT(*) FROM updates WHERE graph_id = ?", graph_id) == [(2,)]
    again.close()


def test_concurrent_typing_in_the_same_text_converges(server, app, alice, bob, graph_id):
    share(alice, graph_id, "bob", "editor")
    a = Peer(server, app, graph_id, alice.user_id)
    b = Peer(server, app, graph_id, bob.user_id)
    a.handshake("owner")
    b.handshake("editor")
    a.edit(lambda m: set_title(m, "y=x"))
    assert a.recv() == ("ack",)
    b.receive_update()

    a.edit(lambda m: m["title"].insert(3, "^2"))
    b.edit(lambda m: m["title"].insert(2, "2"))
    for peer in (a, b):
        received = sorted([peer.recv(), peer.recv()], key=lambda message: message[0])
        assert received[0] == ("ack",) and received[1][:2] == ("sync", realtime.SYNC_UPDATE)
        peer.doc.apply_update(received[1][2])
    assert a.title() == b.title() == "y=2x^2"

    fresh = Doc()
    fresh.apply_update(alice.get(f"/api/graphs/{graph_id}/doc").data)
    assert str(fresh.get("meta", type=Map)["title"]) == "y=2x^2"
    a.close()
    b.close()


def test_viewer_updates_are_ignored_until_promoted(server, app, alice, bob, graph_id):
    share(alice, graph_id, "bob", "viewer")
    b = Peer(server, app, graph_id, bob.user_id)
    b.handshake("viewer")
    b.edit(lambda m: set_title(m, "Vandalized"))
    b.ws.send_bytes(sync_message(realtime.SYNC_STEP1, b.doc.get_state()))
    assert b.recv()[:2] == ("sync", realtime.SYNC_STEP2)
    assert rows(app, "SELECT COUNT(*) FROM updates WHERE graph_id = ?", graph_id) == [(1,)]

    res = alice.patch(f"/api/graphs/{graph_id}/members/{bob.user_id}", json={"role": "editor"}, headers=FETCH)
    assert res.status_code == 200
    assert b.recv() == ("role", "editor")
    b.edit(lambda m: m["title"].insert(0, "!"))
    assert b.recv() == ("ack",)
    assert rows(app, "SELECT COUNT(*) FROM updates WHERE graph_id = ?", graph_id) == [(2,)]

    alice.delete(f"/api/graphs/{graph_id}/members/{bob.user_id}", headers=FETCH)
    assert close_code(b) == realtime.CLOSE_FORBIDDEN


def test_link_access_change_and_delete_reach_open_sockets(server, app, alice, bob, graph_id):
    alice.put(f"/api/graphs/{graph_id}/link", json={"access": "viewer"}, headers=FETCH)
    b = Peer(server, app, graph_id, bob.user_id)
    b.handshake("viewer")
    alice.put(f"/api/graphs/{graph_id}/link", json={"access": "editor"}, headers=FETCH)
    assert b.recv() == ("role", "editor")
    a = Peer(server, app, graph_id, alice.user_id)
    a.handshake("owner")
    alice.delete(f"/api/graphs/{graph_id}", headers=FETCH)
    assert close_code(a) == realtime.CLOSE_FORBIDDEN
    assert close_code(b) == realtime.CLOSE_FORBIDDEN


def test_http_updates_are_broadcast_to_sockets(server, app, alice, graph_id):
    a = Peer(server, app, graph_id, alice.user_id)
    a.handshake("owner")
    writer = Writer(alice, graph_id)
    assert post_updates(alice, graph_id, [writer.edit(lambda m: set_title(m, "From HTTP"))]).status_code == 200
    a.receive_update()
    assert a.title() == "From HTTP"
    a.close()


def awareness(client_id, clock, state):
    return awareness_message([(client_id, clock, json.dumps(state))])


def test_awareness_is_relayed_with_server_identity(server, app, alice, bob, graph_id):
    share(alice, graph_id, "bob", "viewer")
    a = Peer(server, app, graph_id, alice.user_id)
    a.handshake("owner")
    a.ws.send_bytes(awareness(11, 1, {"selected": "3", "user": {"name": "Mallory"}}))
    b = Peer(server, app, graph_id, bob.user_id)
    b.handshake("viewer")
    kind, entries = b.recv()
    assert kind == "awareness"
    [(client_id, clock, state)] = entries
    assert (client_id, clock, state["selected"]) == (11, 1, "3")
    assert state["user"]["id"] == alice.user_id and state["user"]["name"] == "Alice"
    assert "email" not in state["user"]

    b.ws.send_bytes(awareness(11, 5, {"selected": "hijack"}))
    b.ws.send_bytes(awareness(22, 1, {"selected": None}))
    kind, [(client_id, _, state)] = a.recv()
    assert client_id == 22 and state["user"]["id"] == bob.user_id

    a.close()
    kind, [(client_id, clock, state)] = b.recv()
    assert (kind, client_id, clock, state) == ("awareness", 11, 2, None)
    b.close()


def test_only_editors_broadcast_cursors(server, app, alice, bob, graph_id):
    share(alice, graph_id, "bob", "viewer")
    a = Peer(server, app, graph_id, alice.user_id)
    a.handshake("owner")
    b = Peer(server, app, graph_id, bob.user_id)
    b.handshake("viewer")
    cursor = {"cursor": {"kind": "graph", "x": 1, "y": 2}, "pressed": True, "editing": "3", "caret": {"id": "3"}}
    cursor["live"] = {"3": {"latex": "a=1"}}

    b.ws.send_bytes(awareness(22, 1, {"selected": "1", **cursor}))
    kind, [(_, _, state)] = a.recv()
    assert kind == "awareness" and state["selected"] == "1"
    assert not {"cursor", "pressed", "editing", "caret", "live"} & state.keys()

    a.ws.send_bytes(awareness(11, 1, cursor))
    kind, [(_, _, state)] = b.recv()
    assert state["cursor"] == cursor["cursor"] and state["caret"] == {"id": "3"}
    assert state["live"] == {"3": {"latex": "a=1"}}
    a.close()
    b.close()


def test_role_message_format():
    assert Reader(role_message("viewer")[1:]).string() == "viewer"
    with pytest.raises(realtime.ProtocolError):
        Reader(b"\xff").uint()


class Feed:
    def __init__(self, server, app, user_id, origin=ORIGIN):
        headers = {"origin": origin, "cookie": f"session={cookie(app, user_id)}"}
        self.socket = server.websocket_connect("/ws/presence", headers=headers)
        self.ws = self.socket.__enter__()
        OPEN.append(self)

    def watch(self, *graph_ids):
        self.ws.send_text(json.dumps({"watch": list(graph_ids)}))

    def recv(self):
        return {graph_id: [user["handle"] for user in users] for graph_id, users in self.ws.receive_json()["presence"].items()}

    close = Peer.close


def test_room_presence_is_per_user_across_tabs(server, app, alice, bob, graph_id):
    share(alice, graph_id, "bob", "editor")
    tabs = [Peer(server, app, graph_id, bob.user_id) for _ in range(2)]
    for tab in tabs:
        tab.handshake("editor")
    owner = Peer(server, app, graph_id, alice.user_id)
    owner.handshake("owner")
    assert [user["handle"] for user in realtime.graph_users(graph_id)] == ["bob", "alice"]
    tabs[0].close()
    assert [user["handle"] for user in realtime.graph_users(graph_id)] == ["bob", "alice"]
    tabs[1].close()
    owner.ws.send_bytes(sync_message(realtime.SYNC_STEP1, owner.doc.get_state()))
    while owner.recv()[0] != "sync":
        pass
    assert [user["handle"] for user in realtime.graph_users(graph_id)] == ["alice"]
    owner.close()


def test_library_presence_feed(server, app, alice, bob, graph_id):
    share(alice, graph_id, "bob", "viewer")
    hidden = new_graph(bob)
    feed = Feed(server, app, alice.user_id)
    feed.watch(graph_id, hidden, "garbage-id")
    feed.watch(graph_id, hidden)
    assert feed.recv() == {graph_id: []}

    mine = Peer(server, app, graph_id, alice.user_id)
    mine.handshake("owner")
    assert feed.recv() == {graph_id: []}
    tabs = [Peer(server, app, graph_id, bob.user_id) for _ in range(2)]
    for tab in tabs:
        tab.handshake("viewer")
    assert feed.recv() == {graph_id: ["bob"]}
    assert feed.recv() == {graph_id: ["bob"]}
    elsewhere = Peer(server, app, hidden, bob.user_id)
    elsewhere.handshake("owner")
    tabs[0].close()
    assert feed.recv() == {graph_id: ["bob"]}
    tabs[1].close()
    assert feed.recv() == {graph_id: []}

    feed.watch()
    tabs.append(Peer(server, app, graph_id, bob.user_id))
    tabs[-1].handshake("viewer")
    feed.watch(graph_id)
    assert feed.recv() == {graph_id: ["bob"]}
    for peer in (mine, elsewhere, tabs[-1]):
        peer.close()
    feed.close()
    assert realtime._watchers == {}


def test_presence_feed_requires_sign_in_and_origin(server, app, alice):
    with pytest.raises(WebSocketDisconnect) as info:
        Feed(server, app, alice.user_id, origin="https://evil.example")
    assert info.value.code == realtime.CLOSE_FORBIDDEN
    socket = server.websocket_connect("/ws/presence", headers={"origin": ORIGIN})
    ws = socket.__enter__()
    with pytest.raises(WebSocketDisconnect) as info:
        ws.receive_text()
    assert info.value.code == realtime.CLOSE_UNAUTHORIZED
    socket.__exit__(None, None, None)


def test_ping_gets_pong_and_idle_sockets_are_dropped(server, app, alice, bob, graph_id, monkeypatch):
    share(alice, graph_id, "bob", "viewer")
    a = Peer(server, app, graph_id, alice.user_id)
    a.handshake("owner")
    a.ws.send_bytes(bytes([realtime.MESSAGE_PING]))
    assert a.ws.receive_bytes() == bytes([realtime.MESSAGE_PONG])
    a.close()

    monkeypatch.setattr(realtime, "IDLE_TIMEOUT", 0.2)
    b = Peer(server, app, graph_id, bob.user_id)
    b.handshake("viewer")
    assert close_code(b) == realtime.CLOSE_IDLE


def test_reconnect_exchanges_missing_edits_both_ways(server, app, alice, bob, graph_id):
    share(alice, graph_id, "bob", "editor")
    a = Peer(server, app, graph_id, alice.user_id)
    a.handshake("owner")
    a.edit(lambda m: set_title(m, "base"))
    assert a.recv() == ("ack",)
    a.close()

    offline = a.doc
    with offline.transaction():
        offline.get("meta", type=Map)["offline"] = "alice"

    b = Peer(server, app, graph_id, bob.user_id)
    b.handshake("editor")
    b.edit(lambda m: m["title"].insert(4, "!"))
    assert b.recv() == ("ack",)

    again = Peer(server, app, graph_id, alice.user_id)
    again.doc = offline
    server_state = again.handshake("owner")
    again.ws.send_bytes(sync_message(realtime.SYNC_STEP2, offline.get_update(server_state)))
    messages = [again.recv()]
    assert messages == [("ack",)]
    b.receive_update()
    assert again.title() == b.title() == "base!"
    assert b.doc.get("meta", type=Map)["offline"] == again.doc.get("meta", type=Map)["offline"] == "alice"
    authors = rows(app, "SELECT author_id FROM updates WHERE graph_id = ? ORDER BY seq", graph_id)
    assert authors == [(alice.user_id,), (alice.user_id,), (bob.user_id,), (alice.user_id,)]

    again.ws.send_bytes(sync_message(realtime.SYNC_STEP2, offline.get_update()))
    assert again.recv() == ("ack",)
    assert rows(app, "SELECT COUNT(*) FROM updates WHERE graph_id = ?", graph_id) == [(4,)]
    again.close()
    b.close()


def test_same_user_tabs_sync_as_independent_clients(server, app, alice, bob, graph_id):
    share(alice, graph_id, "bob", "editor")
    tabs = [Peer(server, app, graph_id, alice.user_id) for _ in range(2)]
    for tab in tabs:
        tab.handshake("owner")
    other = Peer(server, app, graph_id, bob.user_id)
    other.handshake("editor")

    tabs[0].edit(lambda meta: set_title(meta, "From tab one"))
    assert tabs[0].recv() == ("ack",)
    tabs[1].receive_update()
    assert tabs[1].title() == "From tab one"
    other.receive_update()

    cursor = {"cursor": {"kind": "graph", "x": 1, "y": 2}, "live": {"3": {"latex": "a=2"}}}
    tabs[0].ws.send_bytes(awareness(11, 1, cursor))
    tabs[1].ws.send_bytes(awareness(12, 1, {"cursor": {"kind": "graph", "x": 3, "y": 4}}))
    for peer, expected in ((tabs[1], [11]), (tabs[0], [12]), (other, [11, 12])):
        seen = []
        while len(seen) < len(expected):
            kind, entries = peer.recv()
            assert kind == "awareness"
            seen += [(client_id, state["user"]["id"]) for client_id, _, state in entries]
        assert seen == [(client_id, alice.user_id) for client_id in expected]

    tabs[0].close()
    for peer in (tabs[1], other):
        kind, [(client_id, clock, state)] = peer.recv()
        assert (kind, client_id, clock, state) == ("awareness", 11, 2, None)
    assert [user["handle"] for user in realtime.graph_users(graph_id)] == ["alice", "bob"]
    tabs[1].close()
    other.close()


def test_reconnecting_tab_reclaims_its_awareness_from_a_stale_socket(server, app, alice, bob, graph_id):
    share(alice, graph_id, "bob", "editor")
    stale = Peer(server, app, graph_id, alice.user_id)
    stale.handshake("owner")
    watcher = Peer(server, app, graph_id, bob.user_id)
    watcher.handshake("editor")
    stale.ws.send_bytes(awareness(11, 1, {"selected": "old"}))
    assert watcher.recv()[1][0][:2] == (11, 1)

    fresh = Peer(server, app, graph_id, alice.user_id)
    fresh.handshake("owner")
    while fresh.recv()[0] != "awareness":
        pass
    fresh.ws.send_bytes(awareness(11, 3, {"selected": "new"}))
    kind, [(client_id, clock, state)] = watcher.recv()
    assert (kind, client_id, clock, state["selected"]) == ("awareness", 11, 3, "new")

    watcher.ws.send_bytes(awareness(11, 9, {"selected": "hijack"}))
    stale.close()
    fresh.ws.send_bytes(awareness(11, 4, {"selected": "still mine"}))
    kind, [(client_id, clock, state)] = watcher.recv()
    assert (kind, client_id, clock, state["selected"]) == ("awareness", 11, 4, "still mine")
    assert json.loads(realtime.live_room(graph_id).awareness[11][1])["selected"] == "still mine"
    fresh.close()
    watcher.close()


def test_rename_endpoint_applies_through_live_room(server, app, alice, bob, graph_id):
    share(alice, graph_id, "bob", "editor")
    a = Peer(server, app, graph_id, alice.user_id)
    a.handshake("owner")
    res = bob.put(f"/api/graphs/{graph_id}/title", json={"title": "Renamed"}, headers=FETCH)
    assert res.status_code == 200 and res.get_json()["title"] == "Renamed"
    a.receive_update()
    assert a.title() == "Renamed"
    assert str(realtime.live_room(graph_id).graph_doc.doc.get("meta", type=Map)["title"]) == "Renamed"
    assert rows(app, "SELECT author_id FROM updates WHERE graph_id = ? ORDER BY seq DESC LIMIT 1", graph_id) == [
        (bob.user_id,)
    ]
    assert rows(app, "SELECT title FROM graphs WHERE id = ?", graph_id) == [("Renamed",)]
    a.close()


def test_rename_endpoint_without_live_room_appends_to_log(server, app, alice, graph_id):
    assert realtime.live_room(graph_id) is None
    assert alice.put(f"/api/graphs/{graph_id}/title", json={"title": "Offline"}, headers=FETCH).status_code == 200
    assert realtime.live_room(graph_id) is None
    a = Peer(server, app, graph_id, alice.user_id)
    a.handshake("owner")
    assert a.title() == "Offline"
    a.close()
