import gzip
import hashlib
import json
import logging
import os
import re
import sys
import threading
from pathlib import Path
from urllib.parse import quote

import requests
from flask import Blueprint, Response, abort, request

from auth import login_required

OFFICIAL_URL = "https://www.desmos.com/api/v1.13/calculator.js"
PATCHED_COMMIT = "4340fd031df4a5a566075d5a7a78c50ccd63d583"
TIMEOUT = (5, 30)
MAX_BYTES = 32 << 20
RELEASE_RE = re.compile(r"var desmosVersion = '([^']*)';\s*var desmosCommit = '([0-9a-f]+)';")
SHARED = "__dcg_shared_module_exports__"

log = logging.getLogger("uvicorn.error")
desmos_bp = Blueprint("desmos", __name__)

PATCHES = [
    (
        "tone oscillator release/revive/halt",
        "stop(e=0){this.gain.gain.setTargetAtTime(0,this.audioContext.currentTime+e+$a,js),"
        "setTimeout(()=>{this.oscillator.stop()},1e3*(2*js+e+$a)+1)}",
        "release(e){this.releasing||(this.releasing=!0,"
        "this.gain.gain.setTargetAtTime(0,this.audioContext.currentTime+$a,js),"
        "this.releaseTimer=setTimeout(()=>{this.releasing=!1,this.halt(),e()},1e3*(12*js+$a)+1))}"
        "revive(){this.releasing&&(clearTimeout(this.releaseTimer),this.releasing=!1)}"
        "halt(){try{this.oscillator.stop()}catch(e){}this.oscillator.disconnect(),this.gain.disconnect()}"
        "stop(e=0){this.gain.gain.setTargetAtTime(0,this.audioContext.currentTime+e+$a,js),"
        "setTimeout(()=>{this.oscillator.stop()},1e3*(2*js+e+$a)+1)}",
    ),
    (
        "tone voice: oscillators only for audible list elements",
        "J1=class{constructor(e,t){e.audioContext&&(this.audioContext=e.audioContext,"
        "this.gain=this.audioContext.createGain(),this.gain.gain.value=0,this.gain.connect(t),"
        "this.synthesizers=[])}updateFromValues(e){var t,o,i;"
        f"if(e&&e.valueType==={SHARED}['ra'])this.synthesizers.length>1?"
        "(this.tearDownSynthesizers(this.synthesizers.slice(1)),this.synthesizers.length=1):"
        "this.synthesizers.length===0&&(this.synthesizers=[this.makeSynth()]),"
        "(t=this.synthesizers[0])==null||t.setFrequencyAndGain(e.value[0],e.value[1]);"
        f"else if(e&&e.valueType==={SHARED}['sa'])"
        "{if(this.synthesizers.length>e.value.length&&(this.tearDownSynthesizers("
        "this.synthesizers.slice(e.value.length)),this.synthesizers.length=e.value.length),"
        "e.value.length>this.synthesizers.length)for(let n=this.synthesizers.length;n<e.value.length;n++)"
        "this.synthesizers.push(this.makeSynth());for(let n=0;n<e.value.length;n++)"
        "this.synthesizers[n].setFrequencyAndGain(e.value[n][0],e.value[n][1])}"
        "else this.tearDownSynthesizers(this.synthesizers),this.synthesizers=[];"
        "this.synthesizers.length>0?(o=this.gain)==null||o.gain.setTargetAtTime(1,this.audioContext.currentTime+$a,js):"
        "(i=this.gain)==null||i.gain.setTargetAtTime(0,this.audioContext.currentTime+$a,js)}"
        "makeSynth(){return new V_(this,this.gain)}tearDownSynthesizers(e){if(e)for(let t of e)t.stop()}"
        "setGain(e){this.gain.gain.setTargetAtTime(e,this.audioContext.currentTime+$a,js)}"
        "tearDown(){this.tearDownSynthesizers(this.synthesizers),this.synthesizers=[]}}",
        "J1=class{constructor(e,t){e.audioContext&&(this.audioContext=e.audioContext,"
        "this.gain=this.audioContext.createGain(),this.gain.gain.value=0,this.gain.connect(t),"
        "this.synthesizers=new Map)}updateFromValues(e){"
        f"let t=e&&e.valueType==={SHARED}['ra'],"
        f"o=t?[e.value]:e&&e.valueType==={SHARED}['sa']?e.value:[];"
        "for(let n=0;n<o.length;n++){let i=o[n][0],a=o[n][1],s=this.synthesizers.get(n);"
        "t||isFinite(i)&&isFinite(a)&&i>=Cg&&i<=Eg&&HV(a,i)>0?"
        "(s?s.revive():this.synthesizers.set(n,s=this.makeSynth()),s.setFrequencyAndGain(i,a)):"
        "s&&s.release(()=>{this.synthesizers.get(n)===s&&this.synthesizers.delete(n)})}"
        "for(let[n,i]of this.synthesizers)n>=o.length&&(this.synthesizers.delete(n),i.release(()=>{}));"
        "this.gain&&this.gain.gain.setTargetAtTime(o.length>0?1:0,this.audioContext.currentTime+$a,js)}"
        "makeSynth(){return new V_(this,this.gain)}"
        "setGain(e){this.appliedGain=e,this.gain.gain.setTargetAtTime(e,this.audioContext.currentTime+$a,js)}"
        "tearDown(){for(let e of this.synthesizers.values())e.release(()=>{});this.synthesizers.clear()}}",
    ),
    (
        "tone controller: recompute only changed tone items",
        "recomputeAudio(){let e=Array.from(this.controller.getPlayableToneSources()),t=[],"
        "o=new Set(e.map(i=>i.id));for(let i of this.expressionSynthMap.keys())"
        'o.has(i)||t.push({id:i,type:"remove"});this._recomputeAudio([...e,...t])}',
        "recomputeAudio(c){let e=Array.from(this.controller.getPlayableToneSources()),t=[],"
        "o=new Set(e.map(i=>i.id));for(let i of this.expressionSynthMap.keys())"
        'o.has(i)||t.push({id:i,type:"remove"});'
        "c&&(e=e.filter(i=>{let n=this.expressionSynthMap.get(i.id);"
        "return!n||n.appliedGain!==(i.muted?0:this.maxGain)||Object.prototype.hasOwnProperty.call(c,i.id)}));"
        "this._recomputeAudio([...e,...t])}",
    ),
    (
        "evaluator changes: pass the changed ids to the tone controller",
        "this.wizardModel.onEvaluatorChanges(e.changes),(g=this.toneController)==null||g.recomputeAudio(),",
        "this.wizardModel.onEvaluatorChanges(e.changes),(g=this.toneController)==null||g.recomputeAudio(e.changes),",
    ),
]

_bundle = None
_started = False
_lock = threading.Lock()


class PatchError(Exception):
    pass


def official_url(api_key):
    return f"{OFFICIAL_URL}?apiKey={quote(api_key, safe='')}"


def release_of(source):
    match = RELEASE_RE.search(source[:4096])
    return (match[1], match[2]) if match else (None, None)


def apply_patches(source):
    for name, anchor, replacement in PATCHES:
        count = source.count(anchor)
        if count != 1:
            raise PatchError(f"anchor for {name!r} matched {count} times")
        source = source.replace(anchor, replacement)
    return source


def fingerprint(text):
    return hashlib.sha256(text.encode()).hexdigest()


def download(api_key):
    try:
        res = requests.get(official_url(api_key), timeout=TIMEOUT)
    except requests.RequestException as error:
        raise PatchError(f"download failed ({type(error).__name__})") from None
    if res.status_code != 200:
        raise PatchError(f"download returned HTTP {res.status_code}")
    if len(res.content) > MAX_BYTES:
        raise PatchError("download too large")
    return res.content.decode()


def build(source):
    version, commit = release_of(source)
    if not commit:
        raise PatchError("bundle has no desmosCommit header")
    body = apply_patches(source).encode()
    digest = hashlib.sha256(body).hexdigest()[:16]
    return {
        "name": f"calculator-{commit[:10]}-{digest}.js",
        "version": version,
        "commit": commit,
        "body": body,
        "gzip": gzip.compress(body, 9),
    }


def cache_paths(data_dir):
    folder = Path(data_dir) / "desmos"
    return folder / "official.js", folder / "official.json"


def read_cache(data_dir, api_key):
    source_path, meta_path = cache_paths(data_dir)
    try:
        meta = json.loads(meta_path.read_text())
        source = source_path.read_text()
    except (OSError, ValueError):
        return None
    if meta.get("key") != fingerprint(api_key) or meta.get("source") != fingerprint(source):
        return None
    return source


def write_cache(data_dir, api_key, source):
    source_path, meta_path = cache_paths(data_dir)
    source_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.write_text(source)
    meta_path.write_text(json.dumps({"key": fingerprint(api_key), "source": fingerprint(source)}))


def use(bundle, origin):
    global _bundle
    _bundle = bundle
    if bundle is None:
        log.warning("Desmos: serving the official script from desmos.com")
        return
    note = "" if bundle["commit"] == PATCHED_COMMIT else f" (patches were written for {PATCHED_COMMIT[:10]})"
    log.info("Desmos: serving patched %s %s from %s%s", bundle["version"], bundle["commit"][:10], origin, note)


def prepare(data_dir, api_key):
    cached = read_cache(data_dir, api_key)
    try:
        source = download(api_key)
    except PatchError as error:
        log.warning("Desmos: %s", error)
        if cached is None:
            return use(None, None)
        source, origin = cached, "cache"
    else:
        origin = "download"
        if source != cached:
            try:
                write_cache(data_dir, api_key, source)
            except OSError as error:
                log.warning("Desmos: could not write cache (%s)", type(error).__name__)
    try:
        bundle = build(source)
    except PatchError as error:
        version, commit = release_of(source)
        log.error("Desmos: not patching %s %s: %s", version, (commit or "?")[:10], error)
        return use(None, None)
    use(bundle, origin)


def start(app):
    global _started
    with _lock:
        if _started or os.environ.get("DESMOS_SELF_HOST", "1") == "0":
            return
        _started = True
    args = (app.config["DATA_DIR"], os.environ["DESMOS_API_KEY"])
    threading.Thread(target=prepare, args=args, name="desmos-bundle", daemon=True).start()


def script_urls(api_key):
    urls = [official_url(api_key)]
    if _bundle:
        urls.insert(0, f"/desmos/{_bundle['name']}")
    return urls


@desmos_bp.get("/desmos/<name>")
@login_required(handle=False)
def script(name):
    bundle = _bundle
    if not bundle or name != bundle["name"]:
        abort(404)
    gzipped = "gzip" in request.headers.get("Accept-Encoding", "")
    response = Response(bundle["gzip"] if gzipped else bundle["body"], mimetype="application/javascript")
    if gzipped:
        response.headers["Content-Encoding"] = "gzip"
    response.headers["Vary"] = "Accept-Encoding"
    response.headers["Cache-Control"] = "private, max-age=31536000, immutable"
    return response


if __name__ == "__main__":
    patched = apply_patches(Path(sys.argv[1]).read_text())
    Path(sys.argv[2]).write_text(patched)
    print(*release_of(patched))
