import sqlite3

import pytest

from tests.conftest import FETCH, ORIGIN, make_user, signed_in
from users import EmailInUse, display_name_error, find_user, handle_error, suggest_handle, upsert_google_user


@pytest.mark.parametrize("handle", ["abc", "a_1", "z" * 20, "adam_xu"])
def test_valid_handles(handle):
    assert handle_error(handle) is None


@pytest.mark.parametrize(
    "handle", ["ab", "a" * 21, "1abc", "_abc", "ab-c", "ab c", "ab.c", "admin", "settings", "me", "new", "éabc"]
)
def test_invalid_handles(handle):
    assert handle_error(handle) is not None


def test_new_user_is_sent_to_onboarding_first(app):
    client = signed_in(app, "carol@pinewood.edu")
    res = client.get("/calculator/01a16761-f65e-7694-94d9-6244099f81d1")
    assert res.status_code == 302
    assert res.headers["Location"] == "/welcome?next=/calculator/01a16761-f65e-7694-94d9-6244099f81d1"
    assert client.get("/").headers["Location"].startswith("/welcome")
    assert client.get("/settings").headers["Location"].startswith("/welcome")
    assert client.post("/graphs", headers={"Origin": ORIGIN}).status_code == 302
    assert client.get("/graphs/x/doc", headers=FETCH).get_json() == {"error": "handle_required"}
    page = client.get("/welcome").get_data(as_text=True)
    assert 'value="carol"' in page and 'value="Carol"' in page


def test_choosing_handle_redirects_to_next(app):
    client = signed_in(app, "dave.smith@pinewood.edu")
    page = client.get("/welcome").get_data(as_text=True)
    assert 'value="dave_smith"' in page and 'value="Dave Smith"' in page
    res = client.post(
        "/welcome", data={"handle": "Dave", "display_name": "  D\u00e4ve \U0001f4d0 ", "next": "/settings"},
        headers={"Origin": ORIGIN},
    )
    assert res.status_code == 302 and res.headers["Location"] == "/settings"
    page = client.get("/settings").get_data(as_text=True)
    assert "@dave" in page and 'value="D\u00e4ve \U0001f4d0"' in page
    assert client.get("/").status_code == 200


def test_welcome_rejects_offsite_next(app):
    client = signed_in(app, "erin@pinewood.edu")
    res = client.post(
        "/welcome", data={"handle": "erin", "display_name": "Erin", "next": "//evil.example"}, headers={"Origin": ORIGIN}
    )
    assert res.headers["Location"] == "/"


def test_welcome_requires_same_origin(app):
    client = signed_in(app, "erin@pinewood.edu")
    assert client.post("/welcome", data={"handle": "erin"}).status_code == 403


def test_handles_are_unique_case_insensitively(app, alice):
    client = signed_in(app, "frank@pinewood.edu")
    res = client.post("/welcome", data={"handle": "ALICE", "display_name": "Frank"}, headers={"Origin": ORIGIN})
    assert res.status_code == 400 and "taken" in res.get_data(as_text=True)
    assert client.get("/handles/check?handle=Alice").get_json() == {
        "handle": "alice", "available": False, "error": "That handle is taken.",
    }
    assert client.get("/handles/check?handle=@Frank_1").get_json()["available"] is True
    assert client.get("/handles/check?handle=admin").get_json()["error"] == "That handle is reserved."


def test_suggestion_skipped_when_taken(app, alice):
    with app.app_context():
        assert suggest_handle("alice@pinewood.edu") is None
        assert suggest_handle("9.bob-x@pinewood.edu") == "bob_x"


def save_settings(client, handle, display_name="Alice", origin=ORIGIN):
    headers = {"Origin": origin} if origin else {}
    return client.post("/settings", data={"handle": handle, "display_name": display_name}, headers=headers)


def test_settings_changes_handle(app, alice, bob):
    assert alice.get("/handles/check?handle=alice").get_json()["available"] is True
    assert save_settings(alice, "bob").status_code == 400
    assert save_settings(alice, "x").status_code == 400
    assert save_settings(alice, "alice2", origin=None).status_code == 403
    res = save_settings(alice, "Alice2")
    assert res.headers["Location"] == "/settings?saved=1"
    page = alice.get("/settings?saved=1").get_data(as_text=True)
    assert "@alice2" in page and "alice@pinewood.edu" in page
    assert alice.get("/handles/check?handle=alice").get_json()["available"] is True


def test_graph_ownership_survives_handle_change(app, alice, graph_id):
    assert save_settings(alice, "renamed").status_code == 302
    assert alice.get(f"/calculator/{graph_id}").status_code == 200
    assert graph_id in alice.get("/").get_data(as_text=True)


def test_graphs_and_updates_store_user_ids(app, alice, graph_id):
    conn = sqlite3.connect(app.config["DATA_DIR"] / "math.db")
    try:
        assert conn.execute("SELECT owner_id FROM graphs WHERE id = ?", (graph_id,)).fetchone() == (alice.user_id,)
    finally:
        conn.close()


def test_find_user_by_handle_or_email(app, alice):
    with app.app_context():
        assert find_user("@Alice")["id"] == alice.user_id
        assert find_user("alice")["id"] == alice.user_id
        assert find_user("ALICE@pinewood.edu")["id"] == alice.user_id
        assert find_user("nobody") is None
        assert find_user("") is None


def test_google_upsert_tracks_sub_and_updates_profile(app):
    with app.app_context():
        user = upsert_google_user("sub-1", "gina@pinewood.edu", "Gina")
        renamed = upsert_google_user("sub-1", "gina.r@pinewood.edu", "Gina R")
        assert renamed["id"] == user["id"]
        assert (renamed["email"], renamed["google_name"]) == ("gina.r@pinewood.edu", "Gina R")
        with pytest.raises(EmailInUse):
            upsert_google_user("sub-2", "gina.r@pinewood.edu", "Impostor")


def test_google_login_adopts_dev_user(app):
    user_id = make_user(app, "hank@pinewood.edu", "hank")
    with app.app_context():
        assert upsert_google_user("sub-hank", "hank@pinewood.edu", "Hank")["id"] == user_id


def test_stale_session_is_signed_out(app):
    client = app.test_client()
    with client.session_transaction() as sess:
        sess["user_id"] = "01a16761-0000-7000-8000-000000000000"
    assert client.get("/").headers["Location"].endswith("/login")
    assert client.get("/graphs/x/doc", headers=FETCH).status_code == 401


def test_header_shows_name_and_handle(alice):
    page = alice.get("/").get_data(as_text=True)
    assert "@alice" in page and "Account settings" in page


@pytest.mark.parametrize("name", ["A", "x" * 50, "J\u00fcrgen M\u00fcller", "\u5f20\u4f1f", "\U0001f4d0 math"])
def test_valid_display_names(name):
    assert display_name_error(name) is None


@pytest.mark.parametrize("name", ["", "x" * 51, "line\nbreak", "tab\there"])
def test_invalid_display_names(name):
    assert display_name_error(name) is not None


def test_settings_validates_and_trims_display_name(app, alice):
    assert save_settings(alice, "alice", display_name="   ").status_code == 400
    assert save_settings(alice, "alice", display_name="y" * 51).status_code == 400
    assert save_settings(alice, "alice", display_name="  Alice Liddell  ").status_code == 302
    with app.app_context():
        assert find_user("alice")["display_name"] == "Alice Liddell"
    assert "Alice Liddell" in alice.get("/").get_data(as_text=True)


def test_display_name_defaults_from_google_and_is_not_clobbered(app):
    with app.app_context():
        user = upsert_google_user("sub-ivy", "ivy@pinewood.edu", "Ivy Google")
        assert user["display_name"] == "Ivy Google"
    client = app.test_client()
    with client.session_transaction() as sess:
        sess["user_id"] = user["id"]
    res = client.post("/welcome", data={"handle": "ivy", "display_name": "Ivy"}, headers={"Origin": ORIGIN})
    assert res.status_code == 302
    with app.app_context():
        again = upsert_google_user("sub-ivy", "ivy@pinewood.edu", "Ivy Renamed At Google")
        assert (again["display_name"], again["google_name"]) == ("Ivy", "Ivy Renamed At Google")


def test_long_google_name_is_truncated_for_display(app):
    with app.app_context():
        assert len(upsert_google_user("sub-long", "long@pinewood.edu", "z" * 80)["display_name"]) == 50
