import sqlite3

from pycrdt import Map

import db as db_module
from tests.conftest import ORIGIN, signed_in
from tests.test_graphs import Writer, load_doc, post_updates, rows


def create(client):
    res = client.post("/graphs", headers={"Origin": ORIGIN})
    assert res.status_code == 302
    return res.headers["Location"].rsplit("/", 1)[1]


def title(app, graph_id):
    return rows(app, "SELECT title FROM graphs WHERE id = ?", graph_id)[0][0]


def rename(client, graph_id, new_title):
    writer = Writer(client, graph_id)

    def edit(meta):
        text = meta["title"]
        del text[:]
        text += new_title

    assert post_updates(client, graph_id, [writer.edit(edit)]).status_code == 200


def test_new_graphs_are_numbered_per_user(app, alice, bob):
    first, second, third = create(alice), create(alice), create(alice)
    assert [title(app, g) for g in (first, second, third)] == [
        "Untitled Graph", "Untitled Graph (2)", "Untitled Graph (3)",
    ]
    assert title(app, create(bob)) == "Untitled Graph"


def test_numbering_fills_gaps_and_ignores_deleted(app, alice):
    first, second, third = create(alice), create(alice), create(alice)
    rename(alice, second, "Parabola")
    assert title(app, create(alice)) == "Untitled Graph (2)"
    assert alice.post(f"/graphs/{first}/delete", headers={"Origin": ORIGIN}).status_code == 302
    assert title(app, create(alice)) == "Untitled Graph"
    assert title(app, third) == "Untitled Graph (3)"


def test_title_lives_in_doc_and_survives_round_trip(app, alice):
    graph_id = create(alice)
    meta = load_doc(alice, graph_id).get("meta", type=Map)
    assert str(meta["title"]) == "Untitled Graph"
    writer = Writer(alice, graph_id)
    assert post_updates(alice, graph_id, [writer.edit(lambda m: m.__setitem__("k", 1))]).status_code == 200
    assert title(app, graph_id) == "Untitled Graph"
    assert str(load_doc(alice, graph_id).get("meta", type=Map)["title"]) == "Untitled Graph"
    assert "Untitled Graph" in alice.get("/").get_data(as_text=True)


def test_backfill_names_empty_titles_and_fixes_doc(app, alice, bob):
    a1, a2, b1 = create(alice), create(alice), create(bob)
    a3 = create(alice)
    rename(alice, a2, "Kept")
    conn = sqlite3.connect(app.config["DATA_DIR"] / "math.db")
    with conn:
        conn.execute("UPDATE graphs SET title = '' WHERE id IN (?, ?, ?)", (a1, a3, b1))
        conn.execute("UPDATE graphs SET created_at = 0 WHERE id = ?", (a3,))
    conn.close()
    db_module._initialized.clear()
    with app.app_context():
        db_module.get_db()
    assert [title(app, g) for g in (a3, a1, a2, b1)] == ["Untitled Graph", "Untitled Graph (2)", "Kept", "Untitled Graph"]
    assert str(load_doc(alice, a1).get("meta", type=Map)["title"]) == "Untitled Graph (2)"
    counts = rows(app, "SELECT COUNT(*) FROM updates WHERE graph_id = ?", a1)
    db_module._initialized.clear()
    with app.app_context():
        db_module.get_db()
    assert rows(app, "SELECT COUNT(*) FROM updates WHERE graph_id = ?", a1) == counts


def test_backfill_handles_graph_without_title_in_doc(app):
    client = signed_in(app, "carol@pinewood.edu", "carol")
    graph_id = create(client)
    conn = sqlite3.connect(app.config["DATA_DIR"] / "math.db")
    with conn:
        conn.execute("DELETE FROM updates WHERE graph_id = ?", (graph_id,))
        conn.execute("UPDATE graphs SET title = '' WHERE id = ?", (graph_id,))
    conn.close()
    db_module._initialized.clear()
    with app.app_context():
        db_module.get_db()
    assert str(load_doc(client, graph_id).get("meta", type=Map)["title"]) == "Untitled Graph"
