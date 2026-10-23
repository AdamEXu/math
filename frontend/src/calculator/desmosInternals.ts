import type { Calculator } from "./desmos";
import type { DesmosItem, Json } from "./ydesmos";

/*
Desmos's public API cannot move items, set folder membership, insert mid-list, create images or edit colorLatex,
description and clickableInfo. These helpers reach those through the calculator's internal controller, using the
same actions its own UI dispatches (insert-item-at-index, confirm-keyboard-reorder, set-item-colorlatex, ...).
Nothing here is a public contract: every helper feature-detects what it touches and checks the item model after
dispatching, returning false on any surprise so the caller can fall back to setState.
*/

type Action = { type: string } & Record<string, Json | undefined>;
type Model = { id: string; type: string; index: number; folderId?: string | null };
type ListModel = { __itemModelArray: Model[]; keyboardReorderState?: unknown; dragState?: unknown };
type Controller = {
  dispatch(action: Action): void;
  getItemModel(id: string): Model | undefined;
  listModel: ListModel;
  __nextItemId?: number;
  setFocusLocation(location: unknown): void;
  getAriaManager(): unknown;
  scrollSelectedItemIntoView(): void;
  scrollItemIntoView(item: unknown): void;
};
type Item = DesmosItem;

const IMAGE_ATTRIBUTES = new Set(["center", "width", "height", "angle", "opacity"]);
const QUIET = ["setFocusLocation", "getAriaManager", "scrollSelectedItemIntoView", "scrollItemIntoView"] as const;

const isObject = (value: unknown): value is Record<string, Json | undefined> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function controllerOf(calc: Calculator): Controller | null {
  const ctl = (calc as { controller?: Partial<Controller> }).controller;
  if (!ctl || typeof ctl.dispatch !== "function" || typeof ctl.getItemModel !== "function") return null;
  if (!Array.isArray(ctl.listModel?.__itemModelArray)) return null;
  if (QUIET.some((name) => typeof ctl[name] !== "function")) return null;
  return ctl as Controller;
}

export class DesmosInternals {
  private constructor(private readonly ctl: Controller) {}

  static of(calc: Calculator) {
    const ctl = controllerOf(calc);
    return ctl ? new DesmosInternals(ctl) : null;
  }

  private get busy() {
    return !!this.ctl.listModel.dragState || !!this.ctl.listModel.keyboardReorderState;
  }

  dispatch(action: Action) {
    return this.quietly(() => this.ctl.dispatch(action));
  }

  // Remote edits must not move local focus, scroll the list or speak reorder narration, so the controller's
  // hooks for those are shadowed on the instance for the duration of the dispatch.
  private quietly(run: () => void) {
    const ctl = this.ctl as unknown as Record<string, unknown>;
    const shadowed = QUIET.filter((name) => !Object.hasOwn(ctl, name));
    for (const name of shadowed) ctl[name] = () => undefined;
    try {
      run();
      return true;
    } catch {
      return false;
    } finally {
      for (const name of shadowed) delete ctl[name];
    }
  }

  private model(id: string) {
    const model = this.ctl.getItemModel(id);
    return model && model.id === id ? model : undefined;
  }

  private has(id: string) {
    return !!this.model(id);
  }

  indexOf(id: string) {
    return this.model(id)?.index ?? -1;
  }

  typeOf(id: string) {
    return this.model(id)?.type;
  }

  place(id: string, index: number, folderId: string) {
    const model = this.model(id);
    if (!model) return false;
    const inFolder = (m: Model) => m.type === "folder" || (m.folderId ?? "") === folderId;
    if (model.index === index && inFolder(model)) return true;
    if (this.busy) return false;
    const list = this.ctl.listModel;
    list.keyboardReorderState = {
      itemId: id,
      numberOfItems: 1,
      slots: [{ index: model.index < index ? index + 1 : index, folderId }],
      currentSlotIndex: 0,
    };
    const ok = this.dispatch({ type: "confirm-keyboard-reorder" });
    list.keyboardReorderState = undefined;
    const after = this.model(id);
    return ok && !!after && after.index === index && inFolder(after);
  }

  insert(item: Item, index: number) {
    const id = String(item.id);
    if (this.has(id)) return false;
    const folderId = typeof item.folderId === "string" ? item.folderId : undefined;
    const ok = this.dispatch({ type: "insert-item-at-index", state: item, index, focus: false, folderId });
    const after = this.model(id);
    if (!ok || !after || after.index !== index || (after.folderId ?? "") !== (folderId ?? "")) return false;
    this.reserveIds(item);
    return true;
  }

  replace(item: Item) {
    const id = String(item.id);
    const model = this.model(id);
    if (!model || model.type === "folder" || item.type === "folder") return false;
    const { index, folderId } = model;
    const ok = this.dispatch({ type: "replace-item-at-index", state: item, index, focus: false });
    const after = this.model(id);
    if (!ok || !after || after.index !== index || after.folderId !== folderId) return false;
    this.reserveIds(item);
    return true;
  }

  // insert-item-at-index skips the id bookkeeping that setExpression does, so a numeric remote id would otherwise
  // be handed out again to the next local item.
  private reserveIds(item: Item) {
    const ids = [item.id, ...(Array.isArray(item.columns) ? item.columns.map((c) => (isObject(c) ? c.id : null)) : [])];
    for (const id of ids) {
      if (typeof id !== "string" || !/^[0-9]+$/.test(id)) continue;
      const next = this.ctl.__nextItemId;
      if (typeof next === "number" && Number(id) >= next) this.ctl.__nextItemId = Number(id) + 1;
    }
  }

  propActions(id: string, type: string, local: Item, wanted: Item): Action[] | null {
    const actions: Action[] = [];
    for (const key of new Set([...Object.keys(local), ...Object.keys(wanted)])) {
      const before = local[key];
      const after = wanted[key];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const action = this.propAction(id, type, key, before, after);
      if (action === null) return null;
      actions.push(...action);
    }
    return actions;
  }

  private propAction(id: string, type: string, key: string, before: unknown, after: unknown): Action[] | null {
    const text = typeof after === "string" ? after : "";
    if (key === "colorLatex" && type === "expression") return [{ type: "set-item-colorlatex", id, colorLatex: text }];
    if (key === "description" && (type === "expression" || type === "image"))
      return [{ type: "set-item-description", id, description: text }];
    if (key === "collapsed" && type === "folder")
      return [{ type: "set-folder-collapsed", id, isCollapsed: after === true }];
    if (key === "secret") return [{ type: "set-item-secret", id, isSecret: after === true }];
    if (key === "clickableInfo" && (type === "expression" || type === "image")) {
      const was = isObject(before) ? before : {};
      const now = isObject(after) ? after : {};
      const actions: Action[] = [];
      for (const prop of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (JSON.stringify(was[prop]) === JSON.stringify(now[prop])) continue;
        if (prop === "latex") actions.push({ type: "set-clickableinfo-rule-latex", id, latex: now.latex ?? "" });
        else if (prop === "enabled")
          actions.push({ type: "set-clickableinfo-prop", id, prop, value: now.enabled === true });
        else if (type === "image" && (prop === "hoveredImage" || prop === "depressedImage"))
          actions.push({
            type: prop === "hoveredImage" ? "set-hovered-image" : "set-depressed-image",
            id,
            url: now[prop] ?? "",
          });
        else return null;
      }
      return actions;
    }
    if (type !== "image") return null;
    if (IMAGE_ATTRIBUTES.has(key)) return [{ type: "set-image-mq-attribute", id, attribute: key, latex: text }];
    if (key === "name") return [{ type: "set-image-name", id, name: text }];
    if (key === "draggable") return [{ type: "set-image-draggable", id, draggable: after === true }];
    if (key === "foreground") return [{ type: "set-image-in-foreground", id, foreground: after === true }];
    return null;
  }
}

export function tickerActions(local: Json | undefined, wanted: Json | undefined): Action[] {
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
