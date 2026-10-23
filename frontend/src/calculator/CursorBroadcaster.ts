import type { Awareness } from "y-protocols/awareness";
import { type CursorAnchor, type CursorPresence, locate } from "./cursorAnchors";
import type { Calculator } from "./desmos";
import { readCaret } from "./remoteCaret";

const SEND_MS = 50;
const OBSERVER = "graphpaperBounds.cursors";

export class CursorBroadcaster {
  private pressed = false;
  private pointer: { x: number; y: number } | null = null;
  private sent: string | null = null;
  private lastSentAt = 0;
  private timer: number | null = null;
  private disposed = false;
  private readonly detach: (() => void)[] = [];

  constructor(
    private readonly awareness: Awareness,
    private readonly calc: Calculator,
    private readonly root: HTMLElement,
    private readonly beforeSend: () => void,
  ) {
    const on = <T extends Event>(target: EventTarget, type: string, handler: (event: T) => void, capture = true) => {
      const listener = handler as EventListener;
      target.addEventListener(type, listener, { capture, passive: true });
      this.detach.push(() => target.removeEventListener(type, listener, { capture }));
    };
    on<PointerEvent>(window, "pointermove", (event) => {
      this.pointer = { x: event.clientX, y: event.clientY };
      this.schedule();
    });
    on<PointerEvent>(window, "pointerdown", (event) => {
      this.pointer = { x: event.clientX, y: event.clientY };
      this.pressed = event.button === 0 && root.contains(event.target as Node);
      this.schedule();
    });
    const release = (event: PointerEvent) => {
      this.pressed = false;
      if (event.pointerType === "touch") this.pointer = null;
      this.schedule();
    };
    on(window, "pointerup", release);
    on(window, "pointercancel", release);
    on<PointerEvent>(document, "pointerout", (event) => {
      if (event.relatedTarget === null) this.hide();
    });
    on(window, "blur", () => this.hide());
    on(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") this.hide();
    });
    on(root, "scroll", () => this.schedule());
    const later = () => window.setTimeout(() => this.schedule());
    for (const type of ["keydown", "keyup", "input", "pointerup"]) on(root, type, later);
    on(root, "focusin", () => this.schedule(), false);
    on(root, "focusout", () => queueMicrotask(() => this.schedule()), false);
    calc.observe(OBSERVER, () => this.schedule());
    this.detach.push(() => calc.unobserve(OBSERVER));
  }

  private hide() {
    this.pointer = null;
    this.pressed = false;
    this.schedule();
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
    let cursor: CursorAnchor | null = null;
    try {
      cursor = this.pointer ? locate(this.root, this.calc, this.pointer) : null;
    } catch {
      cursor = null;
    }
    const active = this.editingElement();
    const editing = active?.closest("[expr-id]")?.getAttribute("expr-id") ?? null;
    let caret = null;
    try {
      caret = editing ? readCaret(active) : null;
    } catch {
      caret = null;
    }
    this.publish({ cursor, pressed: !!cursor && this.pressed, editing, caret });
  }

  private publish(presence: CursorPresence) {
    const key = JSON.stringify(presence);
    if (key === this.sent) return;
    if (presence.pressed || presence.caret) this.beforeSend();
    this.sent = key;
    this.lastSentAt = performance.now();
    this.awareness.setLocalState({ ...this.awareness.getLocalState(), ...presence });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    for (const detach of this.detach) detach();
    if (this.awareness.getLocalState() !== null)
      this.publish({ cursor: null, pressed: false, editing: null, caret: null });
  }
}
