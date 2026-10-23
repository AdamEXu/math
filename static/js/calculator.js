import { Saver } from "./saver.js";
import { LOAD, LOCAL, REMOTE, Y, deepEqual, readState, readTitle, readViewport, writeState, writeTitle } from "./ydesmos.js";

const CAPTURE_MS = 100;
const VIEWPORT_MS = 500;
const THUMBNAIL_IDLE_MS = 3000;
const THUMBNAIL = { width: 320, height: 240, targetPixelRatio: 2 };
const FETCH_HEADERS = { "X-Requested-With": "fetch" };

const graphId = document.body.dataset.graphId;
const titleInput = document.getElementById("title");
const statusEl = document.getElementById("status");
const setStatus = (status) => { statusEl.dataset.status = status; };

const OPTIONS = {
  keypad: true,
  graphpaper: true,
  expressions: true,
  settingsMenu: true,
  zoomButtons: true,
  expressionsTopbar: true,
  pointsOfInterest: true,
  trace: true,
  border: false,
  authorFeatures: true,
  images: true,
  folders: true,
  notes: true,
  sliders: true,
  actions: true,
  substitutions: true,
  links: true,
  distributions: true,
  calculus: true,
  pasteGraphLink: true,
  pasteTableData: true,
  zoomFit: true,
  customRegressions: true,
  regressionTemplates: true,
  logScales: true,
  tone: true,
  audio: true,
  muted: false,
  intervalComprehensions: true,
  allowComplex: true,
  matrices: true,
  recursion: true,
  showEvaluationCopyButtons: true,
  decimalToFraction: true,
  plotInequalities: true,
  plotImplicits: true,
  plotSingleVariableImplicitEquations: true,
  brailleControls: true,
  invertedColorsControl: true,
  imageUploadCallback: uploadImage,
};

function uploadImage(file, cb) {
  Desmos.imageFileToDataURL(file, async (err, dataUrl) => {
    if (err) return cb(err);
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const res = await fetch("/images", {
        method: "POST",
        headers: { ...FETCH_HEADERS, "Content-Type": blob.type },
        body: blob,
      });
      if (!res.ok) throw new Error(`image upload failed: ${res.status}`);
      cb(null, (await res.json()).url);
    } catch (error) {
      cb(error);
    }
  });
}

async function fetchDoc() {
  const res = await fetch(`/graphs/${graphId}/doc`, { headers: FETCH_HEADERS, cache: "no-store" });
  if (!res.ok) throw new Error(`load failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

class GraphSession {
  constructor(doc, calc) {
    this.doc = doc;
    this.calc = calc;
    this.saver = new Saver(`/graphs/${graphId}/updates`, setStatus);
    this.captureTimer = null;
    this.thumbnailTimer = null;
    this.pushTimer = null;
    this.lastViewportAt = 0;

    doc.on("update", (_update, origin) => {
      if (origin === LOCAL) {
        this.saver.push(_update);
        this.scheduleThumbnail();
      } else if (origin === REMOTE) {
        this.pushTimer ??= setTimeout(() => this.pushToDesmos(), 0);
      }
    });
    calc.observeEvent("change", (_name, event) => {
      if (event.isUserInitiated) this.scheduleCapture();
    });
  }

  scheduleCapture(delay = CAPTURE_MS) {
    this.captureTimer ??= setTimeout(() => this.capture(), delay);
  }

  capture() {
    clearTimeout(this.captureTimer);
    this.captureTimer = null;
    const state = this.calc.getState();
    const now = performance.now();
    const viewportChanged = !deepEqual(state.graph?.viewport, readViewport(this.doc));
    const keepViewport = viewportChanged && now - this.lastViewportAt < VIEWPORT_MS;
    this.doc.transact(() => {
      writeState(this.doc, state, { keepViewport });
      writeTitle(this.doc, titleInput.value.trim() ? titleInput.value : "");
    }, LOCAL);
    if (keepViewport) this.scheduleCapture(VIEWPORT_MS - (now - this.lastViewportAt));
    else if (viewportChanged) this.lastViewportAt = now;
  }

  applyRemote(update) {
    Y.applyUpdate(this.doc, update, REMOTE);
  }

  pushToDesmos() {
    this.pushTimer = null;
    if (this.captureTimer) this.capture();
    const state = readState(this.doc);
    if (state) this.calc.setState(state, { allowUndo: true });
    if (document.activeElement !== titleInput) titleInput.value = readTitle(this.doc);
    updateDocumentTitle();
  }

  scheduleThumbnail() {
    clearTimeout(this.thumbnailTimer);
    this.thumbnailTimer = setTimeout(() => this.uploadThumbnail(), THUMBNAIL_IDLE_MS);
  }

  uploadThumbnail() {
    clearTimeout(this.thumbnailTimer);
    this.thumbnailTimer = null;
    return new Promise((resolve) => {
      this.calc.asyncScreenshot(THUMBNAIL, async (dataUrl) => {
        try {
          if (!dataUrl?.startsWith("data:image/png")) return;
          const body = await (await fetch(dataUrl)).blob();
          await fetch(`/graphs/${graphId}/thumbnail`, { method: "POST", headers: FETCH_HEADERS, body });
        } catch {
        } finally {
          resolve();
        }
      });
    });
  }

  flushPendingCapture() {
    if (this.captureTimer) this.capture();
  }

  async leave(href) {
    this.flushPendingCapture();
    const work = [this.saver.drain()];
    if (this.thumbnailTimer) work.push(this.uploadThumbnail());
    await Promise.race([Promise.all(work), new Promise((r) => setTimeout(r, 3000))]);
    location.href = href;
  }
}

const measureContext = document.createElement("canvas").getContext("2d");

function updateDocumentTitle() {
  document.title = `${titleInput.value.trim() || "Untitled Graph"} - math`;
  measureContext.font = getComputedStyle(titleInput).font;
  const width = measureContext.measureText(titleInput.value || titleInput.placeholder).width;
  titleInput.style.width = `${Math.ceil(width) + 12}px`;
}

async function main() {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, await fetchDoc(), LOAD);
  } catch (error) {
    setStatus("error");
    throw error;
  }

  const calc = Desmos.GraphingCalculator(document.getElementById("calculator"), OPTIONS);
  const state = readState(doc);
  if (state) calc.setState(state);
  titleInput.value = readTitle(doc);
  titleInput.disabled = false;
  updateDocumentTitle();

  const session = new GraphSession(doc, calc);
  if (!state) writeState(doc, calc.getState());
  setStatus(session.saver.status);
  window.graphSession = session;

  titleInput.addEventListener("input", () => {
    updateDocumentTitle();
    session.scheduleCapture();
  });
  titleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "Escape") titleInput.blur();
  });

  document.getElementById("open-library").addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    session.leave(event.currentTarget.href);
  });

  const exit = () => {
    session.flushPendingCapture();
    session.saver.flushOnExit();
  };
  addEventListener("pagehide", exit);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") exit();
  });
  addEventListener("beforeunload", (event) => {
    session.flushPendingCapture();
    if (session.saver.failures && session.saver.queue.length) event.preventDefault();
  });
}

main();
