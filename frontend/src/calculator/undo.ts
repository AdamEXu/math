import { type DesmosItem, type DesmosState, type Json, LOCAL, VIEW_KEYS, Y, deepEqual, isTextKey } from "./ydesmos";

export const TYPING_PAUSE_MS = 500;

export type Step = { kind: "type"; id: string } | { kind: "add"; id: string } | { kind: "other" };
type Kind = "undo" | "redo";
type StackItem = { insertions: Parameters<typeof Y.isDeleted>[0] };
type Shared = Y.AbstractType<any>;

const idOf = (item: DesmosItem) => String(item.id);
const isObject = (value: unknown): value is Record<string, Json | undefined> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const plain = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

function withoutView(graph: Record<string, Json | undefined> = {}) {
  const rest = { ...graph };
  for (const key of VIEW_KEYS) delete rest[key];
  return rest;
}

function textOnly(before: Json | undefined, after: Json | undefined, key: string): boolean {
  if (typeof before === "string" && typeof after === "string") return isTextKey(key);
  if (!isObject(before) || !isObject(after)) return false;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].every((k) => deepEqual(before[k], after[k]) || textOnly(before[k], after[k], k));
}

export function stepOf(committed: DesmosState | null, next: DesmosState): Step | null {
  if (!committed) return { kind: "other" };
  const { graph: beforeGraph, expressions: beforeExpr = {}, ...beforeTop } = plain(committed);
  const { graph: afterGraph, expressions: afterExpr = {}, ...afterTop } = plain(next);
  const { list: beforeList = [], ...beforeMeta } = beforeExpr;
  const { list: afterList = [], ...afterMeta } = afterExpr;
  if (!deepEqual(beforeTop, afterTop) || !deepEqual(beforeMeta, afterMeta)) return { kind: "other" };
  if (!deepEqual(withoutView(beforeGraph), withoutView(afterGraph))) return { kind: "other" };

  const before = new Map(beforeList.map((item) => [idOf(item), item]));
  const afterIds = new Set(afterList.map(idOf));
  if (beforeList.some((item) => !afterIds.has(idOf(item)))) return { kind: "other" };
  const kept = afterList.filter((item) => before.has(idOf(item)));
  if (!deepEqual(kept.map(idOf), beforeList.map(idOf))) return { kind: "other" };
  const added = afterList.filter((item) => !before.has(idOf(item)));
  const changed = kept.filter((item) => !deepEqual(before.get(idOf(item)), item));
  if (added.length > 1 || (added.length && changed.length) || changed.length > 1) return { kind: "other" };
  if (added[0]) return { kind: "add", id: idOf(added[0]) };
  const item = changed[0];
  if (!item) return null;
  const prev = before.get(idOf(item)) as DesmosItem;
  return prev.type === item.type && textOnly(prev, item, "") ? { kind: "type", id: idOf(item) } : { kind: "other" };
}

export function affectedId(before: DesmosState | null, after: DesmosState | null) {
  const previous = new Map((before?.expressions?.list ?? []).map((item) => [idOf(item), item]));
  const hit = (after?.expressions?.list ?? []).find((item) => !deepEqual(previous.get(idOf(item)), item));
  return hit ? idOf(hit) : null;
}

function authoredElsewhere(type: Shared, own: number): boolean {
  const structs: Y.Item[] = [];
  for (let item = type._start; item; item = item.right) structs.push(item);
  for (const latest of type._map.values())
    for (let item: Y.Item | null = latest; item; item = item.left) structs.push(item);
  return structs.some(
    (item) =>
      item.id.client !== own || (item.content instanceof Y.ContentType && authoredElsewhere(item.content.type, own)),
  );
}

export class UndoHistory {
  readonly manager: Y.UndoManager;
  private readonly items: Y.Map<unknown>;
  private readonly order: Y.Array<string>;
  private typingId: string | null = null;
  private guarded: Set<Shared> | null = null;
  private readonly doc: Y.Doc;

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.items = doc.getMap("items");
    this.order = doc.getArray<string>("order");
    const scope = [
      doc.getMap("state"),
      doc.getMap("graph"),
      doc.getMap("list"),
      doc.getMap("ticker"),
      this.order,
      this.items,
    ];
    this.manager = new Y.UndoManager(scope, {
      trackedOrigins: new Set([LOCAL]),
      captureTimeout: TYPING_PAUSE_MS,
      deleteFilter: (item) => this.mayDelete(item),
    });
  }

  before(step: Step | null) {
    if (!step) return;
    if (step.kind !== "type" || step.id !== this.typingId) this.manager.stopCapturing();
    this.typingId = step.kind === "other" ? null : step.id;
  }

  cut() {
    this.manager.stopCapturing();
    this.typingId = null;
  }

  get canUndo() {
    return this.manager.canUndo();
  }

  get canRedo() {
    return this.manager.canRedo();
  }

  pop(kind: Kind) {
    const stack = kind === "undo" ? this.manager.undoStack : this.manager.redoStack;
    const top = stack.at(-1);
    if (!top) return false;
    this.typingId = null;
    this.guarded = this.guard(top);
    try {
      return (kind === "undo" ? this.manager.undo() : this.manager.redo()) !== null;
    } finally {
      this.guarded = null;
    }
  }

  // Undoing the creation of a shared type would otherwise delete everything others have since put into it. Such
  // types are kept; for a whole expression its entire subtree and order entry are kept so it stays well-formed.
  private guard(top: StackItem) {
    const guarded = new Set<Shared>();
    for (const value of this.items.values()) {
      if (!(value instanceof Y.Map) || !value._item || !Y.isDeleted(top.insertions, value._item.id)) continue;
      if (authoredElsewhere(value, this.doc.clientID)) guarded.add(value);
    }
    return guarded;
  }

  private mayDelete(item: Y.Item) {
    if (item.content instanceof Y.ContentType && authoredElsewhere(item.content.type, this.doc.clientID)) return false;
    const guarded = this.guarded;
    if (!guarded?.size) return true;
    if (item.parent === this.order) {
      const ids = item.content.getContent() as unknown[];
      return !ids.some((id) => typeof id === "string" && guarded.has(this.items.get(id) as Shared));
    }
    for (let at: Y.Item | null = item; at; at = (at.parent as Shared)._item) {
      if (at.parent !== this.items) continue;
      return !(at.content instanceof Y.ContentType && guarded.has(at.content.type));
    }
    return true;
  }

  destroy() {
    this.manager.destroy();
  }
}
