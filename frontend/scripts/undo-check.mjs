import { registerHooks } from "node:module";
import assert from "node:assert/strict";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) specifier += ".ts";
    return next(specifier, context);
  },
});

const { Y, LOCAL, REMOTE, readState, writeState } = await import("../src/calculator/ydesmos.ts");
const { UndoHistory, stepOf, affectedId } = await import("../src/calculator/undo.ts");

const expr = (id, latex, extra = {}) => ({ type: "expression", id, latex, color: "#c74440", ...extra });
const base = (list) => ({
  version: 11,
  graph: { viewport: { xmin: -10, xmax: 10, ymin: -10, ymax: 10 } },
  expressions: { list },
});

function pair(list) {
  const a = new Y.Doc();
  const b = new Y.Doc();
  writeState(a, base(list));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), REMOTE);
  a.on("update", (u, origin) => origin !== REMOTE && Y.applyUpdate(b, u, REMOTE));
  b.on("update", (u, origin) => origin !== REMOTE && Y.applyUpdate(a, u, REMOTE));
  return { a, b, ha: new UndoHistory(a), hb: new UndoHistory(b) };
}

function edit(doc, history, change) {
  const committed = readState(doc);
  const next = structuredClone(committed);
  change(next.expressions.list, next);
  history.before(stepOf(committed, next));
  doc.transact(() => writeState(doc, next, { keepViewport: true }), LOCAL);
}

const latexOf = (doc) => readState(doc).expressions.list.map((item) => `${item.id}:${item.latex ?? item.title ?? ""}`);
const tests = [];
const test = (name, run) => tests.push([name, run]);

test("each user's undo reverts only their own interleaved edits", () => {
  const { a, b, ha, hb } = pair([expr("1", "x"), expr("2", "y")]);
  edit(a, ha, (l) => (l[0].latex = "x+1"));
  ha.cut();
  edit(b, hb, (l) => (l[1].latex = "y+2"));
  edit(a, ha, (l) => (l[1].color = "#000000"));
  assert.ok(ha.pop("undo"));
  assert.deepEqual(latexOf(b), ["1:x+1", "2:y+2"]);
  assert.equal(readState(b).expressions.list[1].color, "#c74440");
  assert.ok(ha.pop("undo"));
  assert.deepEqual(latexOf(b), ["1:x", "2:y+2"]);
  assert.equal(ha.pop("undo"), false);
  assert.ok(hb.pop("undo"));
  assert.deepEqual(latexOf(a), ["1:x", "2:y"]);
});

test("undo after someone else edited the same expression keeps their text", () => {
  const { a, b, ha, hb } = pair([expr("1", "x")]);
  edit(a, ha, (l) => (l[0].latex = "x+1"));
  edit(b, hb, (l) => (l[0].latex = "x+1+2"));
  ha.pop("undo");
  assert.deepEqual(latexOf(b), ["1:x+2"]);
  ha.pop("redo");
  assert.deepEqual(latexOf(b), ["1:x+1+2"]);
});

test("undo of a map value someone later overwrote leaves theirs", () => {
  const { a, b, ha, hb } = pair([expr("1", "x")]);
  edit(a, ha, (l) => (l[0].color = "#111111"));
  edit(b, hb, (l) => (l[0].color = "#222222"));
  ha.pop("undo");
  assert.equal(readState(b).expressions.list[0].color, "#222222");
});

test("undoing a deletion restores the item at its position", () => {
  const { a, b, ha, hb } = pair([expr("1", "x"), expr("2", "y"), expr("3", "z")]);
  edit(a, ha, (l) => l.splice(1, 1));
  edit(b, hb, (l) => l.push(expr("4", "w")));
  ha.pop("undo");
  assert.deepEqual(latexOf(b), ["1:x", "2:y", "3:z", "4:w"]);
  ha.pop("redo");
  assert.deepEqual(latexOf(b), ["1:x", "3:z", "4:w"]);
});

test("undoing an add that someone else then edited keeps the expression", () => {
  const { a, b, ha, hb } = pair([expr("1", "x")]);
  edit(a, ha, (l) => l.push(expr("2", "y")));
  edit(b, hb, (l) => (l[1].latex = "y+1"));
  ha.pop("undo");
  assert.deepEqual(latexOf(b), ["1:x", "2:y+1"]);
});

test("undoing the creation of a field someone else typed into keeps their text", () => {
  const { a, b, ha, hb } = pair([expr("1", "x"), { type: "expression", id: "2", color: "#c74440" }]);
  edit(a, ha, (l) => (l[1].latex = "="));
  edit(b, hb, (l) => (l[1].latex = "=5"));
  ha.pop("undo");
  assert.deepEqual(latexOf(b), ["1:x", "2:5"]);
});

test("undoing an untouched add removes it", () => {
  const { a, b, ha } = pair([expr("1", "x")]);
  edit(a, ha, (l) => l.push(expr("2", "y")));
  edit(a, ha, (l) => (l[1].latex = "y+3"));
  ha.pop("undo");
  assert.deepEqual(latexOf(b), ["1:x"]);
});

test("reorder and folder moves undo as single steps", () => {
  const { a, b, ha } = pair([{ type: "folder", id: "f", title: "F" }, expr("1", "x"), expr("2", "y")]);
  edit(a, ha, (l) => l.reverse());
  edit(a, ha, (l) => (l.find((i) => i.id === "1").folderId = "f"));
  ha.pop("undo");
  assert.equal(readState(b).expressions.list.find((i) => i.id === "1").folderId, undefined);
  ha.pop("undo");
  assert.deepEqual(latexOf(b), ["f:F", "1:x", "2:y"]);
});

test("remote updates never land on the local stack", () => {
  const { a, ha, hb, b } = pair([expr("1", "x")]);
  edit(b, hb, (l) => (l[0].latex = "x+9"));
  assert.equal(ha.canUndo, false);
  const c = new Y.Doc();
  Y.applyUpdate(c, Y.encodeStateAsUpdate(a), REMOTE);
  assert.equal(ha.canUndo, false);
});

test("typing in one expression merges, a structural step or another expression does not", () => {
  const { a, ha } = pair([expr("1", "x"), expr("2", "y")]);
  edit(a, ha, (l) => (l[0].latex = "x+"));
  edit(a, ha, (l) => (l[0].latex = "x+1"));
  edit(a, ha, (l) => (l[1].latex = "y+"));
  edit(a, ha, (l) => (l[1].color = "#000000"));
  edit(a, ha, (l) => (l[1].latex = "y+2"));
  assert.equal(ha.manager.undoStack.length, 4);
  ha.pop("undo");
  ha.pop("undo");
  ha.pop("undo");
  assert.deepEqual(latexOf(a), ["1:x+1", "2:y"]);
  ha.pop("undo");
  assert.deepEqual(latexOf(a), ["1:x", "2:y"]);
});

test("adding then typing into a new expression is one step", () => {
  const { a, ha } = pair([expr("1", "x")]);
  edit(a, ha, (l) => l.push(expr("2", "y")));
  edit(a, ha, (l) => (l[1].latex = "y=2"));
  assert.equal(ha.manager.undoStack.length, 1);
});

test("step classification", () => {
  const s = base([expr("1", "x", { slider: { min: "0" } }), expr("2", "y")]);
  const change = (fn) => {
    const next = structuredClone(s);
    fn(next);
    return stepOf(s, next);
  };
  assert.equal(
    change(() => {}),
    null,
  );
  assert.equal(
    change((n) => (n.graph.viewport = { xmin: 0 })),
    null,
  );
  assert.deepEqual(
    change((n) => (n.expressions.list[0].slider.min = "-1")),
    { kind: "type", id: "1" },
  );
  assert.deepEqual(
    change((n) => (n.expressions.list[0].color = "#000")),
    { kind: "other" },
  );
  assert.deepEqual(
    change((n) => (n.graph.showGrid = false)),
    { kind: "other" },
  );
  assert.deepEqual(
    change((n) => n.expressions.list.push(expr("3", ""))),
    { kind: "add", id: "3" },
  );
  assert.deepEqual(
    change((n) => n.expressions.list.pop()),
    { kind: "other" },
  );
  assert.equal(
    affectedId(
      s,
      (() => {
        const n = structuredClone(s);
        n.expressions.list[1].latex = "q";
        return n;
      })(),
    ),
    "2",
  );
});

let failed = 0;
for (const [name, run] of tests) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n${error.stack}`);
  }
}
process.exit(failed ? 1 : 0);
