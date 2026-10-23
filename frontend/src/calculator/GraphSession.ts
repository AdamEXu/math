import { updatesUrl, uploadImage, uploadThumbnail } from "../api/graphs";
import { CALCULATOR_OPTIONS, type Calculator, type DesmosApi } from "./desmos";
import { type SaveStatus, Saver } from "./saver";
import {
  LOAD,
  LOCAL,
  REMOTE,
  Y,
  deepEqual,
  readState,
  readTitle,
  readViewport,
  writeState,
  writeTitle,
} from "./ydesmos";

const CAPTURE_MS = 100;
const VIEWPORT_MS = 500;
const THUMBNAIL_IDLE_MS = 3000;
const LEAVE_TIMEOUT_MS = 3000;
const THUMBNAIL = { width: 320, height: 240, targetPixelRatio: 2 };
const DEFAULT_TITLE = /^Untitled Graph( \(\d+\))?$/;

export type SessionHooks = {
  onStatus: (status: SaveStatus) => void;
  onTitle: (title: string) => void;
  onSettled: () => void;
};

type OpenOptions = {
  graphId: string;
  doc: Uint8Array;
  desmos: DesmosApi;
  container: HTMLElement;
  titleInput: HTMLInputElement;
  hooks: SessionHooks;
};

declare global {
  interface Window {
    graphSession?: GraphSession;
  }
}

const measureContext = document.createElement("canvas").getContext("2d");

function listen<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  handler: (event: WindowEventMap[K]) => void,
): () => void;
function listen<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  handler: (event: DocumentEventMap[K]) => void,
): () => void;
function listen<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): () => void;
function listen(target: EventTarget, type: string, handler: (event: Event) => void) {
  target.addEventListener(type, handler);
  return () => target.removeEventListener(type, handler);
}

export class GraphSession {
  readonly saver: Saver;
  private captureTimer: number | null = null;
  private thumbnailTimer: number | null = null;
  private pushTimer: number | null = null;
  private lastViewportAt = 0;
  private titleOnFocus = "";
  private disposed = false;
  private readonly detachUi: (() => void)[] = [];
  private readonly detachExit: (() => void)[] = [];

  static open({ graphId, doc: update, desmos, container, titleInput, hooks }: OpenOptions) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update, LOAD);
    const calc = desmos.GraphingCalculator(container, {
      ...CALCULATOR_OPTIONS,
      imageUploadCallback: (file, callback) => {
        desmos.imageFileToDataURL(file, async (error, dataUrl) => {
          if (error) return callback(error);
          try {
            callback(null, await uploadImage(await (await fetch(dataUrl)).blob()));
          } catch (uploadError) {
            callback(uploadError);
          }
        });
      },
    });
    const state = readState(doc);
    if (state) calc.setState(state);
    titleInput.value = readTitle(doc);

    const session = new GraphSession(graphId, doc, calc, titleInput, hooks);
    session.updateDocumentTitle();
    if (!state) writeState(doc, calc.getState());
    hooks.onStatus(session.saver.status);
    window.graphSession = session;
    return session;
  }

  private constructor(
    private readonly graphId: string,
    private readonly doc: Y.Doc,
    private readonly calc: Calculator,
    private readonly titleInput: HTMLInputElement,
    private readonly hooks: SessionHooks,
  ) {
    this.saver = new Saver(updatesUrl(graphId), hooks.onStatus);

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL) {
        this.saver.push(update);
        this.scheduleThumbnail();
      } else if (origin === REMOTE) {
        this.pushTimer ??= window.setTimeout(() => this.pushToDesmos(), 0);
      }
    });
    calc.observeEvent("change", (_name, event) => {
      if (event.isUserInitiated) this.scheduleCapture();
    });
    this.bindTitle();
    this.bindExit();
  }

  private bindTitle() {
    const input = this.titleInput;
    const keepSelection = (event: MouseEvent) => event.preventDefault();
    this.detachUi.push(
      listen(input, "input", () => {
        this.updateDocumentTitle();
        this.scheduleCapture();
      }),
      listen(input, "focus", () => {
        this.titleOnFocus = input.value;
        if (!DEFAULT_TITLE.test(input.value)) return;
        input.select();
        input.addEventListener("mouseup", keepSelection, { once: true });
      }),
      listen(input, "blur", () => {
        input.removeEventListener("mouseup", keepSelection);
        if (input.value.trim() || !this.titleOnFocus.trim()) return;
        input.value = this.titleOnFocus;
        this.updateDocumentTitle();
        this.scheduleCapture();
      }),
      listen(input, "keydown", (event) => {
        if (event.key === "Enter" || event.key === "Escape") input.blur();
      }),
      () => input.removeEventListener("mouseup", keepSelection),
    );
  }

  private bindExit() {
    const exit = () => {
      this.flushPendingCapture();
      this.saver.flushOnExit();
    };
    this.detachExit.push(
      listen(window, "pagehide", exit),
      listen(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden") exit();
      }),
      listen(window, "beforeunload", (event) => {
        this.flushPendingCapture();
        if (this.saver.failures && this.saver.queue.length) event.preventDefault();
      }),
    );
  }

  scheduleCapture(delay = CAPTURE_MS) {
    if (this.disposed) return;
    this.captureTimer ??= window.setTimeout(() => this.capture(), delay);
  }

  capture() {
    if (this.captureTimer !== null) clearTimeout(this.captureTimer);
    this.captureTimer = null;
    const state = this.calc.getState();
    const now = performance.now();
    const viewportChanged = !deepEqual(state.graph?.viewport, readViewport(this.doc));
    const keepViewport = viewportChanged && now - this.lastViewportAt < VIEWPORT_MS;
    const title = this.titleInput.value;
    this.doc.transact(() => {
      writeState(this.doc, state, { keepViewport });
      writeTitle(this.doc, title.trim() ? title : "");
    }, LOCAL);
    if (keepViewport) this.scheduleCapture(VIEWPORT_MS - (now - this.lastViewportAt));
    else if (viewportChanged) this.lastViewportAt = now;
  }

  applyRemote(update: Uint8Array) {
    Y.applyUpdate(this.doc, update, REMOTE);
  }

  private pushToDesmos() {
    this.pushTimer = null;
    if (this.captureTimer !== null) this.capture();
    const state = readState(this.doc);
    if (state) this.calc.setState(state, { allowUndo: true });
    if (document.activeElement !== this.titleInput) this.titleInput.value = readTitle(this.doc);
    this.updateDocumentTitle();
  }

  private scheduleThumbnail() {
    if (this.thumbnailTimer !== null) clearTimeout(this.thumbnailTimer);
    this.thumbnailTimer = window.setTimeout(() => void this.uploadThumbnail(), THUMBNAIL_IDLE_MS);
  }

  private uploadThumbnail() {
    if (this.thumbnailTimer !== null) clearTimeout(this.thumbnailTimer);
    this.thumbnailTimer = null;
    return new Promise<void>((resolve) => {
      this.calc.asyncScreenshot(THUMBNAIL, async (dataUrl) => {
        try {
          if (!dataUrl?.startsWith("data:image/png")) return;
          await uploadThumbnail(this.graphId, await (await fetch(dataUrl)).blob());
        } catch {
        } finally {
          resolve();
        }
      });
    });
  }

  updateDocumentTitle() {
    const input = this.titleInput;
    this.hooks.onTitle(input.value.trim() || "Untitled Graph");
    if (!measureContext) return;
    measureContext.font = getComputedStyle(input).font;
    const width = measureContext.measureText(input.value || input.placeholder).width;
    input.style.width = `${Math.ceil(width) + 12}px`;
  }

  flushPendingCapture() {
    if (this.captureTimer !== null) this.capture();
  }

  async leave() {
    this.flushPendingCapture();
    const work: Promise<unknown>[] = [this.saver.drain()];
    if (this.thumbnailTimer !== null) work.push(this.uploadThumbnail());
    await Promise.race([Promise.all(work), new Promise((resolve) => setTimeout(resolve, LEAVE_TIMEOUT_MS))]);
  }

  dispose() {
    if (this.disposed) return;
    this.flushPendingCapture();
    this.disposed = true;
    for (const detach of this.detachUi) detach();
    if (this.pushTimer !== null) clearTimeout(this.pushTimer);
    if (window.graphSession === this) delete window.graphSession;

    const screenshot = this.thumbnailTimer !== null ? this.uploadThumbnail() : Promise.resolve();
    void screenshot.then(() => {
      this.calc.destroy();
      this.doc.destroy();
    });
    const release = () => {
      this.saver.stop();
      for (const detach of this.detachExit) detach();
    };
    this.saver.onStatus = (status) => {
      if (status === "saved") release();
    };
    void Promise.all([this.saver.drain(), screenshot]).then(([drained]) => {
      if (drained) release();
      this.hooks.onSettled();
    });
  }
}
