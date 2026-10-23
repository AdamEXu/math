import { type DesmosItem, type DesmosState, type Json, deepEqual } from "./ydesmos";

export type Patch = Record<string, Json>;
export type Patches = Record<string, Patch>;

const MAX_PATCH_BYTES = 16_000;

export function isPatches(value: unknown): value is Patches {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((patch) => !!patch && typeof patch === "object" && !Array.isArray(patch));
}

export function isPlaying(item: DesmosItem | undefined) {
  const slider = item?.slider;
  return !!slider && typeof slider === "object" && !Array.isArray(slider) && slider.isPlaying === true;
}

export function itemsById(state: DesmosState) {
  return new Map((state.expressions?.list ?? []).map((item) => [String(item.id), item]));
}

export function diffItems(local: DesmosState, base: DesmosState, skip: (id: string, key: string) => boolean) {
  const baseItems = itemsById(base);
  const patches: Patches = {};
  for (const item of local.expressions?.list ?? []) {
    const id = String(item.id);
    const prev = baseItems.get(id);
    if (!prev || prev.type !== item.type) continue;
    for (const [key, value] of Object.entries(item)) {
      if (value === undefined || deepEqual(value, prev[key]) || skip(id, key)) continue;
      (patches[id] ??= {})[key] = value;
    }
  }
  if (!Object.keys(patches).length || JSON.stringify(patches).length > MAX_PATCH_BYTES) return null;
  return patches;
}

export function withPatches(state: DesmosState, layers: Patches[]): DesmosState {
  if (!layers.length) return state;
  const list = (state.expressions?.list ?? []).map((item) => {
    const id = String(item.id);
    let next = item;
    for (const layer of layers) {
      const patch = layer[id];
      if (!patch) continue;
      next = { ...next, ...patch, id: item.id, type: item.type };
    }
    return next;
  });
  return { ...state, expressions: { ...state.expressions, list } };
}

export function patchApplied(state: DesmosState, patches: Patches) {
  const items = itemsById(state);
  return Object.entries(patches).every(([id, patch]) => {
    const item = items.get(id);
    return !item || Object.entries(patch).every(([key, value]) => deepEqual(item[key] ?? null, value));
  });
}

export type Tick = { latex: Json | undefined; playDirection: Json | undefined };

function sliderOf(item: DesmosItem | undefined) {
  const slider = item?.slider;
  return slider && typeof slider === "object" && !Array.isArray(slider) ? slider : null;
}

export function tickOf(item: DesmosItem | undefined): Tick {
  return { latex: item?.latex, playDirection: sliderOf(item)?.playDirection };
}

export function sameTick(a: Tick | undefined, b: Tick) {
  return !!a && deepEqual(a.latex, b.latex) && deepEqual(a.playDirection, b.playDirection);
}

export function withTick(item: DesmosItem, tick: Tick): DesmosItem {
  const slider = { ...sliderOf(item) };
  if (tick.playDirection === undefined) delete slider.playDirection;
  else slider.playDirection = tick.playDirection;
  return { ...item, latex: tick.latex, slider };
}

export function sliderSettings(item: DesmosItem) {
  const slider = sliderOf(item);
  if (!slider) return null;
  const { playDirection: _direction, ...settings } = slider;
  return JSON.stringify(settings);
}

const NUMBER = /-?\d+(?:\.\d+)?/g;

const decimals = (text: string) => text.split(".")[1]?.length ?? 0;

export function lerpLatex(from: string, to: string, t: number): string | null {
  const start = from.match(NUMBER) ?? [];
  if (!start.length || from.replace(NUMBER, "#") !== to.replace(NUMBER, "#")) return null;
  if (t >= 1) return to;
  let i = 0;
  return to.replace(NUMBER, (end) => {
    const begin = start[i++] as string;
    const value = Number(begin) + (Number(end) - Number(begin)) * t;
    return value.toFixed(Math.max(decimals(begin), decimals(end)) + 1);
  });
}
