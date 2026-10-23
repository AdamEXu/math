import threading
import uuid
from collections import defaultdict

from pycrdt import Doc, Map, Text, merge_updates

from db import write_transaction

CHECKPOINT_EVERY = 200
MAX_TITLE = 200
EMPTY_UPDATE = Doc().get_update()


def load_state(db, graph_id):
    checkpoint = db.execute(
        "SELECT seq, state FROM checkpoints WHERE graph_id = ? ORDER BY seq DESC LIMIT 1", (graph_id,)
    ).fetchone()
    since = checkpoint["seq"] if checkpoint else 0
    rows = db.execute(
        "SELECT data FROM updates WHERE graph_id = ? AND seq > ? ORDER BY seq", (graph_id, since)
    ).fetchall()
    parts = ([checkpoint["state"]] if checkpoint else []) + [row["data"] for row in rows]
    return (merge_updates(*parts) if parts else EMPTY_UPDATE), len(rows)


def doc_title(doc):
    title = doc.get("meta", type=Map).get("title")
    return "" if title is None else str(title).strip()[:MAX_TITLE]


def title_of(state):
    doc = Doc()
    doc.apply_update(state)
    return doc_title(doc)


def title_update(state, title):
    doc = Doc()
    doc.apply_update(state)
    before = doc.get_state()
    meta = doc.get("meta", type=Map)
    with doc.transaction():
        current = meta.get("title")
        if isinstance(current, Text):
            del current[:]
            current += title
        else:
            meta["title"] = Text(title)
    return doc.get_update(before)


def next_seq(db, graph_id):
    return db.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM updates WHERE graph_id = ?", (graph_id,)).fetchone()[0]


def insert_update(db, graph_id, seq, now, author_id, data, client_update_id=None, client_ts=None):
    return db.execute(
        "INSERT OR IGNORE INTO updates (graph_id, seq, ts, client_ts, author_id, client_update_id, data)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (graph_id, seq, now, client_ts, author_id, client_update_id or str(uuid.uuid4()), data),
    ).rowcount


def append_server_update(db, graph_id, author_id, data, now):
    insert_update(db, graph_id, next_seq(db, graph_id), now, author_id, data)


class GraphDoc:
    """The authoritative in-memory Y.Doc for one graph, kept in step with the updates log.

    Callers hold graph_lock(graph_id) around every method. An exception from a write method leaves the
    doc ahead of the database, so the caller must discard the instance.
    """

    def __init__(self, db, graph_id):
        self.graph_id = graph_id
        self.doc = Doc()
        self._deltas = []
        state, self.since_checkpoint = load_state(db, graph_id)
        self.doc.apply_update(state)
        self.doc.observe(lambda event: self._deltas.append(event.update))

    def integrate(self, data):
        self._deltas.clear()
        self.doc.apply_update(data)
        deltas, self._deltas = self._deltas, []
        if not deltas:
            return None
        return deltas[0] if len(deltas) == 1 else merge_updates(*deltas)

    def state_vector(self):
        return self.doc.get_state()

    def diff(self, state_vector):
        return self.doc.get_update(state_vector)

    def apply_live(self, db, data, author_id, now):
        delta = self.integrate(data)
        if delta is not None:
            with write_transaction(db):
                insert_update(db, self.graph_id, next_seq(db, self.graph_id), now, author_id, delta)
                self._after_append(db, now, 1)
        return delta

    def apply_logged(self, db, updates, author_id, now):
        deltas = []
        with write_transaction(db):
            seq = next_seq(db, self.graph_id) - 1
            added = 0
            for update_id, client_ts, data in updates:
                if insert_update(db, self.graph_id, seq + 1, now, author_id, data, update_id, client_ts):
                    seq += 1
                    added += 1
                    delta = self.integrate(data)
                    if delta is not None:
                        deltas.append(delta)
            if added:
                self._after_append(db, now, added)
        return seq, deltas

    def _after_append(self, db, now, added):
        db.execute(
            "UPDATE graphs SET title = ?, updated_at = ? WHERE id = ?", (doc_title(self.doc), now, self.graph_id)
        )
        self.since_checkpoint += added
        if self.since_checkpoint >= CHECKPOINT_EVERY:
            state, _ = load_state(db, self.graph_id)
            seq = next_seq(db, self.graph_id) - 1
            db.execute(
                "INSERT INTO checkpoints (graph_id, seq, ts, state) VALUES (?, ?, ?, ?)",
                (self.graph_id, seq, now, state),
            )
            self.since_checkpoint = 0


_graph_locks = defaultdict(threading.RLock)
_graph_locks_guard = threading.Lock()


def graph_lock(graph_id):
    with _graph_locks_guard:
        return _graph_locks[graph_id]
