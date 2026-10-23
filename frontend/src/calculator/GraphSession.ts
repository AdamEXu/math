import { IndexeddbPersistence } from "y-indexeddb";
import { uploadImage, uploadThumbnail } from "../api/graphs";
import type { Role } from "../api/types";
import { CALCULATOR_OPTIONS, type Calculator, type DesmosApi } from "./desmos";
import { CursorBroadcaster } from "./CursorBroadcaster";
import { applyToCalculator, localView } from "./remote";
import { type ConnectionStatus, GraphSocket } from "./socket";
import {
  LOAD,
  LOCAL,
  Y,
  type DesmosState,
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
  onStatus: (status: ConnectionStatus) => void;
  onTitle: (title: string) => void;
  onRole: (role: Role) => void;
  onRevoked: () => void;
  onSignedOut: () => void;
  onSettled: () => void;
};

type OpenOptions = {
  graphId: string;
  userId: string;
  role: Role;
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

function timeout(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function mathBounds(viewport: unknown) {
  if (!viewport || typeof viewport !== "object") return undefined;
  const { xmin, xmax, ymin, ymax } = viewport as Record<string, unknown>;
  if (![xmin, xmax, ymin, ymax].every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  return { left: xmin as number, right: xmax as number, bottom: ymin as number, top: ymax as number };
}

export class GraphSession {
  readonly socket: GraphSocket;
  private captureTimer: number | null = null;
  private thumbnailTimer: number | null = null;
  private lastViewportAt = 0;
  private titleOnFocus = "";
  private remoteDirty = false;
  private applyingRemote = false;
  private disposed = false;
  private readonly detachUi: (() => void)[] = [];
  private readonly cursors: CursorBroadcaster | null = null;

  static async open({ graphId, userId, role, doc: update, desmos, container, titleInput, hooks }: OpenOptions) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update, LOAD);
    const persistence = role === "viewer" ? null : new IndexeddbPersistence(`math-graph:${graphId}:${userId}`, doc);
    await persistence?.whenSynced;

    const readonly = role === "viewer";
    const calc = desmos.GraphingCalculator(container, {
      ...CALCULATOR_OPTIONS,
      ...(readonly ? { authorFeatures: false, expressionsTopbar: false } : {}),
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
    if (state) calc.setState(readonly ? localView(state, state, true) : state);
    titleInput.value = readTitle(doc);
    titleInput.readOnly = readonly;

    const session = new GraphSession(graphId, role, doc, calc, container, persistence, titleInput, hooks);
    session.updateDocumentTitle();
    if (!state && !readonly) writeState(doc, calc.getState());
    window.graphSession = session;
    return session;
  }

  private constructor(
    private readonly graphId: string,
    readonly role: Role,
    private readonly doc: Y.Doc,
    readonly calc: Calculator,
    readonly container: HTMLElement,
    private readonly persistence: IndexeddbPersistence | null,
    private readonly titleInput: HTMLInputElement,
    private readonly hooks: SessionHooks,
  ) {
    this.socket = new GraphSocket(graphId, doc, role, {
      onStatus: hooks.onStatus,
      onRole: hooks.onRole,
      onRevoked: hooks.onRevoked,
      onSignedOut: hooks.onSignedOut,
      beforeRemote: () => this.flushPendingCapture(),
      afterRemote: () => this.pushToDesmos(),
    });

    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL) this.scheduleThumbnail();
      else this.remoteDirty = true;
    });
    calc.observeEvent("change", (_name, event) => {
      if (event.isUserInitiated && !this.applyingRemote) this.scheduleCapture();
    });
    if (this.canEdit) {
      this.bindTitle();
      this.cursors = new CursorBroadcaster(this.socket.awareness, calc, container, () => this.capture());
    }
    this.bindExit();
  }

  get canEdit() {
    return this.role !== "viewer";
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
    this.detachUi.push(
      listen(window, "pagehide", () => this.flushPendingCapture()),
      listen(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden") this.flushPendingCapture();
      }),
    );
  }

  scheduleCapture(delay = CAPTURE_MS) {
    if (this.disposed || !this.canEdit) return;
    this.captureTimer ??= window.setTimeout(() => this.capture(), delay);
  }

  capture() {
    if (this.captureTimer !== null) clearTimeout(this.captureTimer);
    this.captureTimer = null;
    if (!this.canEdit) return;
    const state = this.calc.getState();
    const now = performance.now();
    const owner = this.role === "owner";
    const viewportChanged = owner && !deepEqual(state.graph?.viewport, readViewport(this.doc));
    const throttled = viewportChanged && now - this.lastViewportAt < VIEWPORT_MS;
    const title = this.titleInput.value;
    this.doc.transact(() => {
      writeState(this.doc, state, { keepViewport: !owner || throttled });
      writeTitle(this.doc, title.trim() ? title : "");
    }, LOCAL);
    if (throttled) this.scheduleCapture(VIEWPORT_MS - (now - this.lastViewportAt));
    else if (viewportChanged) this.lastViewportAt = now;
  }

  private pushToDesmos() {
    if (!this.remoteDirty || this.disposed) return;
    this.remoteDirty = false;
    const target = readState(this.doc);
    if (target) {
      this.applyingRemote = true;
      try {
        const local: DesmosState = this.calc.getState();
        applyToCalculator(this.calc, localView(target, local, !this.canEdit));
      } finally {
        this.applyingRemote = false;
      }
    }
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
    const bounds = mathBounds(readViewport(this.doc));
    const options = bounds ? { ...THUMBNAIL, mode: "contain" as const, mathBounds: bounds } : THUMBNAIL;
    return new Promise<void>((resolve) => {
      this.calc.asyncScreenshot(options, async (dataUrl) => {
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
    const work: Promise<unknown>[] = [this.socket.whenIdle()];
    if (this.thumbnailTimer !== null) work.push(this.uploadThumbnail());
    await Promise.race([Promise.all(work), timeout(LEAVE_TIMEOUT_MS)]);
  }

  dispose() {
    if (this.disposed) return;
    this.flushPendingCapture();
    this.disposed = true;
    this.cursors?.dispose();
    for (const detach of this.detachUi) detach();
    if (window.graphSession === this) delete window.graphSession;

    const screenshot = this.thumbnailTimer !== null ? this.uploadThumbnail() : Promise.resolve();
    void Promise.race([Promise.all([this.socket.whenIdle(), screenshot]), timeout(LEAVE_TIMEOUT_MS)]).then(() => {
      this.socket.dispose();
      void this.persistence?.destroy();
      this.calc.destroy();
      this.doc.destroy();
      this.hooks.onSettled();
    });
  }
}
