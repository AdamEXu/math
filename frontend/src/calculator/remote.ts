import type { Calculator } from "./desmos";
import { type DesmosItem, type DesmosState, VIEW_KEYS, deepEqual } from "./ydesmos";

type Item = DesmosItem;
type Primitive = string | number | boolean;

const APPENDABLE = new Set(["expression", "text"]);

const isPrimitive = (value: unknown): value is Primitive =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

function withoutList(state: DesmosState) {
  const { expressions = {}, ...rest } = state;
  const { list: _list, ...listRest } = expressions;
  return { ...rest, expressions: listRest };
}

export function localView(target: DesmosState, local: DesmosState, readonly: boolean): DesmosState {
  const graph = { ...target.graph };
  for (const key of VIEW_KEYS) {
    if (local.graph?.[key] !== undefined) graph[key] = local.graph[key];
    else delete graph[key];
  }
  const list = (target.expressions?.list ?? []).map((item) => (readonly ? { ...item, readonly: true } : item));
  return { ...target, graph, expressions: { ...target.expressions, list } };
}

function patchFor(local: Item, wanted: Item): Item | null {
  if (local.type !== wanted.type) return null;
  const keys = new Set([...Object.keys(local), ...Object.keys(wanted)]);
  const patch: Item = { type: wanted.type, id: wanted.id };
  if (wanted.id === undefined) return null;
  for (const key of keys) {
    const before = local[key];
    const after = wanted[key];
    if (deepEqual(before, after)) continue;
    if (!isPrimitive(before) || !isPrimitive(after)) return null;
    patch[key] = after;
  }
  return patch;
}

function plan(local: DesmosState, wanted: DesmosState) {
  if (!deepEqual(withoutList(local), withoutList(wanted))) return null;
  const localList = local.expressions?.list ?? [];
  const wantedList = wanted.expressions?.list ?? [];
  const wantedById = new Map(wantedList.map((item) => [String(item.id), item]));
  const removed = localList.filter((item) => !wantedById.has(String(item.id)));
  const kept = localList.filter((item) => wantedById.has(String(item.id)));
  if (kept.some((item, i) => String(item.id) !== String(wantedList[i]?.id))) return null;

  const added = wantedList.slice(kept.length);
  if (added.some((item) => !APPENDABLE.has(String(item.type)) || item.folderId !== undefined)) return null;

  const patches: Item[] = [];
  for (const item of kept) {
    const wantedItem = wantedById.get(String(item.id)) as Item;
    if (deepEqual(item, wantedItem)) continue;
    const patch = patchFor(item, wantedItem);
    if (!patch) return null;
    patches.push(patch);
  }
  return { removed, patches, added };
}

export function applyToCalculator(calc: Calculator, wanted: DesmosState) {
  const local = calc.getState();
  if (deepEqual(local, wanted)) return "unchanged";
  const steps = plan(local, wanted);
  if (steps) {
    calc.withHistoryReplacement(() => {
      if (steps.removed.length) calc.removeExpressions(steps.removed.map((item) => ({ id: String(item.id) })));
      for (const patch of steps.patches) calc.setExpression(patch);
      for (const item of steps.added) calc.setExpression(item);
    });
    if (deepEqual(calc.getState().expressions?.list ?? [], wanted.expressions?.list ?? [])) return "patched";
  }
  const selected = calc.selectedExpressionId;
  calc.setState(wanted, { allowUndo: true });
  if (selected && wanted.expressions?.list?.some((item) => item.id === selected)) calc.setSelectedExpressionId(selected);
  return "replaced";
}
