import type { Calculator } from "./desmos";
import type { Patches } from "./liveLayer";
import type { CaretPosition } from "./remoteCaret";

export type RowEdge = "l" | "r" | "math" | "track";
type Placement = { edge: RowEdge; field?: number; dx: number; dy: number };

export type CursorAnchor =
  | { kind: "graph"; x: number; y: number }
  | ({ kind: "row"; id: string } & Placement)
  | ({ kind: "ticker" } & Placement)
  | { kind: "panel"; dx: number; dy: number }
  | { kind: "gap"; id: string; dx: number; dy: number }
  | { kind: "below"; id: string; dx: number; dy: number }
  | { kind: "bar"; button?: number; fx: number; fy: number };

export type CursorPresence = {
  cursor?: CursorAnchor | null;
  pressed?: boolean;
  editing?: string | null;
  caret?: CaretPosition | null;
  live?: Patches | null;
  lead?: "pointer" | "caret";
};

type Point = { x: number; y: number };
type Box = { left: number; top: number; right: number; bottom: number };

const ROW = ".dcg-expressionitem[expr-id]";
const KEYPAD = ".dcg-keys-container";
const LIST = ".dcg-exppanel-container, .dcg-exp-list-resizer, .dcg-show-keypad-container";

const finite = (...values: unknown[]) => values.every((v) => typeof v === "number" && Number.isFinite(v));

function inside(box: Box, { x, y }: Point) {
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

function intersect(a: Box, b: Box): Box | null {
  const box = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return box.right > box.left && box.bottom > box.top ? box : null;
}

function rowElement(root: HTMLElement, id: string) {
  return root.querySelector<HTMLElement>(`.dcg-exppanel [expr-id="${CSS.escape(id)}"]`);
}

function listClip(root: HTMLElement) {
  const panel = root.querySelector(".dcg-exppanel");
  return panel ? intersect(panel.getBoundingClientRect(), root.getBoundingClientRect()) : null;
}

function graphClip(root: HTMLElement) {
  const graph = root.querySelector(".dcg-graph-outer");
  return graph ? intersect(graph.getBoundingClientRect(), root.getBoundingClientRect()) : null;
}

function underKeypad(root: HTMLElement, point: Point) {
  const keys = root.querySelector(".dcg-keys-container");
  return !!keys && inside(keys.getBoundingClientRect(), point);
}

const fraction = (value: number, start: number, size: number) =>
  size > 0 ? Math.round(((value - start) / size) * 10000) / 10000 : 0;
const px = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

const FIELD = ".dcg-mq-editable-field";
const TRACK = ".dcg-slider-interior";
const CONTROL = 'button, [role="button"], label, input';
const BAR_BUTTONS = 'button, [role="button"]';
const TICKER = ".dcg-exppanel-container .dcg-ticker";
const PANEL = ".dcg-exppanel-container";

function fieldRoot(block: Element, index: number) {
  return block.querySelectorAll(FIELD)[index]?.querySelector<HTMLElement>(".dcg-mq-root-block") ?? null;
}

function place(block: Element, target: Element, point: Point): Placement {
  const r = block.getBoundingClientRect();
  const dy = px(point.y - r.top);
  const track = target.closest<HTMLElement>(TRACK);
  if (track && block.contains(track)) {
    const t = track.getBoundingClientRect();
    return { edge: "track", dx: fraction(point.x, t.left, t.width), dy };
  }
  const field = target.closest(FIELD);
  const root = field && block.contains(field) ? field.querySelector<HTMLElement>(".dcg-mq-root-block") : null;
  if (field && root) {
    const m = root.getBoundingClientRect();
    if (point.x >= m.left && point.x <= m.right) {
      const index = [...block.querySelectorAll(FIELD)].indexOf(field);
      return { edge: "math", field: index, dx: px(point.x - m.left + root.scrollLeft), dy };
    }
  }
  const control = target.closest(CONTROL);
  if (control && block.contains(control)) {
    const c = control.getBoundingClientRect();
    if (c.width < r.width / 2 && c.left + c.right > r.left + r.right)
      return { edge: "r", dx: px(point.x - r.right), dy };
  }
  return { edge: "l", dx: px(point.x - r.left), dy };
}

function placed(block: Element, at: Placement): Point | null {
  const r = block.getBoundingClientRect();
  const y = clamp(r.top + at.dy, r.top, r.bottom);
  switch (at.edge) {
    case "l":
      return { x: clamp(r.left + at.dx, r.left, r.right), y };
    case "r":
      return { x: clamp(r.right + at.dx, r.left, r.right), y };
    case "track": {
      const track = block.querySelector(TRACK)?.getBoundingClientRect();
      if (!track) return { x: clamp(r.left + at.dx * r.width, r.left, r.right), y };
      return { x: track.left + at.dx * track.width, y };
    }
    case "math": {
      const root = fieldRoot(block, at.field ?? 0);
      if (!root) return null;
      const m = root.getBoundingClientRect();
      const x = m.left - root.scrollLeft + at.dx;
      return x >= m.left && x <= m.right ? { x, y } : null;
    }
  }
}

function barAnchor(bar: Element, target: Element, point: Point): CursorAnchor {
  const r = bar.getBoundingClientRect();
  const button = target.closest(BAR_BUTTONS);
  const index = button ? [...bar.querySelectorAll(BAR_BUTTONS)].indexOf(button) : -1;
  if (button && index >= 0) {
    const b = button.getBoundingClientRect();
    return {
      kind: "bar",
      button: index,
      fx: fraction(point.x, b.left, b.width),
      fy: fraction(point.y, b.top, b.height),
    };
  }
  return { kind: "bar", fx: fraction(point.x, r.left, r.width), fy: fraction(point.y, r.top, r.height) };
}

function listAnchor(root: HTMLElement, target: Element, point: Point): CursorAnchor | null {
  if (root.querySelector(".dcg-EDIT-LIST-MODE")) return null;
  const row = target.closest<HTMLElement>(ROW);
  const id = row?.getAttribute("expr-id");
  if (row && id && row.closest(".dcg-exppanel")) return { kind: "row", id, ...place(row, target, point) };
  const bar = target.closest(".dcg-expression-top-bar");
  if (bar) return barAnchor(bar, target, point);
  const ticker = target.closest(TICKER);
  if (ticker) return { kind: "ticker", ...place(ticker, target, point) };
  if (!target.closest(".dcg-exppanel")) {
    const panel = root.querySelector(PANEL)?.getBoundingClientRect();
    return panel ? { kind: "panel", dx: px(point.x - panel.left), dy: px(point.y - panel.top) } : null;
  }
  let nearest: { row: HTMLElement; id: string; distance: number } | null = null;
  let last: { row: HTMLElement; id: string; bottom: number } | null = null;
  for (const el of root.querySelectorAll<HTMLElement>(`.dcg-exppanel ${ROW}`)) {
    const elId = el.getAttribute("expr-id");
    const r = el.getBoundingClientRect();
    if (!elId || r.height <= 0) continue;
    if (!last || r.bottom >= last.bottom) last = { row: el, id: elId, bottom: r.bottom };
    const distance = point.y < r.top ? r.top - point.y : point.y > r.bottom ? point.y - r.bottom : 0;
    if (!nearest || distance < nearest.distance) nearest = { row: el, id: elId, distance };
  }
  if (!nearest || !last) return null;
  if (point.y >= last.bottom) {
    const r = last.row.getBoundingClientRect();
    return { kind: "below", id: last.id, dx: px(point.x - r.left), dy: px(point.y - r.bottom) };
  }
  const r = nearest.row.getBoundingClientRect();
  return { kind: "gap", id: nearest.id, dx: px(point.x - r.left), dy: px(point.y - r.top) };
}

export function locate(root: HTMLElement, calc: Calculator, point: Point): CursorAnchor | null {
  const target = document.elementFromPoint(point.x, point.y);
  if (!target || !root.contains(target) || target.closest(KEYPAD)) return null;

  if (target.closest(LIST)) return listAnchor(root, target, point);

  const clip = graphClip(root);
  if (!clip || !inside(clip, point)) return null;
  const origin = root.getBoundingClientRect();
  const math = calc.pixelsToMath({ x: point.x - origin.left, y: point.y - origin.top });
  return finite(math.x, math.y) ? { kind: "graph", x: math.x, y: math.y } : null;
}

function project(root: HTMLElement, calc: Calculator, anchor: CursorAnchor): { point: Point; clip: Box | null } | null {
  switch (anchor.kind) {
    case "graph": {
      const origin = root.getBoundingClientRect();
      const pixels = calc.mathToPixels({ x: anchor.x, y: anchor.y });
      return { point: { x: origin.left + pixels.x, y: origin.top + pixels.y }, clip: graphClip(root) };
    }
    case "row": {
      const row = rowElement(root, anchor.id);
      const point = row && placed(row, anchor);
      return point ? { point, clip: listClip(root) } : null;
    }
    case "ticker": {
      const ticker = root.querySelector(TICKER);
      const point = ticker && placed(ticker, anchor);
      return point ? { point, clip: intersect(ticker.getBoundingClientRect(), root.getBoundingClientRect()) } : null;
    }
    case "panel": {
      const panel = root.querySelector(PANEL)?.getBoundingClientRect();
      if (!panel) return null;
      const point = { x: clamp(panel.left + anchor.dx, panel.left, panel.right), y: panel.top + anchor.dy };
      return { point, clip: intersect(panel, root.getBoundingClientRect()) };
    }
    case "gap":
    case "below": {
      const r = rowElement(root, anchor.id)?.getBoundingClientRect();
      if (!r) return null;
      const y = anchor.kind === "gap" ? r.top + anchor.dy : r.bottom + anchor.dy;
      return { point: { x: clamp(r.left + anchor.dx, r.left, r.right), y }, clip: listClip(root) };
    }
    case "bar": {
      const bar = root.querySelector(".dcg-exppanel-container .dcg-expression-top-bar");
      if (!bar) return null;
      const clip = intersect(bar.getBoundingClientRect(), root.getBoundingClientRect());
      const button = anchor.button === undefined ? null : bar.querySelectorAll(BAR_BUTTONS)[anchor.button];
      if (anchor.button !== undefined && !button) return null;
      const r = (button ?? bar).getBoundingClientRect();
      return { point: { x: r.left + anchor.fx * r.width, y: r.top + anchor.fy * r.height }, clip };
    }
  }
}

export function resolve(root: HTMLElement, calc: Calculator, anchor: CursorAnchor): Point | null {
  const projected = project(root, calc, anchor);
  if (!projected?.clip) return null;
  const { point, clip } = projected;
  if (!finite(point.x, point.y) || !inside(clip, point) || underKeypad(root, point)) return null;
  return point;
}

export function rowBox(root: HTMLElement, id: string): Box | null {
  const row = rowElement(root, id);
  const clip = listClip(root);
  return row && clip ? intersect(row.getBoundingClientRect(), clip) : null;
}

const ROW_EDGES: RowEdge[] = ["l", "r", "math", "track"];

function isPlacement(a: Record<string, unknown>) {
  return (
    ROW_EDGES.includes(a.edge as RowEdge) &&
    finite(a.dx, a.dy) &&
    (a.field === undefined || (Number.isInteger(a.field) && (a.field as number) >= 0))
  );
}

export function isAnchor(value: unknown): value is CursorAnchor {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  switch (a.kind) {
    case "graph":
      return finite(a.x, a.y);
    case "row":
      return typeof a.id === "string" && isPlacement(a);
    case "ticker":
      return isPlacement(a);
    case "panel":
      return finite(a.dx, a.dy);
    case "gap":
    case "below":
      return typeof a.id === "string" && finite(a.dx, a.dy);
    case "bar":
      return (
        finite(a.fx, a.fy) && (a.button === undefined || (Number.isInteger(a.button) && (a.button as number) >= 0))
      );
    default:
      return false;
  }
}

export function sameAnchor(a: CursorAnchor | null, b: CursorAnchor | null) {
  return JSON.stringify(a) === JSON.stringify(b);
}
