import gzip
import logging

import pytest

import desmos_bundle
from tests.conftest import signed_in

HEADER = "var desmosVersion = 'v1.13-test';\nvar desmosCommit = 'abcdef0123456789';\n"
SOURCE = HEADER + ";".join(anchor for _, anchor, _ in desmos_bundle.PATCHES)
KEY = "desmos-key"


@pytest.fixture(autouse=True)
def no_bundle(monkeypatch):
    monkeypatch.setattr(desmos_bundle, "_bundle", None)
    monkeypatch.setenv("DESMOS_API_KEY", KEY)


def fake_download(monkeypatch, result):
    def download(api_key):
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(desmos_bundle, "download", download)


def test_apply_patches_replaces_every_anchor():
    patched = desmos_bundle.apply_patches(SOURCE)
    for _, anchor, replacement in desmos_bundle.PATCHES:
        assert anchor not in patched or anchor in replacement
        assert replacement in patched


@pytest.mark.parametrize("copies", [0, 2])
def test_apply_patches_requires_exactly_one_match(copies):
    _, anchor, _ = desmos_bundle.PATCHES[1]
    source = SOURCE.replace(anchor, ";".join([anchor] * copies))
    with pytest.raises(desmos_bundle.PatchError, match="matched"):
        desmos_bundle.apply_patches(source)


def test_prepare_serves_patched_bundle(app, monkeypatch, tmp_path, caplog):
    fake_download(monkeypatch, SOURCE)
    with caplog.at_level(logging.INFO, "uvicorn.error"):
        desmos_bundle.prepare(tmp_path, KEY)
    bundle = desmos_bundle._bundle
    assert bundle["commit"] == "abcdef0123456789" and bundle["name"].startswith("calculator-abcdef0123-")
    assert "abcdef0123" in caplog.text and KEY not in caplog.text

    client = signed_in(app, "alice@pinewood.edu", "alice")
    scripts = client.get("/api/config").get_json()["desmos_scripts"]
    assert scripts == [f"/desmos/{bundle['name']}", f"{desmos_bundle.OFFICIAL_URL}?apiKey={KEY}"]
    res = client.get(scripts[0], headers={"Accept-Encoding": "gzip"})
    assert res.headers["Content-Encoding"] == "gzip" and "immutable" in res.headers["Cache-Control"]
    assert gzip.decompress(res.data) == desmos_bundle.apply_patches(SOURCE).encode()
    assert client.get(scripts[0]).data == bundle["body"]
    assert client.get("/desmos/calculator-other.js").status_code == 404
    assert app.test_client().get(scripts[0]).status_code == 302


def test_download_failure_uses_cache(monkeypatch, tmp_path):
    fake_download(monkeypatch, SOURCE)
    desmos_bundle.prepare(tmp_path, KEY)
    name = desmos_bundle._bundle["name"]
    desmos_bundle._bundle = None
    fake_download(monkeypatch, desmos_bundle.PatchError("download failed (ConnectionError)"))
    desmos_bundle.prepare(tmp_path, KEY)
    assert desmos_bundle._bundle["name"] == name


def test_cache_is_ignored_for_another_key(monkeypatch, tmp_path):
    fake_download(monkeypatch, SOURCE)
    desmos_bundle.prepare(tmp_path, KEY)
    desmos_bundle._bundle = None
    fake_download(monkeypatch, desmos_bundle.PatchError("download failed (Timeout)"))
    desmos_bundle.prepare(tmp_path, "other-key")
    assert desmos_bundle._bundle is None


def test_anchor_failure_falls_back_to_official(app, monkeypatch, tmp_path, caplog):
    fake_download(monkeypatch, HEADER + "changed release")
    desmos_bundle.prepare(tmp_path, KEY)
    assert desmos_bundle._bundle is None
    assert "not patching v1.13-test abcdef0123" in caplog.text
    client = signed_in(app, "alice@pinewood.edu", "alice")
    assert client.get("/api/config").get_json()["desmos_scripts"] == [f"{desmos_bundle.OFFICIAL_URL}?apiKey={KEY}"]


def test_download_errors_never_log_the_key(monkeypatch, tmp_path, caplog):
    def get(url, timeout):
        raise desmos_bundle.requests.ConnectionError(f"failed to reach {url}")

    monkeypatch.setattr(desmos_bundle.requests, "get", get)
    desmos_bundle.prepare(tmp_path, KEY)
    assert "ConnectionError" in caplog.text and KEY not in caplog.text
