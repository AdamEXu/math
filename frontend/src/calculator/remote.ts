import type { Calculator } from "./desmos";
import { type DesmosItem, type DesmosState, type Json, VIEW_KEYS, deepEqual } from "./ydesmos";

type Item = DesmosItem;
type Settings = Record<string, Json | undefined>;
type Plan = {
  settings: Settings | null;
  remove: string[];
  patches: Item[];
  shield: string[];
  append: Item[];
  blanks: string[];
  actions: Action[];
};
type Action = { type: string } & Record<string, Json>;
type Controller = { dispatch(action: Action): void };

const VIEW = new Set<string>(VIEW_KEYS);
const TOP_SETTINGS = new Set(["randomSeed"]);
const STRING_DEFAULTS: Record<string, string> = {
  xAxisArrowMode: "NONE",
  yAxisArrowMode: "NONE",
  xAxisScale: "linear",
  yAxisScale: "linear",
};
// Desmos silently drops a trailing empty expression whenever another item is appended after it.
const PLACEHOLDER = "\\ ";
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

function tickerActions(local: Json | undefined, wanted: Json | undefined): Action[] {
  const before = isObject(local) ? local : {};
  const after = isObject(wanted) ? wanted : {};
  const actions: Action[] = [];
  if (after.open && !before.open) actions.push({ type: "open-ticker" });
  if (before.handlerLatex !== after.handlerLatex)
    actions.push({ type: "update-ticker-handlerlatex", latex: after.handlerLatex ?? "" });
  if (before.minStepLatex !== after.minStepLatex)
    actions.push({ type: "update-ticker-minsteplatex", latex: after.minStepLatex ?? "" });
  if (!!before.playing !== !!after.playing) actions.push({ type: "toggle-ticker" });
  if (!!before.secret !== !!after.secret) actions.push({ type: "toggle-ticker-secret" });
  if (before.open && !after.open) actions.push({ type: "close-ticker" });
  return actions;
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
    if (key === "collapsed") continue;
    if (key === "slider") Object.assign(props, sliderProps(after));
    else if (after !== undefined) props[key] = after;
    else if (cleared(key, before) !== undefined) props[key] = cleared(key, before);
  }
  return props;
}

const creatable = (item: Item) => item.folderId === undefined && item.type !== "image";
const isBlank = (item: Item | undefined) => item?.type === "expression" && !item.latex;

function listPlan(localList: Item[], wantedList: Item[]) {
  const localById = new Map(localList.map((item) => [idOf(item), item]));
  const wantedIds = new Set(wantedList.map(idOf));
  const kept = localList.filter((item) => wantedIds.has(idOf(item)));
  let stay = 0;
  let cursor = 0;
  for (const item of wantedList) {
    if (localById.get(idOf(item))?.type !== item.type) break;
    while (cursor < kept.length && idOf(kept[cursor] as Item) !== idOf(item)) cursor++;
    if (cursor === kept.length) break;
    cursor++;
    stay++;
  }
  const staying = wantedList.slice(0, stay);
  const stayIds = new Set(staying.map(idOf));
  const append = wantedList.slice(stay);
  if (!append.every(creatable)) return null;
  const shield = append.length && isBlank(staying.at(-1)) ? [idOf(staying.at(-1) as Item)] : [];
  return {
    remove: localList.map(idOf).filter((id) => !stayIds.has(id)),
    patches: staying
      .filter((item) => !deepEqual(localById.get(idOf(item)), item))
      .map((item) => apiProps(localById.get(idOf(item)), item))
      .filter((props) => Object.keys(props).length > 2),
    shield,
    append: append.map((item) => ({ ...apiProps(undefined, item), ...(isBlank(item) && { latex: PLACEHOLDER }) })),
    blanks: [...shield, ...append.filter(isBlank).map(idOf)],
    actions: wantedList
      .filter((item) => item.type === "folder" && !!item.collapsed !== !!localById.get(idOf(item))?.collapsed)
      .map((item) => ({ type: "set-folder-collapsed", id: idOf(item), isCollapsed: item.collapsed === true })),
  };
}

function plan(local: DesmosState, wanted: DesmosState): Plan | null {
  const settings = settingsPlan(local, wanted);
  if (settings === false) return null;
  const list = listPlan(local.expressions?.list ?? [], wanted.expressions?.list ?? []);
  if (!list) return null;
  const ticker = tickerActions(local.expressions?.ticker, wanted.expressions?.ticker);
  return { settings, ...list, actions: [...list.actions, ...ticker] };
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

function dispatch(calc: Calculator, action: Action) {
  // The public API cannot toggle folders or drive the ticker; the result is verified and falls back to setState.
  try {
    (calc as { controller?: Controller }).controller?.dispatch(action);
  } catch {}
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

  const steps = plan(local, wanted);
  if (steps) {
    calc.withHistoryReplacement(() => {
      if (steps.settings) calc.updateSettings(steps.settings);
      if (steps.remove.length) calc.removeExpressions(steps.remove.map((id) => ({ id })));
      for (const patch of steps.patches) calc.setExpression(patch);
      for (const id of steps.shield) calc.setExpression({ type: "expression", id, latex: PLACEHOLDER });
      for (const item of steps.append) calc.setExpression(item);
      for (const id of steps.blanks) calc.setExpression({ type: "expression", id, latex: "" });
      for (const action of steps.actions) dispatch(calc, action);
    });
    if (deepEqual(withoutView(calc.getState()), withoutView(wanted))) {
      if (steps.remove.length) keep();
      return "patched";
    }
  }
  calc.setState(wanted, { allowUndo: true });
  keep();
  return "replaced";
}
