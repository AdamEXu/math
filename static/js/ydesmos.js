import * as Y from "yjs";

export { Y };

/*
Persisted contract for a graph's Y.Doc. The server keeps every update forever, so changes here need a migration.

  meta    Y.Map    title: Y.Text
  state   Y.Map    top-level Desmos state keys except graph and expressions, plain JSON values
  graph   Y.Map    state.graph keys (viewport and settings), plain JSON values
  list    Y.Map    state.expressions keys except list and ticker, plain JSON values
  ticker  Y.Map    state.expressions.ticker as an item; empty means no ticker
  order   Y.Array  expression ids (strings) in list order
  items   Y.Map    expression id -> item

An item is a Y.Map of one expression's fields. A string under a TEXT_KEYS key is a Y.Text. An object under a
NESTED_KEYS key is itself an item. An array under a LIST_KEYS key is a Y.Array whose objects are items and whose
strings are Y.Text. Every other value, including fields Desmos adds later, is a plain JSON value.
*/
const TEXT_KEYS = new Set([
  "latex", "text", "title", "label", "description", "name", "min", "max", "step",
  "handlerLatex", "minStepLatex", "center", "width", "height", "angle", "opacity",
  "lineWidth", "lineOpacity", "pointSize", "pointOpacity", "fillOpacity", "labelAngle",
  "residualVariable", "breadth", "axisOffset",
]);
const NESTED_KEYS = new Set(["slider", "parametricDomain", "polarDomain", "domain", "clickableInfo", "vizProps", "cdf"]);
const LIST_KEYS = new Set(["columns", "values"]);

export const LOCAL = "local";
export const REMOTE = "remote";
export const LOAD = "load";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isShared = (v) => v instanceof Y.AbstractType;

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

function toShared(key, value) {
  if (typeof value === "string" && TEXT_KEYS.has(key)) return new Y.Text(value);
  if (isObject(value) && NESTED_KEYS.has(key)) return itemFrom(value);
  if (Array.isArray(value) && LIST_KEYS.has(key)) return listFrom(value);
  return value;
}

function elementToShared(value) {
  if (typeof value === "string") return new Y.Text(value);
  if (isObject(value)) return itemFrom(value);
  return value;
}

function itemFrom(obj) {
  const map = new Y.Map();
  for (const [key, value] of Object.entries(obj)) if (value !== undefined) map.set(key, toShared(key, value));
  return map;
}

function listFrom(arr) {
  const list = new Y.Array();
  list.insert(0, arr.map(elementToShared));
  return list;
}

function fromShared(value) {
  if (value instanceof Y.Text) return value.toString();
  if (value instanceof Y.Map) {
    const obj = {};
    value.forEach((v, k) => { obj[k] = fromShared(v); });
    return obj;
  }
  if (value instanceof Y.Array) return value.toArray().map(fromShared);
  return value;
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

export function syncText(ytext, next) {
  const prev = ytext.toString();
  if (prev === next) return;
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  if (start > 0 && isHigh(prev.charCodeAt(start - 1))) start--;
  let end = 0;
  while (
    end < prev.length - start && end < next.length - start &&
    prev.charCodeAt(prev.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
  ) end++;
  if (end > 0 && isLow(prev.charCodeAt(prev.length - end))) end--;
  if (prev.length - start - end) ytext.delete(start, prev.length - start - end);
  if (next.length - start - end) ytext.insert(start, next.slice(start, next.length - end));
}

function syncField(map, key, value) {
  const cur = map.get(key);
  if (typeof value === "string" && TEXT_KEYS.has(key)) {
    if (cur instanceof Y.Text) return syncText(cur, value);
  } else if (isObject(value) && NESTED_KEYS.has(key)) {
    if (cur instanceof Y.Map) return syncItem(cur, value);
  } else if (Array.isArray(value) && LIST_KEYS.has(key)) {
    if (cur instanceof Y.Array) return syncList(cur, value);
  } else if (map.has(key) && !isShared(cur) && deepEqual(cur, value)) {
    return;
  }
  map.set(key, toShared(key, value));
}

function syncItem(map, obj, plain = false) {
  for (const key of [...map.keys()]) if (!Object.hasOwn(obj, key) || obj[key] === undefined) map.delete(key);
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (!plain) syncField(map, key, value);
    else if (!map.has(key) || !deepEqual(map.get(key), value)) map.set(key, value);
  }
}

function syncElement(list, index, value) {
  const cur = list.get(index);
  if (typeof value === "string" && cur instanceof Y.Text) return syncText(cur, value);
  if (isObject(value) && cur instanceof Y.Map) return syncItem(cur, value);
  if (typeof value !== "string" && !isObject(value) && !isShared(cur) && deepEqual(cur, value)) return;
  list.delete(index, 1);
  list.insert(index, [elementToShared(value)]);
}

function syncList(list, arr) {
  const shared = Math.min(list.length, arr.length);
  for (let i = 0; i < shared; i++) syncElement(list, i, arr[i]);
  if (list.length > arr.length) list.delete(arr.length, list.length - arr.length);
  else if (arr.length > list.length) list.insert(list.length, arr.slice(list.length).map(elementToShared));
}

function syncOrder(order, ids) {
  const prev = order.toArray();
  let start = 0;
  while (start < prev.length && start < ids.length && prev[start] === ids[start]) start++;
  let end = 0;
  while (
    end < prev.length - start && end < ids.length - start &&
    prev[prev.length - 1 - end] === ids[ids.length - 1 - end]
  ) end++;
  if (prev.length - start - end) order.delete(start, prev.length - start - end);
  if (ids.length - start - end) order.insert(start, ids.slice(start, ids.length - end));
}

export function writeState(doc, state, { keepViewport = false } = {}) {
  const { graph = {}, expressions = {}, ...rest } = state;
  const { list = [], ticker, ...listRest } = expressions;
  doc.transact(() => {
    syncItem(doc.getMap("state"), rest, true);
    const graphMap = doc.getMap("graph");
    const viewport = keepViewport && graphMap.has("viewport") ? graphMap.get("viewport") : graph.viewport;
    syncItem(graphMap, { ...graph, viewport }, true);
    syncItem(doc.getMap("list"), listRest, true);
    syncItem(doc.getMap("ticker"), ticker ?? {});

    const ids = list.map((expr) => String(expr.id));
    syncOrder(doc.getArray("order"), ids);
    const items = doc.getMap("items");
    const keep = new Set(ids);
    for (const id of [...items.keys()]) if (!keep.has(id)) items.delete(id);
    for (const expr of list) {
      const id = String(expr.id);
      const cur = items.get(id);
      if (cur instanceof Y.Map && cur.get("type") === expr.type) syncItem(cur, expr);
      else items.set(id, itemFrom(expr));
    }
  }, LOCAL);
}

export function readState(doc) {
  const state = fromShared(doc.getMap("state"));
  if (!Object.keys(state).length) return null;
  const items = doc.getMap("items");
  const seen = new Set();
  const list = [];
  for (const id of doc.getArray("order").toArray()) {
    if (seen.has(id) || !items.has(id)) continue;
    seen.add(id);
    list.push(fromShared(items.get(id)));
  }
  const expressions = { ...fromShared(doc.getMap("list")), list };
  const ticker = doc.getMap("ticker");
  if (ticker.size) expressions.ticker = fromShared(ticker);
  return { ...state, graph: fromShared(doc.getMap("graph")), expressions };
}

export function readViewport(doc) {
  return doc.getMap("graph").get("viewport");
}

export function readTitle(doc) {
  return doc.getMap("meta").get("title")?.toString() ?? "";
}

export function writeTitle(doc, title) {
  doc.transact(() => {
    const meta = doc.getMap("meta");
    const cur = meta.get("title");
    if (cur instanceof Y.Text) syncText(cur, title);
    else if (title) meta.set("title", new Y.Text(title));
  }, LOCAL);
}
