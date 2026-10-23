import json

import pytest
from pycrdt import Doc, Map
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import realtime
from asgi import app as asgi_app
from realtime import ACK_MESSAGE, Reader, awareness_message, role_message, sync_message
from tests.conftest import FETCH, ORIGIN, make_user
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


def test_role_message_format():
    assert Reader(role_message("viewer")[1:]).string() == "viewer"
    with pytest.raises(realtime.ProtocolError):
        Reader(b"\xff").uint()
