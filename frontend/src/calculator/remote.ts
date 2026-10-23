import type { Calculator } from "./desmos";
import { DesmosInternals, tickerActions } from "./desmosInternals";
import { type DesmosItem, type DesmosState, type Json, VIEW_KEYS, deepEqual } from "./ydesmos";

type Item = DesmosItem;
type Settings = Record<string, Json | undefined>;

const VIEW = new Set<string>(VIEW_KEYS);
const TOP_SETTINGS = new Set(["randomSeed"]);
const INTERNAL_KEYS = new Set(["colorLatex", "description", "clickableInfo", "collapsed"]);
const STRING_DEFAULTS: Record<string, string> = {
  xAxisArrowMode: "NONE",
  yAxisArrowMode: "NONE",
  xAxisScale: "linear",
  yAxisScale: "linear",
};
const FIELD = ".dcg-mq-editable-field";
const CURSOR = "dcg-mq-cursor";

const idOf = (item: Item) => String(item.id);
const isObject = (value: unknown): value is Record<string, Json | undefined> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function localView(target: DesmosState, local: DesmosState, readonly: boolean): DesmosState {
  const graph = { ...target.graph };
  for (const key of VIEW_KEYS) {
    if (local.graph?.[key] !== undefined) graph[key] = local.graph[key];
    else delete graph[key];
  }
  const list = (target.expressions?.list ?? []).map((item) => (readonly ? { ...item, readonly: true } : item));
  return { ...target, graph, expressions: { ...target.expressions, list } };
}

function cleared(key: string, before: unknown): Json | undefined {
  if (typeof before === "boolean") return !before;
  if (typeof before === "number") return 0;
  if (typeof before === "string") return STRING_DEFAULTS[key] ?? "";
  return undefined;
}

function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>, skip: Set<string> = new Set()) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => !skip.has(key) && !deepEqual(a[key], b[key]));
}

function settingsPlan(local: DesmosState, wanted: DesmosState): Settings | null | false {
  const { graph: localGraph = {}, expressions: localExpr = {}, ...localTop } = local;
  const { graph: wantedGraph = {}, expressions: wantedExpr = {}, ...wantedTop } = wanted;
  const { list: _l, ticker: _lt, ...localListMeta } = localExpr;
  const { list: _w, ticker: _wt, ...wantedListMeta } = wantedExpr;
  if (changedKeys(localListMeta, wantedListMeta).length) return false;
  const top = changedKeys(localTop, wantedTop);
  if (top.some((key) => !TOP_SETTINGS.has(key))) return false;
  const settings: Settings = {};
  for (const key of top) settings[key] = wantedTop[key];
  for (const key of changedKeys(localGraph, wantedGraph, VIEW))
    settings[key] = wantedGraph[key] ?? cleared(key, localGraph[key]);
  return Object.keys(settings).length ? settings : null;
}

function sliderProps(slider: Json | undefined): Item {
  const s = isObject(slider) ? slider : {};
  return {
    sliderBounds: { min: s.min ?? "", max: s.max ?? "", step: s.step ?? "" },
    playing: s.isPlaying === true,
  };
}

function apiProps(local: Item | undefined, wanted: Item): Item {
  const props: Item = { type: wanted.type, id: idOf(wanted) };
  for (const key of changedKeys(local ?? {}, wanted, new Set(["type", "id"]))) {
    const before = local?.[key];
    const after = wanted[key];
    if (INTERNAL_KEYS.has(key)) continue;
    if (key === "slider") Object.assign(props, sliderProps(after));
    else if (after !== undefined) props[key] = after;
    else if (cleared(key, before) !== undefined) props[key] = cleared(key, before);
  }
  return props;
}

function withoutView(state: DesmosState): DesmosState {
  const graph = { ...state.graph };
  for (const key of VIEW_KEYS) delete graph[key];
  return { ...state, graph };
}

type Focus = { root: Element; id: string; field: number; offset: number | null };

function readFocus(): Focus | null {
  const field = document.activeElement?.closest(FIELD);
  const row = field?.closest("[expr-id]");
  const id = row?.getAttribute("expr-id");
  const calcRoot = row?.closest(".dcg-container");
  if (!field || !row || !id || !calcRoot) return null;
  const root = field.querySelector(".dcg-mq-root-block");
  const children = root ? [...root.children] : [];
  const at = children.findIndex((el) => el.classList.contains(CURSOR));
  return { root: calcRoot, id, field: [...row.querySelectorAll(FIELD)].indexOf(field), offset: at < 0 ? null : at };
}

function restoreFocus(focus: Focus) {
  const row = focus.root.querySelector(`[expr-id="${CSS.escape(focus.id)}"]`);
  const field = row?.querySelectorAll(FIELD)[focus.field];
  const input = field?.querySelector("textarea");
  if (!input || field?.contains(document.activeElement)) return;
  input.focus();
  if (focus.offset === null) return;
  const press = (key: string, keyCode: number) =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, keyCode, which: keyCode, bubbles: true }));
  press("Home", 36);
  for (let i = 0; i < focus.offset; i++) press("ArrowRight", 39);
}

const folderOf = (item: Item) => (typeof item.folderId === "string" ? item.folderId : "");
const shape = (list: Item[]) => list.map((item) => [idOf(item), item.type, folderOf(item)]);
const byId = (state: DesmosState) => new Map((state.expressions?.list ?? []).map((item) => [idOf(item), item]));

function pick(item: Item, keys: Set<string>): Item {
  return Object.fromEntries(Object.entries(item).filter(([key]) => keys.has(key)));
}

function longestOrderedRun(positions: number[]) {
  const tails: number[] = [];
  const parent: number[] = [];
  for (const [i, position] of positions.entries()) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((positions[tails[mid] as number] as number) < position) lo = mid + 1;
      else hi = mid;
    }
    parent[i] = lo ? (tails[lo - 1] as number) : -1;
    tails[lo] = i;
  }
  const run = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = parent[i] as number) run.add(i);
  return run;
}

function applyList(calc: Calculator, internals: DesmosInternals | null, local: Item[], wanted: Item[]) {
  const wantedIds = new Set(wanted.map(idOf));
  const keptIds = new Set(local.map(idOf).filter((id) => wantedIds.has(id)));
  const doomed = local.filter((item) => !keptIds.has(idOf(item)));
  const parents = new Set(local.filter((item) => keptIds.has(idOf(item))).map((item) => item.folderId));
  const emptied = (folder: Item) => !parents.has(folder.id);
  const early = doomed.filter((item) => item.type !== "folder" || emptied(item));
  const late = doomed.filter((item) => !early.includes(item));
  const remove = (items: Item[]) => items.length && calc.removeExpressions(items.map((item) => ({ id: idOf(item) })));

  if (!internals) {
    const kept = local.filter((item) => keptIds.has(idOf(item)));
    if (!deepEqual(shape(kept), shape(wanted))) return false;
    remove(doomed);
    return true;
  }
  remove(early);
  const localIndex = new Map(local.map((item, index) => [idOf(item), index]));
  const kept = wanted.filter((item) => keptIds.has(idOf(item)));
  const run = longestOrderedRun(kept.map((item) => localIndex.get(idOf(item)) as number));
  const anchored = new Set([...run].map((i) => idOf(kept[i] as Item)));
  let previous: string | null = null;
  for (const item of wanted) {
    const id = idOf(item);
    const after = previous === null ? -1 : internals.indexOf(previous);
    previous = id;
    if (!keptIds.has(id)) {
      if (!internals.insert(item, after + 1)) return false;
      continue;
    }
    const at = internals.indexOf(id);
    const target = anchored.has(id) ? at : at > after ? after + 1 : after;
    if (!internals.place(id, target, folderOf(item))) return false;
    if (internals.typeOf(id) !== item.type && !internals.replace(item)) return false;
  }
  remove(late);
  return true;
}

function applyItems(calc: Calculator, internals: DesmosInternals | null, wanted: Item[]) {
  let current = byId(calc.getState());
  const stale = (item: Item) => !deepEqual(current.get(idOf(item)), item);
  for (const item of wanted.filter(stale)) {
    const before = current.get(idOf(item)) ?? {};
    if (item.type !== "image") {
      const props = apiProps(before, item);
      if (Object.keys(props).length > 2) calc.setExpression(props);
    }
    const [was, now] =
      item.type === "image" ? [before, item] : [pick(before, INTERNAL_KEYS), pick(item, INTERNAL_KEYS)];
    const actions = internals?.propActions(idOf(item), String(item.type), was, now);
    for (const action of actions ?? []) if (!internals?.dispatch(action)) return false;
  }
  current = byId(calc.getState());
  for (const item of wanted.filter(stale)) if (!internals?.replace(item)) return false;
  return true;
}

function patch(calc: Calculator, local: DesmosState, wanted: DesmosState) {
  const settings = settingsPlan(local, wanted);
  if (settings === false) return false;
  const internals = DesmosInternals.of(calc);
  const wantedList = wanted.expressions?.list ?? [];
  if (settings) calc.updateSettings(settings);
  if (!applyList(calc, internals, local.expressions?.list ?? [], wantedList)) return false;
  if (!applyItems(calc, internals, wantedList)) return false;
  const ticker = tickerActions(local.expressions?.ticker, wanted.expressions?.ticker);
  if (ticker.length && !internals) return false;
  return ticker.every((action) => internals?.dispatch(action));
}

export function applyToCalculator(calc: Calculator, wanted: DesmosState) {
  const local = calc.getState();
  if (deepEqual(local, wanted)) return "unchanged";
  const selected = calc.selectedExpressionId;
  const focus = readFocus();
  const keep = () => {
    const ids = new Set((calc.getState().expressions?.list ?? []).map(idOf));
    if (selected && ids.has(selected) && calc.selectedExpressionId !== selected) calc.setSelectedExpressionId(selected);
    if (focus && ids.has(focus.id)) restoreFocus(focus);
  };

  let patched = false;
  calc.withHistoryReplacement(() => {
    try {
      patched = patch(calc, local, wanted);
    } catch {
      patched = false;
    }
  });
  if (patched && deepEqual(withoutView(calc.getState()), withoutView(wanted))) {
    keep();
    return "patched";
  }
  calc.setState(wanted, { allowUndo: true });
  keep();
  return "replaced";
}
