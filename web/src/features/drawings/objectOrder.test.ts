import { expect, test, vi } from "vitest";
import { DrawingSurface } from "../../chart/drawings/DrawingSurface";
import { objectGroups } from "../../chart/drawings/objects";
import type { DrawingBody, DrawingOp } from "../../chart/drawings/types";
import { windowId, type WindowId } from "../../layout/kinds";
import { moveObject } from "./objectOrder";

const CELL = windowId("cell-0");

const drawing: DrawingBody = { id: "low", symbol: "005930", tool: "hline", points: [{ t: 1, price: 100 }], text: null, style: {}, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "cell", layoutId: "L", windowId: CELL }, revision: 1 };

function setup() {
  let drawings: DrawingBody[] = [{ ...drawing, id: "common-bottom", z: 0, scope: { kind: "symbol" } }, drawing, { ...drawing, id: "common", z: 2, scope: { kind: "symbol" } }, { ...drawing, id: "high", z: 3 }, { ...drawing, id: "common-top", z: 4, scope: { kind: "symbol" } }];
  const commit = vi.fn((_cellId: WindowId, ops: readonly DrawingOp[]) => {
    for (const op of ops) if (op.kind === "update") drawings = drawings.map((d) => d.id === op.before.id ? op.after : d);
  });
  const surface: DrawingSurface = Object.assign(Object.create(DrawingSurface.prototype), {
    cellId: CELL, host: { view: () => ({ symbol: drawing.symbol }) }, sync: { drawings: () => [...drawings].sort((a, b) => a.z - b.z), commit },
  });
  const group = () => objectGroups(drawings, "L", CELL).find((g) => g.kind === "cell")?.drawings ?? [];
  const ids = () => group().map((d) => d.id);
  return { surface, group, ids, commit, all: () => drawings };
}

test.each(["forward", "backward"] as const)("Alt 이동 %s은 다른 묶음이 사이에 있어도 묶음 이웃 한 칸을 넘는다", (direction) => {
  const { surface, group, ids, all } = setup();
  const common = all().find((d) => d.id === "common");
  moveObject(group(), direction === "forward" ? "low" : "high", direction, surface);
  expect(ids()).toEqual(["low", "high"]);
  expect(all().find((d) => d.id === "common")).toEqual(common);
});

test.each([["high", "forward"], ["low", "backward"]] as const)("묶음 끝 %s에서 %s 이동은 저장도 순서도 바꾸지 않는다", (id, direction) => {
  const { surface, group, ids, commit, all } = setup();
  const before = all();
  moveObject(group(), id, direction, surface);
  expect(ids()).toEqual(["high", "low"]);
  expect(all()).toEqual(before);
  expect(commit).not.toHaveBeenCalled();
});

test.each(["above", "below"] as const)("끌어서 %s에 놓기도 다른 묶음이 끼어 있는 목표 행을 기준으로 움직인다", (position) => {
  const { surface, ids, all } = setup();
  const common = all().find((d) => d.id === "common");
  surface.reorder(position === "above" ? "low" : "high", "front", position === "above" ? "high" : "low", position);
  expect(ids()).toEqual(["low", "high"]);
  expect(all().find((d) => d.id === "common")).toEqual(common);
});
