export type CaretPosition = {
  id: string;
  field: number;
  path: number[];
  offset: number;
  selection?: [number, number];
  sig: string;
};

export type CaretBox = {
  x: number;
  top: number;
  height: number;
  selection: { left: number; right: number } | null;
};

const FIELD = ".dcg-mq-editable-field";
const ROOT_BLOCK = ".dcg-mq-root-block";
const CURSOR = "dcg-mq-cursor";
const SELECTION = "dcg-mq-selection";

function nodes(block: Element): Element[] {
  const out: Element[] = [];
  for (const child of block.children) {
    if (child.classList.contains(CURSOR)) continue;
    if (child.classList.contains(SELECTION)) out.push(...nodes(child));
    else out.push(child);
  }
  return out;
}

function signature(root: Element) {
  const text = (root.textContent ?? "").replace(/​/g, "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function logicalParent(el: Element) {
  const parent = el.parentElement;
  return parent?.classList.contains(SELECTION) ? parent.parentElement : parent;
}

function pathTo(root: Element, block: Element): number[] | null {
  const path: number[] = [];
  let el: Element = block;
  while (el !== root) {
    const parent = logicalParent(el);
    if (!parent) return null;
    const index = nodes(parent).indexOf(el);
    if (index < 0) {
      const direct = [...parent.children].indexOf(el);
      if (direct < 0) return null;
      path.unshift(-1 - direct);
    } else {
      path.unshift(index);
    }
    el = parent;
  }
  return path;
}

function follow(root: Element, path: number[]): Element | null {
  let el: Element | undefined = root;
  for (const step of path) {
    if (!el) return null;
    el = step >= 0 ? nodes(el)[step] : el.children[-1 - step];
  }
  return el ?? null;
}

export function readCaret(active: Element | null): CaretPosition | null {
  const field = active?.closest(FIELD);
  const row = field?.closest("[expr-id]");
  const id = row?.getAttribute("expr-id");
  const root = field?.querySelector(ROOT_BLOCK);
  const cursor = root?.querySelector(`.${CURSOR}`);
  const selection = root?.querySelector(`.${SELECTION}`);
  const marker = cursor ?? selection;
  if (!field || !row || !id || !root || !marker) return null;
  const block = cursor ? logicalParent(cursor) : selection?.parentElement;
  if (!block) return null;
  const path = pathTo(root, block);
  if (!path) return null;

  const all = nodes(block);
  const picked = selection && selection.parentElement === block ? nodes(selection) : [];
  const start = picked.length ? all.indexOf(picked[0] as Element) : -1;
  let offset: number;
  if (cursor) {
    const siblings = [...block.children].flatMap((child) =>
      child.classList.contains(SELECTION) ? [...child.children] : [child],
    );
    offset = siblings.slice(0, siblings.indexOf(cursor)).filter((el) => !el.classList.contains(CURSOR)).length;
  } else {
    if (start < 0) return null;
    offset = start + picked.length;
  }
  const caret: CaretPosition = {
    id,
    field: [...row.querySelectorAll(FIELD)].indexOf(field),
    path,
    offset,
    sig: signature(root),
  };
  if (start >= 0) caret.selection = [start, start + picked.length];
  return caret;
}

export function caretBox(container: HTMLElement, caret: CaretPosition): CaretBox | null {
  const row = container.querySelector(`.dcg-exppanel [expr-id="${CSS.escape(caret.id)}"]`);
  const field = row?.querySelectorAll(FIELD)[caret.field];
  const root = field?.querySelector(ROOT_BLOCK);
  if (!root || signature(root) !== caret.sig) return null;
  const block = follow(root, caret.path);
  if (!block) return null;
  const children = nodes(block);
  if (caret.offset > children.length) return null;
  const blockRect = block.getBoundingClientRect();
  const before = children[caret.offset - 1]?.getBoundingClientRect();
  const after = children[caret.offset]?.getBoundingClientRect();
  const x = after ? after.left : before ? before.right : blockRect.left + blockRect.width / 2;
  let selection: CaretBox["selection"] = null;
  if (caret.selection) {
    const [start, end] = caret.selection;
    const first = children[start]?.getBoundingClientRect();
    const last = children[end - 1]?.getBoundingClientRect();
    if (first && last) selection = { left: first.left, right: last.right };
  }
  const line = after ?? before ?? blockRect;
  if (!Number.isFinite(x) || line.height <= 0) return null;
  return { x, top: line.top, height: line.height, selection };
}

export function isCaret(value: unknown): value is CaretPosition {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.sig === "string" &&
    Number.isInteger(c.field) &&
    Number.isInteger(c.offset) &&
    Array.isArray(c.path) &&
    c.path.length <= 64 &&
    c.path.every(Number.isInteger) &&
    (c.selection === undefined ||
      (Array.isArray(c.selection) && c.selection.length === 2 && c.selection.every(Number.isInteger)))
  );
}
