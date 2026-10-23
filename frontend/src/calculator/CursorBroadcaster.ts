import type { Awareness } from "y-protocols/awareness";
import { type CursorAnchor, type CursorPresence, locate, sameAnchor } from "./cursorAnchors";
import type { Calculator } from "./desmos";
import type { Patches } from "./liveLayer";
import { readCaret } from "./remoteCaret";

const SEND_MS = 50;
const EXIT_STEPS = 10;

type Point = { x: number; y: number };
const OBSERVER = "graphpaperBounds.cursors";

export type BroadcastHooks = {
  beforeCaret: () => void;
  beginDrag: () => void;
  endDrag: () => void;
  live: () => Patches | null;
};

export class CursorBroadcaster {
  private pressed = false;
  private lead: "pointer" | "caret" = "pointer";
  private pointer: Point | null = null;
  private inside: Point | null = null;
  private leftAt: Point | null = null;
  private sentCursor: CursorAnchor | null = null;
  private sent: string | null = null;
  private lastSentAt = 0;
  private timer: number | null = null;
  private disposed = false;
  private readonly detach: (() => void)[] = [];

  constructor(
    private readonly awareness: Awareness,
    private readonly calc: Calculator,
    private readonly root: HTMLElement,
    private readonly hooks: BroadcastHooks,
  ) {
    const on = <T extends Event>(target: EventTarget, type: string, handler: (event: T) => void, capture = true) => {
      const listener = handler as EventListener;
      target.addEventListener(type, listener, { capture, passive: true });
      this.detach.push(() => target.removeEventListener(type, listener, { capture }));
    };
    on<PointerEvent>(window, "pointermove", (event) => {
      this.pointer = { x: event.clientX, y: event.clientY };
      this.lead = "pointer";
      this.schedule();
    });
    on<PointerEvent>(window, "pointerdown", (event) => {
      this.pointer = { x: event.clientX, y: event.clientY };
      this.lead = "pointer";
      this.setPressed(event.button === 0 && root.contains(event.target as Node));
      this.schedule();
    });
    const release = (event: PointerEvent) => {
      this.setPressed(false);
      if (event.pointerType === "touch") this.pointer = null;
      this.schedule();
    };
    on(window, "pointerup", release);
    on(window, "pointercancel", release);
    on<PointerEvent>(document, "pointerout", (event) => {
      if (event.relatedTarget !== null) return;
      this.leftAt = { x: event.clientX, y: event.clientY };
      this.hide();
    });
    on<FocusEvent>(window, "blur", (event) => {
      if (event.target === window) this.hide();
    });
    on(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") this.hide();
    });
    on(root, "scroll", () => this.schedule());
    on(root, "keydown", () => {
      this.lead = "caret";
    });
    const later = () => window.setTimeout(() => this.schedule());
    for (const type of ["keydown", "keyup", "input", "pointerup"]) on(root, type, later);
    on(root, "focusin", () => this.schedule(), false);
    on(root, "focusout", () => queueMicrotask(() => this.schedule()), false);
    calc.observe(OBSERVER, () => this.schedule());
    this.detach.push(() => calc.unobserve(OBSERVER));
  }

  private hide() {
    this.pointer = null;
    this.setPressed(false);
    this.schedule();
  }

  private setPressed(pressed: boolean) {
    if (pressed === this.pressed) return;
    this.pressed = pressed;
    if (pressed) this.hooks.beginDrag();
    else this.hooks.endDrag();
  }

  private editingElement() {
    const active = document.activeElement;
    return active && this.root.contains(active) && active.closest(".dcg-exppanel") ? active : null;
  }

  private schedule() {
    if (this.disposed || this.timer !== null) return;
    const wait = SEND_MS - (performance.now() - this.lastSentAt);
    if (wait <= 0) this.send();
    else this.timer = window.setTimeout(() => this.send(), wait);
  }

  private send() {
    this.timer = null;
    if (this.disposed) return;
    let cursor = this.pointer ? this.locate(this.pointer) : null;
    let exiting = false;
    if (cursor) {
      this.inside = this.pointer;
    } else if (this.sentCursor) {
      const exit = this.exitAnchor();
      if (exit && !sameAnchor(exit, this.sentCursor)) {
        cursor = exit;
        exiting = true;
      }
    }
    this.leftAt = null;
    if (!cursor) this.inside = null;
    const active = this.editingElement();
    const editing = active?.closest("[expr-id]")?.getAttribute("expr-id") ?? null;
    let caret = null;
    try {
      caret = editing ? readCaret(active) : null;
    } catch {
      caret = null;
    }
    const live = this.pressed ? this.hooks.live() : null;
    this.publish({ cursor, pressed: !!cursor && this.pressed, editing, caret, live, lead: this.lead });
    if (exiting) this.timer = window.setTimeout(() => this.send(), SEND_MS);
  }

  private locate(point: Point) {
    try {
      return locate(this.root, this.calc, point);
    } catch {
      return null;
    }
  }

  private exitAnchor() {
    const end = this.leftAt ?? this.pointer;
    if (!end || !this.inside) return null;
    let inside: Point = this.inside;
    const direct = this.locate(end);
    if (direct) return direct;
    let outside = end;
    for (let i = 0; i < EXIT_STEPS; i++) {
      const mid: Point = { x: (inside.x + outside.x) / 2, y: (inside.y + outside.y) / 2 };
      if (this.locate(mid)) inside = mid;
      else outside = mid;
    }
    return this.locate(inside);
  }

  private publish(presence: CursorPresence) {
    const key = JSON.stringify(presence);
    if (key === this.sent) return;
    if (presence.caret) this.hooks.beforeCaret();
    this.sent = key;
    this.sentCursor = presence.cursor ?? null;
    this.lastSentAt = performance.now();
    this.awareness.setLocalState({ ...this.awareness.getLocalState(), ...presence });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    for (const detach of this.detach) detach();
    if (this.awareness.getLocalState() !== null)
      this.publish({ cursor: null, pressed: false, editing: null, caret: null, live: null });
  }
}
