import { type CursorAnchor, resolve, rowBox, sameAnchor } from "./cursorAnchors";
import type { Calculator } from "./desmos";
import { type CaretPosition, caretBox } from "./remoteCaret";

const SMOOTHING_MS = 55;
const SETTLED_PX = 0.3;
const TIP_PX = 4;
const OBSERVER = "graphpaperBounds.liveCursors";
const HISTORY_MS = 100;
const EXIT_MS = 160;
const FADE_MS = 120;
const MOVING_PX_PER_MS = 0.05;
const HANDOFF_MS = 150;
const TAG_FADE_MS = 120;
const POINTER_TAG = { x: 16, y: 17 };

export type RemoteCursor = {
  clientId: number;
  cursor: CursorAnchor | null;
  pressed: boolean;
  editing: string | null;
  caret: CaretPosition | null;
  lead: "pointer" | "caret" | null;
  leaving?: boolean;
};

type Point = { x: number; y: number };
type Sample = Point & { t: number };
type Exit = Point & { vx: number; vy: number; start: number; duration: number };
type Visual = Point & { opacity: number };
type TagHost = "pointer" | "caret" | "outline";
type Tag = {
  el: HTMLElement | null;
  prefer: "pointer" | "caret";
  host: TagHost | null;
  pos: Point | null;
  from: Point | null;
  since: number;
  opacity: number;
  style: string;
};

type Track = {
  anchor: CursorAnchor | null;
  pressed: boolean;
  editing: string | null;
  caret: CaretPosition | null;
  residual: Point;
  shown: Point | null;
  history: Sample[];
  exit: Exit | null;
  cursorEl: HTMLElement | null;
  editEl: HTMLElement | null;
  caretEl: HTMLElement | null;
  cursorStyle: string;
  editStyle: string;
  caretStyle: string;
  tag: Tag;
  frozen: boolean;
};

export class CursorMotion {
  private readonly tracks = new Map<number, Track>();
  private frame: number | null = null;
  private lastFrameAt = 0;
  private layer: HTMLElement | null = null;
  private clip = "";
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
        history: [],
        exit: null,
        cursorEl: null,
        editEl: null,
        caretEl: null,
        cursorStyle: "",
        editStyle: "",
        caretStyle: "",
        tag: { el: null, prefer: "pointer", host: null, pos: null, from: null, since: 0, opacity: 0, style: "" },
        frozen: false,
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
      track.frozen = !!remote.leaving;
      if (track.frozen) continue;
      const caretMoved = !!remote.caret && JSON.stringify(remote.caret) !== JSON.stringify(track.caret);
      const startedEditing = !!remote.editing && remote.editing !== track.editing;
      const pointerMoved = !!remote.cursor && !sameAnchor(track.anchor, remote.cursor);
      if (remote.lead) track.tag.prefer = remote.lead;
      else if (caretMoved || startedEditing) track.tag.prefer = "caret";
      else if (pointerMoved) track.tag.prefer = "pointer";
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

  bindLayer(el: HTMLElement | null) {
    this.layer = el;
    this.clip = "";
  }

  private clipLayer() {
    if (!this.layer) return;
    const r = this.root.getBoundingClientRect();
    let path = `M${r.left} ${r.top}H${r.right}V${r.bottom}H${r.left}Z`;
    const keys = this.root.querySelector(".dcg-keys-container")?.getBoundingClientRect();
    if (keys && keys.width > 0 && keys.height > 0)
      path += `M${keys.left} ${keys.top}H${keys.right}V${keys.bottom}H${keys.left}Z`;
    const clip = `path(evenodd, "${path}")`;
    if (clip === this.clip) return;
    this.clip = clip;
    this.layer.style.clipPath = clip;
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

  bindTag(clientId: number, el: HTMLElement | null) {
    const tag = this.track(clientId).tag;
    tag.el = el;
    tag.style = "";
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
    this.clipLayer();
    for (const track of this.tracks.values()) {
      if (track.frozen) continue;
      const now = performance.now();
      const target = this.locate(track.anchor);
      if (target) {
        const r = track.residual;
        r.x = Math.abs(r.x * decay) < SETTLED_PX ? 0 : r.x * decay;
        r.y = Math.abs(r.y * decay) < SETTLED_PX ? 0 : r.y * decay;
        track.shown = { x: target.x + r.x, y: target.y + r.y };
        track.exit = null;
        track.history.push({ ...track.shown, t: now });
        while (track.history.length > 2 && now - (track.history[0] as Sample).t > HISTORY_MS) track.history.shift();
      } else {
        if (track.shown) track.exit = this.exitFrom(track.shown, track.history, now);
        track.shown = null;
        track.history = [];
        track.residual = { x: 0, y: 0 };
      }
      const pointer = this.renderCursor(track, now);

      let box = null;
      try {
        box = track.editing ? rowBox(this.root, track.editing) : null;
      } catch {
        box = null;
      }
      const caret = box && track.caret?.id === track.editing ? this.caretIn(track.caret, box) : null;
      this.renderCaret(track, caret);
      this.renderTag(track, now, dt, pointer, caret, box);
      const editStyle = box
        ? `${box.left},${box.top},${box.right - box.left},${box.bottom - box.top},${caret ? 1 : 0}`
        : "none";
      if (track.editEl && editStyle !== track.editStyle) {
        track.editStyle = editStyle;
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

  private exitFrom(from: Point, history: Sample[], now: number): Exit {
    const first = history[0];
    const last = history[history.length - 1];
    const span = first && last ? last.t - first.t : 0;
    const fresh = !!last && now - last.t < HISTORY_MS;
    let vx = 0;
    let vy = 0;
    if (first && last && fresh && span >= 16) {
      vx = (last.x - first.x) / span;
      vy = (last.y - first.y) / span;
    }
    const moving = Math.hypot(vx, vy) >= MOVING_PX_PER_MS;
    return moving
      ? { ...from, vx, vy, start: now, duration: EXIT_MS }
      : { ...from, vx: 0, vy: 0, start: now, duration: FADE_MS };
  }

  private renderTag(
    track: Track,
    now: number,
    dt: number,
    pointer: Visual | null,
    caret: { x: number; top: number } | null,
    box: { right: number; top: number } | null,
  ) {
    const tag = track.tag;
    const el = tag.el;
    if (!el) return;
    const height = el.offsetHeight;
    const hosts: Record<TagHost, Visual | null> = {
      pointer: pointer && {
        x: pointer.x - TIP_PX + POINTER_TAG.x,
        y: pointer.y - TIP_PX + POINTER_TAG.y,
        opacity: pointer.opacity,
      },
      caret: caret && { x: caret.x - 1, y: caret.top - height - 1, opacity: 1 },
      outline: !caret && box ? { x: box.right + 4, y: box.top - 2, opacity: 1 } : null,
    };
    const order: TagHost[] = tag.prefer === "caret" ? ["caret", "outline", "pointer"] : ["pointer", "caret", "outline"];
    const host = order.find((kind) => hosts[kind]) ?? null;
    const spot = host ? (hosts[host] as Visual) : null;
    if (host && host !== tag.host) {
      tag.from = tag.pos && tag.opacity > 0 ? tag.pos : null;
      tag.since = now;
      tag.host = host;
    }
    if (spot) {
      const t = tag.from ? Math.min(1, (now - tag.since) / HANDOFF_MS) : 1;
      const ease = 1 - (1 - t) ** 3;
      tag.pos = tag.from
        ? { x: tag.from.x + (spot.x - tag.from.x) * ease, y: tag.from.y + (spot.y - tag.from.y) * ease }
        : { x: spot.x, y: spot.y };
      if (t >= 1) tag.from = null;
      tag.opacity = host === "pointer" ? spot.opacity : Math.min(1, tag.opacity + dt / TAG_FADE_MS);
    } else {
      tag.host = null;
      tag.opacity = Math.max(0, tag.opacity - (dt || TAG_FADE_MS) / TAG_FADE_MS);
    }
    const visible = !!tag.pos && tag.opacity > 0;
    const style = visible
      ? `${tag.pos!.x.toFixed(1)},${tag.pos!.y.toFixed(1)},${tag.opacity.toFixed(2)},${tag.host === "pointer" ? 1 : 0}`
      : "none";
    if (style === tag.style) return;
    tag.style = style;
    el.style.display = visible ? "block" : "none";
    if (!visible) return;
    el.style.transform = `translate3d(${tag.pos!.x.toFixed(1)}px, ${tag.pos!.y.toFixed(1)}px, 0)`;
    el.style.opacity = tag.opacity < 1 ? tag.opacity.toFixed(2) : "";
    el.classList.toggle("at-caret", tag.host !== null && tag.host !== "pointer");
  }

  private renderCursor(track: Track, now: number): Visual | null {
    let point = track.shown;
    let opacity = 1;
    const exit = track.exit;
    if (!point && exit) {
      const elapsed = now - exit.start;
      if (elapsed >= exit.duration) {
        track.exit = null;
      } else {
        const travel = elapsed * (1 - elapsed / (2 * exit.duration));
        point = { x: exit.x + exit.vx * travel, y: exit.y + exit.vy * travel };
        opacity = 1 - elapsed / exit.duration;
      }
    }
    const cursorStyle = point
      ? `translate3d(${(point.x - TIP_PX).toFixed(1)}px, ${(point.y - TIP_PX).toFixed(1)}px, 0)|${opacity.toFixed(2)}`
      : "none";
    const visual = point && { ...point, opacity };
    if (!track.cursorEl || cursorStyle === track.cursorStyle) return visual;
    track.cursorStyle = cursorStyle;
    const style = track.cursorEl.style;
    style.display = point ? "" : "none";
    if (!point) return visual;
    style.transform = cursorStyle.slice(0, cursorStyle.indexOf("|"));
    style.opacity = opacity < 1 ? opacity.toFixed(2) : "";
    return visual;
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
