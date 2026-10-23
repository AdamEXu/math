import asyncio
import json
import logging
import uuid
from functools import partial

import anyio
from starlette.websockets import WebSocket

from access import GRAPH_ACCESS_QUERY, LISTED, at_least, graph_role
from auth import allowed_origins
from db import get_db, now_ms
from docstore import GraphDoc, graph_lock
from users import get_user, public_user_json

MESSAGE_SYNC = 0
MESSAGE_AWARENESS = 1
MESSAGE_ACK = 4
MESSAGE_ROLE = 5
MESSAGE_PING = 6
MESSAGE_PONG = 7
SYNC_STEP1 = 0
SYNC_STEP2 = 1
SYNC_UPDATE = 2

CLOSE_ERROR = 1011
CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_NOT_FOUND = 4404
CLOSE_TOO_SLOW = 4408
CLOSE_IDLE = 4000

MAX_QUEUED = 2000
MAX_AWARENESS_BYTES = 16 << 10
MAX_WATCHED = 2000
IDLE_TIMEOUT = 45

log = logging.getLogger(__name__)
_rooms = {}
_watchers = {}


class ProtocolError(Exception):
    pass


class Reader:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def uint(self):
        value = shift = 0
        while True:
            if self.pos >= len(self.data) or shift > 63:
                raise ProtocolError
            byte = self.data[self.pos]
            self.pos += 1
            value |= (byte & 0x7F) << shift
            shift += 7
            if byte < 0x80:
                return value

    def bytes(self):
        length = self.uint()
        end = self.pos + length
        if end > len(self.data):
            raise ProtocolError
        value = self.data[self.pos : end]
        self.pos = end
        return value

    def string(self):
        try:
            return self.bytes().decode()
        except UnicodeDecodeError as error:
            raise ProtocolError from error


def uint(value):
    out = bytearray()
    while value > 0x7F:
        out.append(0x80 | (value & 0x7F))
        value >>= 7
    out.append(value)
    return bytes(out)


def var_bytes(data):
    return uint(len(data)) + data


def sync_message(step, payload):
    return bytes([MESSAGE_SYNC, step]) + var_bytes(payload)


def awareness_message(entries):
    body = uint(len(entries)) + b"".join(
        uint(client_id) + uint(clock) + var_bytes(state.encode()) for client_id, clock, state in entries
    )
    return bytes([MESSAGE_AWARENESS]) + var_bytes(body)


def role_message(role):
    return bytes([MESSAGE_ROLE]) + var_bytes(role.encode())


ACK_MESSAGE = bytes([MESSAGE_ACK])
PONG_MESSAGE = bytes([MESSAGE_PONG])


class Peer:
    def __init__(self, websocket, user, role):
        self.websocket = websocket
        self.user_id = user["id"]
        self.presence = {**public_user_json(user), "name": user["display_name"]}
        self.role = role
        self.client_ids = set()
        self.queue = asyncio.Queue()
        self.closing = False

    def send(self, message):
        if self.closing:
            return
        if self.queue.qsize() >= MAX_QUEUED:
            self.close(CLOSE_TOO_SLOW)
            return
        self.queue.put_nowait(message)

    def close(self, code):
        if not self.closing:
            self.closing = True
            self.queue.put_nowait(code)

    def set_role(self, role):
        if role is None:
            self.close(CLOSE_FORBIDDEN)
        elif role != self.role:
            self.role = role
            self.send(role_message(role))

    async def pump(self):
        while True:
            item = await self.queue.get()
            if isinstance(item, int):
                await self.websocket.close(item)
                return
            await self.websocket.send_bytes(item)


class Room:
    def __init__(self, graph_doc, loop):
        self.graph_id = graph_doc.graph_id
        self.graph_doc = graph_doc
        self.loop = loop
        self.peers = {}
        self.awareness = {}

    def users(self):
        seen = {}
        for peer in list(self.peers):
            seen.setdefault(peer.user_id, peer.presence)
        return list(seen.values())

    def broadcast(self, message, sender=None):
        for peer in list(self.peers):
            if peer is not sender:
                peer.send(message)

    def broadcast_updates(self, deltas):
        for delta in deltas:
            self.loop.call_soon_threadsafe(self.broadcast, sync_message(SYNC_UPDATE, delta))

    def awareness_snapshot(self):
        entries = [(client_id, clock, state) for client_id, (clock, state, _) in self.awareness.items()]
        return awareness_message(entries) if entries else None

    def update_awareness(self, peer, data):
        reader = Reader(data)
        entries = []
        for _ in range(reader.uint()):
            client_id, clock, raw = reader.uint(), reader.uint(), reader.string()
            current = self.awareness.get(client_id)
            if current is not None and current[2] is not peer:
                continue
            if current is None and client_id not in peer.client_ids and len(peer.client_ids) >= 4:
                continue
            try:
                state = json.loads(raw)
            except ValueError:
                continue
            if state is None:
                self.awareness.pop(client_id, None)
                peer.client_ids.discard(client_id)
                entries.append((client_id, clock, "null"))
                continue
            if not isinstance(state, dict):
                continue
            state["user"] = peer.presence
            encoded = json.dumps(state, separators=(",", ":"))
            self.awareness[client_id] = (clock, encoded, peer)
            peer.client_ids.add(client_id)
            entries.append((client_id, clock, encoded))
        if entries:
            self.broadcast(awareness_message(entries), sender=peer)

    def drop_awareness(self, peer):
        entries = []
        for client_id in peer.client_ids:
            current = self.awareness.pop(client_id, None)
            if current is not None:
                entries.append((client_id, current[0] + 1, "null"))
        peer.client_ids.clear()
        if entries:
            self.broadcast(awareness_message(entries), sender=peer)

    def close_all(self, code):
        for peer in list(self.peers):
            peer.close(code)


def live_room(graph_id):
    return _rooms.get(graph_id)


def discard(room):
    with graph_lock(room.graph_id):
        if _rooms.get(room.graph_id) is room:
            del _rooms[room.graph_id]
    room.loop.call_soon_threadsafe(room.close_all, CLOSE_ERROR)


def graph_users(graph_id):
    room = _rooms.get(graph_id)
    return room.users() if room else []


def notify_presence(graph_id):
    watchers = _watchers.get(graph_id)
    if watchers:
        message = {graph_id: graph_users(graph_id)}
        for watcher in list(watchers):
            watcher.push(message)


class Watcher:
    def __init__(self, websocket, user_id):
        self.websocket = websocket
        self.user_id = user_id
        self.graph_ids = set()
        self.queue = asyncio.Queue()

    def push(self, graphs):
        visible = {
            graph_id: [user for user in users if user["id"] != self.user_id] for graph_id, users in graphs.items()
        }
        if self.queue.qsize() < MAX_QUEUED:
            self.queue.put_nowait(json.dumps({"presence": visible}, separators=(",", ":")))

    def watch(self, graph_ids):
        for graph_id in self.graph_ids - graph_ids:
            watchers = _watchers.get(graph_id)
            if watchers:
                watchers.discard(self)
                if not watchers:
                    del _watchers[graph_id]
        added = graph_ids - self.graph_ids
        for graph_id in added:
            _watchers.setdefault(graph_id, set()).add(self)
        self.graph_ids = graph_ids
        if added:
            self.push({graph_id: graph_users(graph_id) for graph_id in added})

    async def pump(self):
        while True:
            await self.websocket.send_text(await self.queue.get())


def listed_graph_ids(user_id):
    rows = get_db().execute(GRAPH_ACCESS_QUERY + LISTED, {"user": user_id}).fetchall()
    return {row["id"] for row in rows}


def reauthorize(graph_id):
    room = _rooms.get(graph_id)
    if room is None:
        return
    db = get_db()
    roles = {peer: graph_role(db, graph_id, peer.user_id) for peer in list(room.peers)}

    def apply():
        for peer, role in roles.items():
            peer.set_role(role)

    room.loop.call_soon_threadsafe(apply)


def session_user_id(flask_app, cookies):
    value = cookies.get(flask_app.config["SESSION_COOKIE_NAME"])
    serializer = flask_app.session_interface.get_signing_serializer(flask_app)
    if not value or serializer is None:
        return None
    try:
        data = serializer.loads(value, max_age=int(flask_app.permanent_session_lifetime.total_seconds()))
    except Exception:
        return None
    return data.get("user_id") if isinstance(data, dict) else None


def signed_in_user(user_id):
    user = get_user(user_id) if user_id else None
    return user if user is not None and user["handle"] else None


def authorize(graph_id, user_id):
    user = signed_in_user(user_id)
    if user is None:
        return CLOSE_UNAUTHORIZED, None, None
    role = graph_role(get_db(), graph_id, user_id)
    if role is None:
        return CLOSE_NOT_FOUND, None, None
    return None, user, role


def join(graph_id, peer, loop):
    with graph_lock(graph_id):
        room = _rooms.get(graph_id)
        if room is None:
            room = Room(GraphDoc(get_db(), graph_id), loop)
            _rooms[graph_id] = room
        room.peers[peer] = None
        return room, room.graph_doc.state_vector()


def leave(room, peer):
    with graph_lock(room.graph_id):
        room.peers.pop(peer, None)
        if not room.peers and _rooms.get(room.graph_id) is room:
            del _rooms[room.graph_id]


def diff(room, state_vector):
    with graph_lock(room.graph_id):
        return room.graph_doc.diff(state_vector)


def apply_live(room, data, author_id):
    with graph_lock(room.graph_id):
        if _rooms.get(room.graph_id) is not room:
            raise ProtocolError
        try:
            return room.graph_doc.apply_live(get_db(), data, author_id, now_ms())
        except BaseException:
            del _rooms[room.graph_id]
            room.loop.call_soon_threadsafe(room.close_all, CLOSE_ERROR)
            raise


async def handle(room, peer, data, run):
    reader = Reader(data)
    kind = reader.uint()
    if kind == MESSAGE_SYNC:
        step = reader.uint()
        payload = reader.bytes()
        if step == SYNC_STEP1:
            peer.send(sync_message(SYNC_STEP2, await run(diff, room, payload)))
        elif step in (SYNC_STEP2, SYNC_UPDATE) and at_least(peer.role, "editor"):
            delta = await run(apply_live, room, payload, peer.user_id)
            if delta is not None:
                room.broadcast(sync_message(SYNC_UPDATE, delta), sender=peer)
            peer.send(ACK_MESSAGE)
    elif kind == MESSAGE_PING:
        peer.send(PONG_MESSAGE)
    elif kind == MESSAGE_AWARENESS:
        payload = reader.bytes()
        if len(payload) <= MAX_AWARENESS_BYTES:
            room.update_awareness(peer, payload)


def in_app(flask_app):
    async def run(fn, *args):
        def call():
            with flask_app.app_context():
                return fn(*args)

        return await anyio.to_thread.run_sync(call)

    return run


async def same_origin(websocket):
    if websocket.headers.get("origin") in allowed_origins():
        return True
    await websocket.close(CLOSE_FORBIDDEN)
    return False


def graph_socket(flask_app):
    run = in_app(flask_app)

    async def endpoint(websocket: WebSocket):
        if not await same_origin(websocket):
            return
        try:
            graph_id = str(uuid.UUID(websocket.path_params["graph_id"]))
        except ValueError:
            await websocket.close(CLOSE_NOT_FOUND)
            return
        await websocket.accept()
        error, user, role = await run(authorize, graph_id, session_user_id(flask_app, websocket.cookies))
        if error:
            await websocket.close(error)
            return

        peer = Peer(websocket, user, role)
        room, state_vector = await run(join, graph_id, peer, asyncio.get_running_loop())
        notify_presence(graph_id)
        pump = asyncio.create_task(peer.pump())
        try:
            peer.send(role_message(role))
            peer.send(sync_message(SYNC_STEP1, state_vector))
            snapshot = room.awareness_snapshot()
            if snapshot:
                peer.send(snapshot)
            while not peer.closing:
                try:
                    message = await asyncio.wait_for(websocket.receive(), IDLE_TIMEOUT)
                except TimeoutError:
                    peer.close(CLOSE_IDLE)
                    break
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes"):
                    await handle(room, peer, message["bytes"], run)
        except ProtocolError:
            peer.close(CLOSE_ERROR)
        except Exception:
            log.exception("graph socket failed")
            peer.close(CLOSE_ERROR)
        finally:
            room.drop_awareness(peer)
            await run(leave, room, peer)
            notify_presence(graph_id)
            if peer.closing:
                await asyncio.wait([pump], timeout=5)
            pump.cancel()

    return endpoint


def presence_socket(flask_app):
    run = in_app(flask_app)

    async def endpoint(websocket: WebSocket):
        if not await same_origin(websocket):
            return
        await websocket.accept()
        user = await run(signed_in_user, session_user_id(flask_app, websocket.cookies))
        if user is None:
            await websocket.close(CLOSE_UNAUTHORIZED)
            return
        watcher = Watcher(websocket, user["id"])
        pump = asyncio.create_task(watcher.pump())
        try:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                try:
                    requested = json.loads(message.get("text") or "null")["watch"]
                    requested = {str(uuid.UUID(graph_id)) for graph_id in requested[:MAX_WATCHED]}
                except (ValueError, TypeError, KeyError, AttributeError):
                    continue
                watcher.watch(requested & await run(listed_graph_ids, user["id"]))
        finally:
            watcher.watch(set())
            pump.cancel()

    return endpoint
