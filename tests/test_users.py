import sqlite3

import pytest

from tests.conftest import FETCH, make_user, new_graph, signed_in
from users import (
    EmailInUse, avatar_hue, display_name_error, find_user, handle_error, set_google_picture, suggest_handle,
    upsert_google_user,
)

GRAPH = "01a16761-f65e-7694-94d9-6244099f81d1"


def save_profile(client, handle, display_name="Alice", headers=FETCH):
    return client.put("/api/me", json={"handle": handle, "display_name": display_name}, headers=headers)


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
    res = client.get(f"/calculator/{GRAPH}")
    assert res.status_code == 302 and res.headers["Location"] == f"/welcome?next=/calculator/{GRAPH}"
    assert client.get("/").headers["Location"] == "/welcome?next=/"
    assert client.get("/settings").headers["Location"] == "/welcome?next=/settings"
    res = client.post("/api/graphs", headers=FETCH)
    assert res.status_code == 403 and res.get_json() == {"error": "handle_required"}
    assert client.get(f"/api/graphs/{GRAPH}/doc").get_json() == {"error": "handle_required"}
    assert client.get("/api/graphs").get_json() == {"error": "handle_required"}
    assert client.get("/api/folders").status_code == 403
    assert client.get("/welcome").status_code == 200
    me = client.get("/api/me").get_json()
    assert (me["handle"], me["suggested_handle"], me["display_name"]) == (None, "carol", "Carol")


@pytest.mark.parametrize("path", ["/api/me", "/api/handles/check?handle=zed", "/api/config"])
def test_handle_not_required(app, path):
    client = signed_in(app, "carol@pinewood.edu")
    assert client.get(path).status_code == 200


def test_choosing_handle_then_welcome_redirects_to_next(app):
    client = signed_in(app, "dave.smith@pinewood.edu")
    me = client.get("/api/me").get_json()
    assert me["suggested_handle"] == "dave_smith" and me["display_name"] == "Dave Smith"
    res = save_profile(client, "Dave", "  Däve \U0001f4d0 ")
    assert res.status_code == 200
    me = res.get_json()
    assert me["handle"] == "dave" and me["display_name"] == "Däve \U0001f4d0" and me["suggested_handle"] is None
    assert me == client.get("/api/me").get_json()
    res = client.get("/welcome?next=/settings")
    assert res.status_code == 302 and res.headers["Location"] == "/settings"
    assert client.get("/").status_code == 200
    assert client.get("/settings").status_code == 200


@pytest.mark.parametrize("target", ["//evil.example", "https://evil.example", "", "evil"])
def test_welcome_rejects_offsite_next(alice, target):
    res = alice.get(f"/welcome?next={target}")
    assert res.status_code == 302 and res.headers["Location"] == "/"


def test_welcome_without_next_goes_home(alice):
    assert alice.get("/welcome").headers["Location"] == "/"


def test_put_me_requires_fetch_header(app):
    client = signed_in(app, "erin@pinewood.edu")
    res = save_profile(client, "erin", "Erin", headers={})
    assert res.status_code == 403 and res.get_json() == {"error": "forbidden"}
    assert client.get("/api/me").get_json()["handle"] is None


def test_put_me_error_payload_shape(app, alice):
    client = signed_in(app, "frank@pinewood.edu")
    res = save_profile(client, "  @ALICE ", " Frank ")
    assert res.status_code == 400
    assert res.get_json() == {
        "error": "invalid",
        "errors": {"handle": "That handle is taken."},
        "profile": {"handle": "alice", "display_name": "Frank"},
    }
    res = save_profile(client, "x", "")
    assert res.get_json() == {
        "error": "invalid",
        "errors": {"handle": "Handles are 3 to 20 characters.", "display_name": "Enter a display name."},
        "profile": {"handle": "x", "display_name": ""},
    }
    res = client.put("/api/me", json={"handle": 5, "display_name": ["Frank"]}, headers=FETCH)
    assert res.status_code == 400 and set(res.get_json()["errors"]) == {"handle", "display_name"}
    res = client.put("/api/me", json=["frank"], headers=FETCH)
    assert res.status_code == 400 and res.get_json() == {"error": "Bad request."}
    assert client.get("/api/me").get_json()["handle"] is None


def test_handles_are_unique_case_insensitively(app, alice):
    client = signed_in(app, "frank@pinewood.edu")
    assert save_profile(client, "ALICE", "Frank").status_code == 400
    assert client.get("/api/handles/check?handle=Alice").get_json() == {
        "handle": "alice", "available": False, "error": "That handle is taken.",
    }
    assert client.get("/api/handles/check?handle=@Frank_1").get_json() == {
        "handle": "frank_1", "available": True, "error": None,
    }
    assert client.get("/api/handles/check?handle=admin").get_json()["error"] == "That handle is reserved."
    assert client.get("/api/handles/check").get_json()["available"] is False


def test_handle_check_requires_login(app):
    assert app.test_client().get("/api/handles/check?handle=zed").status_code == 401


def test_suggestion_skipped_when_taken(app, alice):
    with app.app_context():
        assert suggest_handle("alice@pinewood.edu") is None
        assert suggest_handle("9.bob-x@pinewood.edu") == "bob_x"


def test_settings_changes_handle(app, alice, bob):
    assert alice.get("/api/handles/check?handle=alice").get_json()["available"] is True
    assert save_profile(alice, "bob").status_code == 400
    assert save_profile(alice, "x").status_code == 400
    assert save_profile(alice, "alice2", headers={}).status_code == 403
    res = save_profile(alice, "Alice2")
    assert res.status_code == 200
    me = res.get_json()
    assert me["handle"] == "alice2" and me["email"] == "alice@pinewood.edu"
    assert alice.get("/api/handles/check?handle=alice").get_json()["available"] is True
    assert bob.get("/api/handles/check?handle=alice2").get_json()["available"] is False


def test_graph_ownership_survives_handle_change(app, alice, graph_id):
    assert save_profile(alice, "renamed").status_code == 200
    assert alice.get(f"/api/graphs/{graph_id}").status_code == 200
    assert [g["id"] for g in alice.get("/api/graphs").get_json()["graphs"]] == [graph_id]


def test_graphs_and_updates_store_user_ids(app, alice, graph_id):
    conn = sqlite3.connect(app.config["DATA_DIR"] / "math.db")
    try:
        assert conn.execute("SELECT owner_id FROM graphs WHERE id = ?", (graph_id,)).fetchone() == (alice.user_id,)
        assert conn.execute("SELECT author_id FROM updates WHERE graph_id = ?", (graph_id,)).fetchone() == (alice.user_id,)
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
    res = client.get("/api/me")
    assert res.status_code == 401 and res.get_json() == {"error": "signed_out"}
    with client.session_transaction() as sess:
        assert "user_id" not in sess
        sess["user_id"] = "01a16761-0000-7000-8000-000000000000"
    assert client.get("/").headers["Location"] == "/login"
    with client.session_transaction() as sess:
        assert "user_id" not in sess
    assert client.get(f"/api/graphs/{GRAPH}/doc").status_code == 401


def test_me_shape(app, alice):
    res = alice.get("/api/me")
    assert res.status_code == 200
    with app.app_context():
        hue = avatar_hue(find_user("alice"))
    assert res.get_json() == {
        "id": alice.user_id,
        "email": "alice@pinewood.edu",
        "handle": "alice",
        "display_name": "Alice",
        "avatar_url": None,
        "avatar_hue": hue,
        "avatar_initial": "A",
        "suggested_handle": None,
    }
    assert 0 <= hue < 360


def test_me_requires_login(app):
    assert app.test_client().get("/api/me").status_code == 401
    assert app.test_client().put("/api/me", json={}, headers=FETCH).status_code == 401


@pytest.mark.parametrize("name", ["A", "x" * 50, "Jürgen Müller", "张伟", "\U0001f4d0 math"])
def test_valid_display_names(name):
    assert display_name_error(name) is None


@pytest.mark.parametrize("name", ["", "x" * 51, "line\nbreak", "tab\there"])
def test_invalid_display_names(name):
    assert display_name_error(name) is not None


def test_settings_validates_and_trims_display_name(app, alice):
    assert save_profile(alice, "alice", display_name="   ").status_code == 400
    assert save_profile(alice, "alice", display_name="y" * 51).status_code == 400
    res = save_profile(alice, "alice", display_name="  Alice Liddell  ")
    assert res.status_code == 200 and res.get_json()["display_name"] == "Alice Liddell"
    with app.app_context():
        assert find_user("alice")["display_name"] == "Alice Liddell"
    assert alice.get("/api/me").get_json()["avatar_initial"] == "A"


def test_display_name_defaults_from_google_and_is_not_clobbered(app):
    with app.app_context():
        user = upsert_google_user("sub-ivy", "ivy@pinewood.edu", "Ivy Google")
        assert user["display_name"] == "Ivy Google"
    client = app.test_client()
    with client.session_transaction() as sess:
        sess["user_id"] = user["id"]
    assert save_profile(client, "ivy", "Ivy").status_code == 200
    with app.app_context():
        again = upsert_google_user("sub-ivy", "ivy@pinewood.edu", "Ivy Renamed At Google")
        assert (again["display_name"], again["google_name"]) == ("Ivy", "Ivy Renamed At Google")


def test_long_google_name_is_truncated_for_display(app):
    with app.app_context():
        assert len(upsert_google_user("sub-long", "long@pinewood.edu", "z" * 80)["display_name"]) == 50


class Reply:
    def __init__(self, data):
        self.data = data

    def json(self):
        return self.data


def fake_google(monkeypatch, profiles):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "id")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "secret")
    monkeypatch.setattr("auth.requests.post", lambda *a, **k: Reply({"access_token": "token"}))
    monkeypatch.setattr("auth.requests.get", lambda *a, **k: Reply(next(profiles)))


def google_callback(app, state="state"):
    client = app.test_client()
    with client.session_transaction() as sess:
        sess["google_oauth_state"] = "state"
    return client, client.get(f"/auth/google/callback?state={state}&code=c")


def test_google_picture_url_refreshed_on_every_login(app, monkeypatch):
    profile = {"id": "sub-pic", "email": "pia@pinewood.edu", "name": "Pia", "hd": "pinewood.edu", "verified_email": True}
    pictures = ["https://lh3.googleusercontent.com/a/one=s96-c", "https://lh3.googleusercontent.com/a/two=s96-c"]
    fake_google(monkeypatch, iter({**profile, "picture": p} for p in pictures))
    for expected in ("one", "two"):
        client, res = google_callback(app)
        assert res.status_code == 302 and res.headers["Location"] == "/"
        with app.app_context():
            assert find_user("pia@pinewood.edu")["google_picture_url"].endswith(f"/a/{expected}=s96-c")
        assert client.get("/api/me").get_json()["avatar_url"].endswith(f"/a/{expected}=s96-c")


def test_google_callback_checks_state_and_domain(app, monkeypatch):
    profiles = iter([
        {"id": "sub-x", "email": "x@gmail.com", "name": "X", "hd": None, "verified_email": True},
        {"id": "sub-y", "email": "y@pinewood.edu", "name": "Y", "hd": "pinewood.edu", "verified_email": False},
    ])
    fake_google(monkeypatch, profiles)
    _, res = google_callback(app, state="wrong")
    assert res.headers["Location"] == "/login?error=invalid_state"
    for _ in range(2):
        client, res = google_callback(app)
        assert res.headers["Location"] == "/login?error=invalid_domain"
        assert client.get("/api/me").status_code == 401


def test_avatar_uses_picture_or_initial(app, alice):
    me = alice.get("/api/me").get_json()
    assert me["avatar_url"] is None and me["avatar_initial"] == "A"
    with app.app_context():
        set_google_picture(alice.user_id, "https://lh3.googleusercontent.com/a/x=s96-c")
        set_google_picture(alice.user_id, "javascript:alert(1)")
        assert find_user("alice")["google_picture_url"] is None
        set_google_picture(alice.user_id, "https://lh3.googleusercontent.com/a/x=s96-c")
    assert alice.get("/api/me").get_json()["avatar_url"] == "https://lh3.googleusercontent.com/a/x=s96-c"


def test_new_graph_still_works_after_onboarding(app):
    client = signed_in(app, "jo@pinewood.edu")
    assert save_profile(client, "jo_jo", "Jo").status_code == 200
    assert new_graph(client)
