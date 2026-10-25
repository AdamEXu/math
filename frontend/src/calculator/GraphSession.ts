import { IndexeddbPersistence } from "y-indexeddb";
import { uploadImage, uploadThumbnail } from "../api/graphs";
import type { Role } from "../api/types";
import { CALCULATOR_OPTIONS, type Calculator, type DesmosApi } from "./desmos";
import { CursorBroadcaster } from "./CursorBroadcaster";
import {
  type Patches,
  type Tick,
  diffItems,
  isPatches,
  isPlaying,
  itemsById,
  lerpLatex,
  patchApplied,
  sameTick,
  sliderSettings,
  tickOf,
  withPatches,
  withTick,
} from "./liveLayer";
import { routeUndo } from "./desmosInternals";
import { applyToCalculator, expressionFocused, focusExpressionEnd, localView } from "./remote";
import { type ConnectionStatus, GraphSocket } from "./socket";
import { UndoHistory, affectedId, stepOf } from "./undo";
import {
  LOAD,
  LOCAL,
  LOCAL_QUIET,
  Y,
  type DesmosState,
  type Json,
  deepEqual,
  readState,
  readTitle,
  readViewport,
  isLocalOrigin,
  writeState,
  writeTitle,
  writeView,
} from "./ydesmos";

const CAPTURE_MS = 100;
const VIEWPORT_MS = 500;
const THUMBNAIL_IDLE_MS = 3000;
const RETIRE_MS = 1000;
const TWEEN_MS = 50;
const MAX_TWEEN_MS = 150;

type Tween = { type: unknown; from: string; to: string; start: number; duration: number; shown: string };
const TICKER_POLL_MS = 150;
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
  needsThumbnail?: boolean;
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

function tickerPlaying(state: DesmosState) {
  return state.expressions?.ticker?.playing === true;
}

function undoKey(event: KeyboardEvent) {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey) return "redo";
  return null;
}

function latexById(state: DesmosState) {
  return new Map((state.expressions?.list ?? []).map((item) => [String(item.id), item.latex]));
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
  private dragging = false;
  private dragPatches: Patches | null = null;
  private readonly remoteLive = new Map<number, Patches>();
  private readonly liveBase = new Map<number, Patches>();
  private readonly liveAt = new Map<number, number>();
  private readonly tweens = new Map<string, Tween>();
  private tweenFrame: number | null = null;
  private readonly retired = new Map<number, { patches: Patches; base: Patches; until: number }>();
  private retireTimer: number | null = null;
  private readonly committedTicks = new Map<string, Tick>();
  private sliderKeys = new Map<string, string>();
  private readonly playStarts = new Map<string, Tick>();
  private readonly tickerTouched = new Set<string>();
  private readonly userTouched = new Set<string>();
  private tickerSeen = new Map<string, Json | undefined>();
  private tickerTimer: number | null = null;
  private readonly history: UndoHistory | null = null;
  private refreshUndo: () => void = () => undefined;

  static async open({
    graphId,
    userId,
    role,
    doc: update,
    desmos,
    container,
    titleInput,
    needsThumbnail,
    hooks,
  }: OpenOptions) {
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
    calc.clearHistory();
    titleInput.value = readTitle(doc);
    titleInput.readOnly = readonly;

    const session = new GraphSession(graphId, role, doc, calc, container, persistence, titleInput, hooks);
    session.updateDocumentTitle();
    if (!state && !readonly) doc.transact(() => writeState(doc, calc.getState()), LOCAL_QUIET);
    else if (needsThumbnail && !readonly) session.scheduleThumbnail();
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
      beforeRemote: () => this.beforeRemote(),
      afterRemote: () => this.pushToDesmos(),
    });

    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (isLocalOrigin(origin)) this.scheduleThumbnail();
      if (origin !== LOCAL && origin !== LOCAL_QUIET) this.remoteDirty = true;
    });
    if (this.canEdit) this.history = new UndoHistory(doc);
    this.bindUndo();
    const initial = calc.getState();
    this.rememberCommitted(initial);
    this.trackSliders(initial, false);
    this.watchTicker(initial);
    calc.observeEvent("change", (_name, event) => {
      const user = event.isUserInitiated && !this.applyingRemote;
      const state = this.calc.getState();
      const sliderChanged = this.trackSliders(state, user);
      const tickerEdited = user && this.noteUserEdits(state);
      this.watchTicker(state);
      if (sliderChanged || tickerEdited) this.capture();
      else if (user) this.scheduleCapture();
    });
    this.socket.awareness.on("change", this.onAwareness);
    if (this.canEdit) {
      this.bindTitle();
      this.cursors = new CursorBroadcaster(this.socket.awareness, calc, container, {
        beforeCaret: () => this.capture(),
        beginDrag: () => this.beginDrag(),
        endDrag: () => this.endDrag(),
        live: () => (this.dragPatches = this.ownPatches()),
      });
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

  private bindUndo() {
    const route = routeUndo(this.calc, {
      undo: () => this.undo(),
      redo: () => this.redo(),
      canUndo: () => this.canEdit && !!this.history?.canUndo,
      canRedo: () => this.canEdit && !!this.history?.canRedo,
    });
    if (route) {
      this.refreshUndo = route.refresh;
      this.detachUi.push(route.detach);
      for (const name of ["stack-item-added", "stack-item-popped", "stack-cleared"] as const)
        this.history?.manager.on(name, route.refresh);
      route.refresh();
    } else {
      const onClick = (event: MouseEvent) => {
        const button = (event.target as Element | null)?.closest(".dcg-action-undo, .dcg-action-redo");
        if (!button) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (button.classList.contains("dcg-action-undo")) this.undo();
        else this.redo();
      };
      this.container.addEventListener("click", onClick, true);
      this.detachUi.push(() => this.container.removeEventListener("click", onClick, true));
    }
    const onKey = (event: KeyboardEvent) => {
      const kind = undoKey(event);
      const target = event.target as Node | null;
      if (!kind || (target !== document.body && !this.container.contains(target))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this[kind]();
    };
    window.addEventListener("keydown", onKey, true);
    this.detachUi.push(() => window.removeEventListener("keydown", onKey, true));
  }

  undo() {
    this.travel("undo");
  }

  redo() {
    this.travel("redo");
  }

  private travel(kind: "undo" | "redo") {
    const history = this.history;
    if (!history || !this.canEdit || this.disposed || this.dragging) return;
    this.flushPendingCapture();
    const before = readState(this.doc);
    const focused = expressionFocused(this.container);
    if (!history.pop(kind)) return;
    this.pushToDesmos();
    const id = affectedId(before, readState(this.doc));
    if (focused && id) focusExpressionEnd(this.container, id);
    this.refreshUndo();
  }

  private bindExit() {
    this.detachUi.push(
      listen(window, "pagehide", () => this.flushPendingCapture()),
      listen(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden") this.flushPendingCapture();
      }),
    );
  }

  private beforeRemote() {
    if (this.dragging) this.dragPatches = this.ownPatches();
    this.flushPendingCapture();
  }

  private beginDrag() {
    if (!this.canEdit || this.disposed) return;
    this.dragging = true;
    this.dragPatches = null;
  }

  private endDrag() {
    if (!this.dragging) return;
    this.dragging = false;
    this.dragPatches = null;
    this.history?.cut();
    this.capture();
    this.history?.cut();
  }

  private trackSliders(state: DesmosState, user: boolean) {
    const keys = new Map<string, string>();
    let changed = false;
    for (const item of state.expressions?.list ?? []) {
      const key = sliderSettings(item);
      if (key === null) continue;
      const id = String(item.id);
      keys.set(id, key);
      if (user && this.sliderKeys.get(id) !== key) {
        this.playStarts.set(id, tickOf(item));
        changed = true;
      }
    }
    this.sliderKeys = keys;
    return changed;
  }

  private watchTicker(state: DesmosState) {
    if (tickerPlaying(state)) {
      if (this.tickerTimer === null) {
        this.tickerSeen = latexById(state);
        this.tickerTimer = window.setInterval(() => this.pollTicker(), TICKER_POLL_MS);
      }
      return;
    }
    if (this.tickerTimer !== null) clearInterval(this.tickerTimer);
    this.tickerTimer = null;
    this.tickerTouched.clear();
    this.userTouched.clear();
  }

  private pollTicker() {
    const state = this.calc.getState();
    if (!tickerPlaying(state)) return this.watchTicker(state);
    this.learnTicks(state);
    this.tickerSeen = latexById(state);
    this.userTouched.clear();
  }

  private learnTicks(state: DesmosState) {
    if (this.tickerTimer === null) return;
    for (const item of state.expressions?.list ?? []) {
      const id = String(item.id);
      const seen = this.tickerSeen;
      if (seen.has(id) && seen.get(id) !== item.latex && !this.userTouched.has(id) && !isPlaying(item))
        this.tickerTouched.add(id);
    }
  }

  private noteUserEdits(state: DesmosState) {
    if (this.tickerTimer === null) return false;
    const selected = this.calc.selectedExpressionId;
    let edited = false;
    for (const [id, value] of latexById(state)) {
      if (this.tickerSeen.get(id) === value) continue;
      if (this.tickerTouched.has(id) && id !== selected) continue;
      if (this.tickerTouched.delete(id)) edited = true;
      this.userTouched.add(id);
      this.tickerSeen.set(id, value);
    }
    return edited;
  }

  private rememberCommitted(state: DesmosState) {
    this.committedTicks.clear();
    for (const item of state.expressions?.list ?? []) this.committedTicks.set(String(item.id), tickOf(item));
  }

  private remoteLayers() {
    return [...this.remoteLive.values(), ...[...this.retired.values()].map((entry) => entry.patches)];
  }

  private ownPatches() {
    const committed = readState(this.doc);
    if (!committed) return null;
    const local = this.calc.getState();
    const items = itemsById(local);
    const remote = this.remoteLayers();
    return diffItems(
      local,
      committed,
      (id, key) =>
        ((key === "latex" || key === "slider") && isPlaying(items.get(id))) ||
        (key === "latex" && this.tickerTouched.has(id)) ||
        remote.some((layer) => !!layer[id] && key in layer[id]),
    );
  }

  private withoutEphemeral(state: DesmosState, committed: DesmosState): DesmosState {
    const docItems = itemsById(committed);
    const remote = this.remoteLayers();
    const ticking = tickerPlaying(state) && tickerPlaying(committed);
    const list = (state.expressions?.list ?? []).map((item) => {
      const id = String(item.id);
      const prev = docItems.get(id);
      if (!prev || prev.type !== item.type) return item;
      let next = item;
      for (const layer of remote) for (const key of Object.keys(layer[id] ?? {})) next = { ...next, [key]: prev[key] };
      if (isPlaying(item)) next = withTick(next, this.playStarts.get(id) ?? tickOf(prev));
      if (ticking && this.tickerTouched.has(id)) next = { ...next, latex: prev.latex };
      return next;
    });
    return { ...state, expressions: { ...state.expressions, list } };
  }

  private keepTicking(target: DesmosState, committed: DesmosState, local: DesmosState): DesmosState {
    const localItems = itemsById(local);
    const committedItems = itemsById(committed);
    const ticking = tickerPlaying(committed) && tickerPlaying(local);
    const list = (target.expressions?.list ?? []).map((item) => {
      const id = String(item.id);
      const mine = localItems.get(id);
      const unchanged = sameTick(this.committedTicks.get(id), tickOf(committedItems.get(id)));
      if (ticking && unchanged && mine && this.tickerTouched.has(id)) return { ...item, latex: mine.latex };
      return isPlaying(item) && isPlaying(mine) && unchanged ? withTick(item, tickOf(mine)) : item;
    });
    return { ...target, expressions: { ...target.expressions, list } };
  }

  private readonly onAwareness = ({
    added,
    updated,
    removed,
  }: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => {
    if (this.disposed) return;
    const awareness = this.socket.awareness;
    const states = awareness.getStates();
    let changed = false;
    for (const clientId of [...added, ...updated, ...removed]) {
      if (clientId === awareness.clientID) continue;
      const live = states.get(clientId)?.live;
      const next = isPatches(live) ? live : null;
      const prev = this.remoteLive.get(clientId) ?? null;
      if (deepEqual(prev, next)) continue;
      changed = true;
      if (next) {
        this.startTweens(clientId, prev, next);
        this.remoteLive.set(clientId, next);
        this.retired.delete(clientId);
        this.liveBase.set(clientId, this.committedFields(next, this.liveBase.get(clientId)));
      } else if (prev) {
        for (const id of Object.keys(prev)) this.tweens.delete(id);
        this.liveAt.delete(clientId);
        this.remoteLive.delete(clientId);
        const base = this.liveBase.get(clientId) ?? {};
        this.liveBase.delete(clientId);
        this.retired.set(clientId, { patches: prev, base, until: performance.now() + RETIRE_MS });
      }
    }
    if (!changed) return;
    this.armRetireTimer();
    this.beforeRemote();
    this.remoteDirty = true;
    this.pushToDesmos();
  };

  private startTweens(clientId: number, prev: Patches | null, next: Patches) {
    const now = performance.now();
    const last = this.liveAt.get(clientId);
    const duration = last === undefined ? TWEEN_MS : Math.min(MAX_TWEEN_MS, Math.max(16, now - last));
    this.liveAt.set(clientId, now);
    let types: Map<string, unknown> | null = null;
    for (const [id, patch] of Object.entries(next)) {
      const to = patch.latex;
      const running = this.tweens.get(id);
      const from = running ? this.tweenValue(running, now) : prev?.[id]?.latex;
      if (typeof to !== "string" || typeof from !== "string" || from === to || lerpLatex(from, to, 0) === null) {
        this.tweens.delete(id);
        continue;
      }
      types ??= new Map([...itemsById(readState(this.doc) ?? {})].map(([key, item]) => [key, item.type]));
      this.tweens.set(id, { type: types.get(id), from, to, start: now, duration, shown: from });
    }
    if (this.tweenFrame !== null) cancelAnimationFrame(this.tweenFrame);
    this.tweenFrame = this.tweens.size ? requestAnimationFrame(this.runTweens) : null;
  }

  private readonly runTweens = () => {
    this.tweenFrame = null;
    if (this.disposed) return;
    const now = performance.now();
    for (const [id, tween] of this.tweens) {
      const value = this.tweenValue(tween, now);
      if (value !== tween.shown) {
        tween.shown = value;
        this.applyingRemote = true;
        try {
          this.calc.setExpression({ id, type: tween.type as Json, latex: value });
        } catch {
          this.tweens.delete(id);
        } finally {
          this.applyingRemote = false;
        }
      }
      if (now - tween.start >= tween.duration) this.tweens.delete(id);
    }
    if (this.tweens.size) this.tweenFrame = requestAnimationFrame(this.runTweens);
  };

  private tweenValue(tween: Tween, now: number) {
    const t = Math.min(1, (now - tween.start) / tween.duration);
    return lerpLatex(tween.from, tween.to, t) ?? tween.to;
  }

  private tweened(layers: Patches[]) {
    if (!this.tweens.size) return layers;
    const now = performance.now();
    return layers.map((layer) => {
      let out = layer;
      for (const [id, tween] of this.tweens)
        if (layer[id]?.latex !== undefined)
          out = { ...out, [id]: { ...layer[id], latex: this.tweenValue(tween, now) } };
      return out;
    });
  }

  private committedFields(patches: Patches, known: Patches = {}) {
    const missing = Object.entries(patches).some(([id, patch]) =>
      Object.keys(patch).some((key) => !known[id] || !(key in known[id])),
    );
    if (!missing) return known;
    const items = itemsById(readState(this.doc) ?? {});
    const base: Patches = { ...known };
    for (const [id, patch] of Object.entries(patches)) {
      const item = items.get(id);
      if (!item) continue;
      const fields = { ...base[id] };
      for (const key of Object.keys(patch)) if (!(key in fields)) fields[key] = item[key] ?? null;
      base[id] = fields;
    }
    return base;
  }

  private pruneRetired(committed: DesmosState) {
    const now = performance.now();
    for (const [clientId, entry] of this.retired)
      if (now >= entry.until || !patchApplied(committed, entry.base) || patchApplied(committed, entry.patches))
        this.retired.delete(clientId);
  }

  private armRetireTimer() {
    if (this.retireTimer !== null) clearTimeout(this.retireTimer);
    this.retireTimer = null;
    if (!this.retired.size || this.disposed) return;
    const until = Math.min(...[...this.retired.values()].map((entry) => entry.until));
    this.retireTimer = window.setTimeout(
      () => {
        this.retireTimer = null;
        this.remoteDirty = true;
        this.pushToDesmos();
        this.armRetireTimer();
      },
      Math.max(0, until - performance.now()) + 10,
    );
  }

  scheduleCapture(delay = CAPTURE_MS) {
    if (this.disposed || !this.canEdit) return;
    this.captureTimer ??= window.setTimeout(() => this.capture(), delay);
  }

  capture() {
    if (this.captureTimer !== null) clearTimeout(this.captureTimer);
    this.captureTimer = null;
    if (!this.canEdit || this.dragging) return;
    const committed = readState(this.doc);
    const local = this.calc.getState();
    this.learnTicks(local);
    const state = committed ? this.withoutEphemeral(local, committed) : local;
    this.playStarts.clear();
    this.rememberCommitted(state);
    const now = performance.now();
    const owner = this.role === "owner";
    const viewportChanged = owner && !deepEqual(state.graph?.viewport, readViewport(this.doc));
    const throttled = viewportChanged && now - this.lastViewportAt < VIEWPORT_MS;
    const title = this.titleInput.value;
    this.history?.before(stepOf(committed, state));
    this.doc.transact(() => writeState(this.doc, state, { keepViewport: true }), LOCAL);
    this.doc.transact(() => {
      if (owner && !throttled) writeView(this.doc, state.graph);
      writeTitle(this.doc, title.trim() ? title : "");
    }, LOCAL_QUIET);
    if (throttled) this.scheduleCapture(VIEWPORT_MS - (now - this.lastViewportAt));
    else if (viewportChanged) this.lastViewportAt = now;
  }

  private pushToDesmos() {
    if (!this.remoteDirty || this.disposed) return;
    this.remoteDirty = false;
    const committed = readState(this.doc);
    if (committed) {
      this.pruneRetired(committed);
      const layers = this.tweened(this.remoteLayers());
      if (this.dragging && this.dragPatches) layers.push(this.dragPatches);
      this.applyingRemote = true;
      try {
        const local: DesmosState = this.calc.getState();
        const target = this.keepTicking(withPatches(committed, layers), committed, local);
        this.rememberCommitted(committed);
        applyToCalculator(this.calc, localView(target, local, !this.canEdit));
      } finally {
        this.applyingRemote = false;
      }
      const applied = this.calc.getState();
      this.watchTicker(applied);
      if (this.tickerTimer !== null) this.tickerSeen = latexById(applied);
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
    this.endDrag();
    this.flushPendingCapture();
    const work: Promise<unknown>[] = [this.socket.whenIdle()];
    if (this.thumbnailTimer !== null) work.push(this.uploadThumbnail());
    await Promise.race([Promise.all(work), timeout(LEAVE_TIMEOUT_MS)]);
  }

  dispose() {
    if (this.disposed) return;
    this.endDrag();
    this.flushPendingCapture();
    this.disposed = true;
    this.cursors?.dispose();
    this.history?.destroy();
    this.socket.awareness.off("change", this.onAwareness);
    if (this.retireTimer !== null) clearTimeout(this.retireTimer);
    if (this.tweenFrame !== null) cancelAnimationFrame(this.tweenFrame);
    if (this.tickerTimer !== null) clearInterval(this.tickerTimer);
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
