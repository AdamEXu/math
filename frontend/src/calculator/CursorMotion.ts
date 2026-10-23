import { type CursorAnchor, resolve, rowBox, sameAnchor } from "./cursorAnchors";
import type { Calculator } from "./desmos";
import { type CaretPosition, caretBox } from "./remoteCaret";

const SMOOTHING_MS = 55;
const SETTLED_PX = 0.3;
const TIP_PX = 4;
const OBSERVER = "graphpaperBounds.liveCursors";

export type RemoteCursor = {
  clientId: number;
  cursor: CursorAnchor | null;
  pressed: boolean;
  editing: string | null;
  caret: CaretPosition | null;
};

type Point = { x: number; y: number };

type Track = {
  anchor: CursorAnchor | null;
  pressed: boolean;
  editing: string | null;
  caret: CaretPosition | null;
  residual: Point;
  shown: Point | null;
  cursorEl: HTMLElement | null;
  editEl: HTMLElement | null;
  caretEl: HTMLElement | null;
  cursorStyle: string;
  editStyle: string;
  caretStyle: string;
};

export class CursorMotion {
  private readonly tracks = new Map<number, Track>();
  private frame: number | null = null;
  private lastFrameAt = 0;
  private disposed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly calc: Calculator,
  ) {
    calc.observe(OBSERVER, () => this.render(0));
  }

  private track(clientId: number) {
    let track = this.tracks.get(clientId);
    if (!track) {
      track = {
        anchor: null,
        pressed: false,
        editing: null,
        caret: null,
        residual: { x: 0, y: 0 },
        shown: null,
        cursorEl: null,
        editEl: null,
        caretEl: null,
        cursorStyle: "",
        editStyle: "",
        caretStyle: "",
      };
      this.tracks.set(clientId, track);
    }
    return track;
  }

  private locate(anchor: CursorAnchor | null) {
    if (!anchor) return null;
    try {
      return resolve(this.root, this.calc, anchor);
    } catch {
      return null;
    }
  }

  update(remotes: RemoteCursor[]) {
    if (this.disposed) return;
    const live = new Set<number>();
    for (const remote of remotes) {
      live.add(remote.clientId);
      const track = this.track(remote.clientId);
      if (!sameAnchor(track.anchor, remote.cursor)) {
        const target = this.locate(remote.cursor);
        const glide = track.shown && target && !remote.pressed;
        track.residual = glide ? { x: track.shown!.x - target.x, y: track.shown!.y - target.y } : { x: 0, y: 0 };
        track.anchor = remote.cursor;
      }
      track.pressed = remote.pressed;
      track.editing = remote.editing;
      track.caret = remote.caret;
    }
    for (const id of this.tracks.keys()) if (!live.has(id)) this.tracks.delete(id);
    this.render(0);
    this.loop();
  }

  bindCursor(clientId: number, el: HTMLElement | null) {
    const track = this.track(clientId);
    track.cursorEl = el;
    track.cursorStyle = "";
  }

  bindEditing(clientId: number, el: HTMLElement | null) {
    const track = this.track(clientId);
    track.editEl = el;
    track.editStyle = "";
  }

  bindCaret(clientId: number, el: HTMLElement | null) {
    const track = this.track(clientId);
    track.caretEl = el;
    track.caretStyle = "";
  }

  private loop() {
    if (this.frame !== null || this.disposed || !this.tracks.size) return;
    this.lastFrameAt = performance.now();
    const step = (now: number) => {
      this.frame = null;
      if (this.disposed || !this.tracks.size) return;
      this.render(Math.min(now - this.lastFrameAt, 100));
      this.lastFrameAt = now;
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  private render(dt: number) {
    if (this.disposed) return;
    const decay = Math.exp(-dt / SMOOTHING_MS);
    for (const track of this.tracks.values()) {
      const target = this.locate(track.anchor);
      if (target) {
        const r = track.residual;
        r.x = Math.abs(r.x * decay) < SETTLED_PX ? 0 : r.x * decay;
        r.y = Math.abs(r.y * decay) < SETTLED_PX ? 0 : r.y * decay;
        track.shown = { x: target.x + r.x, y: target.y + r.y };
      } else {
        track.shown = null;
        track.residual = { x: 0, y: 0 };
      }
      const cursorStyle = track.shown
        ? `translate3d(${(track.shown.x - TIP_PX).toFixed(1)}px, ${(track.shown.y - TIP_PX).toFixed(1)}px, 0)`
        : "none";
      if (track.cursorEl && cursorStyle !== track.cursorStyle) {
        track.cursorStyle = cursorStyle;
        track.cursorEl.style.display = track.shown ? "" : "none";
        if (track.shown) track.cursorEl.style.transform = cursorStyle;
      }

      let box = null;
      try {
        box = track.editing ? rowBox(this.root, track.editing) : null;
      } catch {
        box = null;
      }
      const caret = box && track.caret?.id === track.editing ? this.caretIn(track.caret, box) : null;
      this.renderCaret(track, caret);
      const editStyle = box
        ? `${box.left},${box.top},${box.right - box.left},${box.bottom - box.top},${caret ? 1 : 0}`
        : "none";
      if (track.editEl && editStyle !== track.editStyle) {
        track.editStyle = editStyle;
        track.editEl.classList.toggle("has-caret", !!caret);
        const style = track.editEl.style;
        style.display = box ? "" : "none";
        if (box) {
          style.left = `${box.left}px`;
          style.top = `${box.top}px`;
          style.width = `${box.right - box.left}px`;
          style.height = `${box.bottom - box.top}px`;
        }
      }
    }
  }

  private caretIn(caret: CaretPosition, box: { left: number; top: number; right: number; bottom: number }) {
    try {
      const found = caretBox(this.root, caret);
      if (!found || found.x < box.left || found.x > box.right) return null;
      const top = Math.max(found.top, box.top);
      const bottom = Math.min(found.top + found.height, box.bottom);
      if (bottom <= top) return null;
      const selection = found.selection && {
        left: Math.max(found.selection.left, box.left),
        right: Math.min(found.selection.right, box.right),
      };
      return { x: found.x, top, height: bottom - top, selection };
    } catch {
      return null;
    }
  }

  private renderCaret(track: Track, caret: ReturnType<CursorMotion["caretIn"]>) {
    const el = track.caretEl;
    if (!el) return;
    const sel = caret?.selection && caret.selection.right > caret.selection.left ? caret.selection : null;
    const key = caret
      ? `${caret.x.toFixed(1)},${caret.top.toFixed(1)},${caret.height.toFixed(1)},${sel ? `${sel.left},${sel.right}` : ""}`
      : "none";
    if (key === track.caretStyle) return;
    track.caretStyle = key;
    el.style.display = caret ? "" : "none";
    if (!caret) return;
    el.style.transform = `translate3d(${caret.x.toFixed(1)}px, ${caret.top.toFixed(1)}px, 0)`;
    el.style.height = `${caret.height}px`;
    const highlight = el.firstElementChild as HTMLElement | null;
    if (!highlight) return;
    highlight.style.display = sel ? "" : "none";
    if (sel) {
      highlight.style.left = `${sel.left - caret.x}px`;
      highlight.style.width = `${sel.right - sel.left}px`;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    try {
      this.calc.unobserve(OBSERVER);
    } catch {}
    this.tracks.clear();
  }
}
