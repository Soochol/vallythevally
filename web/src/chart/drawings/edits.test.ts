import { describe, expect, test } from "vitest";
import { windowId } from "../../layout/kinds";
import * as clipboard from "./clipboard";
import { DrawingEdits, REMOVED, type DrawingStore, type EditTarget } from "./edits";
import { toolOf } from "./tools";
import type { DrawingBody, DrawingOp, DrawingScope } from "./types";

const CELL = windowId("cell-0");
const SCOPE: DrawingScope = { kind: "cell", layoutId: "L1", windowId: CELL };
const body = (id: string, z: number, extra: Partial<DrawingBody> = {}): DrawingBody => ({
  id, symbol: "005930", tool: "trendline", points: [{ t: 600, price: 100 }, { t: 1200, price: 110 }], text: null, style: { v: 1 },
  locked: false, hidden: false, periods: null, z, group: "g", scope: { kind: "symbol" }, revision: 4, ...extra,
});

function setup(drawings: DrawingBody[], target: EditTarget | null = { symbol: "005930", scope: SCOPE }) {
  const commits: { ops: readonly DrawingOp[]; undo?: string }[] = [];
  const store: DrawingStore = {
    drawings: (symbol) => drawings.filter((d) => d.symbol === symbol).sort((a, b) => a.z - b.z),
    commit: (_cell, ops) => { commits.push({ ops }); return ops.length > 0; },
    commitWithUndo: (_cell, ops, message) => { commits.push({ ops, undo: message }); },
  };
  let n = 0;
  return { edits: new DrawingEdits(store, CELL, () => target, () => `new-${++n}`), commits };
}

const shiftBars = (t: number, bars: number) => t + bars * 60;
const after = (op: DrawingOp | undefined) => (op && op.kind !== "delete" ? op.after : undefined);

describe("new drawings take the top z and the target scope", () => {
  test("placing stacks above every drawing of the symbol", () => {
    const { edits, commits } = setup([body("a", 3), body("b", 7)]);
    const placed = edits.place(toolOf("hline")!, [{ t: 60, price: 50 }], { v: 2 });
    expect(placed).toMatchObject({ id: "new-1", tool: "hline", z: 8, scope: SCOPE, locked: false, group: null, revision: 0, style: { v: 2 } });
    expect(commits).toEqual([{ ops: [{ kind: "create", after: placed }] }]);
  });

  test("clones keep their order above the top, unlocked and ungrouped", () => {
    const { edits, commits } = setup([body("a", 3, { locked: true }), body("b", 7)]);
    const clones = edits.clone([body("a", 3, { locked: true }), body("b", 7)]);
    expect(clones.map((d) => [d.id, d.z, d.locked, d.group, d.scope, d.revision])).toEqual([["new-1", 8, false, null, SCOPE, 0], ["new-2", 9, false, null, SCOPE, 0]]);
    expect(commits[0]!.ops.map((op) => op.kind)).toEqual(["create", "create"]);
  });

  test("paste stacks above the top and shifts the bars on the same symbol", () => {
    const { edits } = setup([body("a", 3), body("b", 7)]);
    const result = edits.paste(clipboard.copy([body("a", 3)], "005930")!, shiftBars)!;
    expect(result.bodies.map((d) => [d.z, d.scope, d.points[0]!.t])).toEqual([[8, SCOPE, 900]]);
  });

  test("without a symbol on the chart nothing is committed", () => {
    const { edits, commits } = setup([body("a", 3)], null);
    expect(edits.place(toolOf("hline")!, [{ t: 60, price: 50 }], {})).toBeNull();
    expect(edits.clone([body("a", 3)])).toEqual([]);
    expect(edits.paste(clipboard.copy([body("a", 3)], "005930")!, shiftBars)).toBeNull();
    edits.reorder("a", "front");
    expect(commits).toEqual([]);
  });
});

describe("reorder moves one drawing between its neighbours", () => {
  const three = () => [body("a", 1), body("b", 2), body("c", 3)];

  test.each([
    ["front", "a", 4],
    ["back", "c", 0],
    ["forward", "a", 2.5],
    ["backward", "c", 1.5],
  ] as const)("%s", (direction, id, z) => {
    const { edits, commits } = setup(three());
    edits.reorder(id, direction);
    expect(commits[0]!.ops.map((op) => [after(op)?.id, after(op)?.z])).toEqual([[id, z]]);
  });

  test("dropping above a target lands just over it", () => {
    const { edits, commits } = setup(three());
    edits.reorder("a", "front", "b", "above");
    expect(after(commits[0]!.ops[0])?.z).toBe(2.5);
  });

  test("neighbours too close renumber the whole stack", () => {
    const { edits, commits } = setup([body("a", 1), body("b", 2), body("c", 2 + 1e-10)]);
    edits.reorder("a", "front", "b", "above");
    expect(commits[0]!.ops.map((op) => [after(op)?.id, after(op)?.z])).toEqual([["b", 1], ["a", 2], ["c", 3]]);
  });
});

describe("selected drawings", () => {
  test("nudging skips locked drawings and everything while all are locked", () => {
    const { edits, commits } = setup([body("a", 1), body("b", 2, { locked: true })]);
    edits.nudge(["a", "b"], "ArrowRight", { shiftBars, price: { toY: (p) => p, toPrice: (y) => y } }, false);
    expect(commits[0]!.ops.map((op) => [after(op)?.id, after(op)?.points.map((p) => p.t)])).toEqual([["a", [660, 1260]]]);
    edits.nudge(["a"], "ArrowRight", { shiftBars, price: { toY: (p) => p, toPrice: (y) => y } }, true);
    expect(commits[1]!.ops).toEqual([]);
  });

  test("removing keeps locked drawings unless forced, with one undoable commit", () => {
    const { edits, commits } = setup([body("a", 1), body("b", 2, { locked: true })]);
    edits.remove(["a", "b"], { force: false, lockAll: false });
    edits.remove(["a", "b"], { force: true, lockAll: true });
    edits.remove(["a", "b"], { force: false, lockAll: true });
    expect(commits.map((c) => [c.undo, c.ops.map((op) => op.kind === "delete" && op.before.id)])).toEqual([[REMOVED, ["a"]], [REMOVED, ["a", "b"]], [REMOVED, []]]);
  });

  test("moving commits only previews of drawings that existed", () => {
    const { edits, commits } = setup([body("a", 1)]);
    edits.move([body("a", 1, { text: "moved" }), body("ghost", 2)], [body("a", 1)]);
    expect(commits[0]!.ops.map((op) => after(op)?.id)).toEqual(["a"]);
  });

  test("updates touch only the selected drawings of the symbol", () => {
    const { edits } = setup([body("a", 1), body("b", 2), body("x", 3, { symbol: "000660" })]);
    expect(edits.update(["a", "x"], (d) => ({ ...d, locked: true })).map((op) => op.after.id)).toEqual(["a"]);
  });
});
