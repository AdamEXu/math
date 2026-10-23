import type { Calculator } from "./desmos";
import type { Patches } from "./liveLayer";
import type { CaretPosition } from "./remoteCaret";

export type CursorAnchor =
  | { kind: "graph"; x: number; y: number }
  | { kind: "row"; id: string; fx: number; fy: number }
  | { kind: "below"; id: string; fx: number; dy: number }
  | { kind: "bar"; fx: number; fy: number };

export type CursorPresence = {
  cursor?: CursorAnchor | null;
  pressed?: boolean;
  editing?: string | null;
  caret?: CaretPosition | null;
  live?: Patches | null;
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

const fraction = (value: number, start: number, size: number) => (size > 0 ? (value - start) / size : 0);

function rowAnchor(row: HTMLElement, id: string, point: Point): CursorAnchor {
  const r = row.getBoundingClientRect();
  return { kind: "row", id, fx: fraction(point.x, r.left, r.width), fy: fraction(point.y, r.top, r.height) };
}

function listAnchor(root: HTMLElement, target: Element, point: Point): CursorAnchor | null {
  if (root.querySelector(".dcg-EDIT-LIST-MODE")) return null;
  const row = target.closest<HTMLElement>(ROW);
  const id = row?.getAttribute("expr-id");
  if (row && id && row.closest(".dcg-exppanel")) return rowAnchor(row, id, point);
  const bar = target.closest(".dcg-expression-top-bar");
  if (bar) {
    const r = bar.getBoundingClientRect();
    return { kind: "bar", fx: fraction(point.x, r.left, r.width), fy: fraction(point.y, r.top, r.height) };
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
    return { kind: "below", id: last.id, fx: fraction(point.x, r.left, r.width), dy: point.y - r.bottom };
  }
  return rowAnchor(nearest.row, nearest.id, point);
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
      const r = rowElement(root, anchor.id)?.getBoundingClientRect();
      if (!r) return null;
      return { point: { x: r.left + anchor.fx * r.width, y: r.top + anchor.fy * r.height }, clip: listClip(root) };
    }
    case "below": {
      const r = rowElement(root, anchor.id)?.getBoundingClientRect();
      if (!r) return null;
      return { point: { x: r.left + anchor.fx * r.width, y: r.bottom + anchor.dy }, clip: listClip(root) };
    }
    case "bar": {
      const bar = root.querySelector(".dcg-exppanel-container .dcg-expression-top-bar");
      if (!bar) return null;
      const r = bar.getBoundingClientRect();
      const clip = intersect(r, root.getBoundingClientRect());
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

export function isAnchor(value: unknown): value is CursorAnchor {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  switch (a.kind) {
    case "graph":
      return finite(a.x, a.y);
    case "row":
      return typeof a.id === "string" && finite(a.fx, a.fy);
    case "below":
      return typeof a.id === "string" && finite(a.fx, a.dy);
    case "bar":
      return finite(a.fx, a.fy);
    default:
      return false;
  }
}

export function sameAnchor(a: CursorAnchor | null, b: CursorAnchor | null) {
  return JSON.stringify(a) === JSON.stringify(b);
}
