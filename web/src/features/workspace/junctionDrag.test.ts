import { expect, test } from "vitest";
import { layoutDock, type DockSpace } from "../../layout/dock/geometry";
import { findJunctions } from "../../layout/dock/junction";
import type { DockNode, DockPlacement } from "../../layout/placement";
import { windowId, type WindowRef } from "../../layout/kinds";
import { junctionStart, moveJunction } from "./junctionDrag";

const ref = (id: string, kind: WindowRef["kind"]): WindowRef => ({ id: windowId(id), kind, rateHidden: false });
const group = (id: string, tab: string): DockNode => ({ kind: "group", id, tabs: [windowId(tab)], active: windowId(tab) });
const windows = [ref("c1", "chart"), ref("w", "watchlist"), ref("s", "screener")];
const space: DockSpace = { area: { w: 1256, h: 684 }, gap: 6, windows };
const dock: DockPlacement = { floats: [], root: { kind: "split", dir: "row", ratio: 0.72, first: { kind: "split", dir: "column", ratio: 0.5, first: group("g1", "c1"), second: group("g2", "s") }, second: group("g3", "w") } };
const [junction] = findJunctions(layoutDock(dock.root, space.area, space.gap));
const rects = (placement: DockPlacement) => layoutDock(placement.root, space.area, space.gap).groups.map(({ rect }) => rect);

test("교차점을 왼쪽 위로 끌면 가로·세로 경계가 함께 움직인다", () => {
  if (!junction) throw new Error("교차점이 없다");
  const start = junctionStart(dock, junction, space);
  if (!start) throw new Error("시작 값이 없다");
  const before = rects(dock);
  const moved = moveJunction(dock, junction, start, { x: -100, y: -60 }, true, space);
  const after = rects(moved?.dock ?? dock);
  expect(after[0]?.w).toBe((before[0]?.w ?? 0) - 100);
  expect(after[0]?.h).toBe((before[0]?.h ?? 0) - 60);
  expect(after[1]?.h).toBe((before[1]?.h ?? 0) + 60);
  expect(after[2]?.w).toBe((before[2]?.w ?? 0) + 100);
  expect(moved?.clamped).toEqual({ row: null, column: null });
});

test("한 방향이 최소를 넘어도 다른 방향은 움직이고 넘은 방향만 알린다", () => {
  if (!junction) throw new Error("교차점이 없다");
  const start = junctionStart(dock, junction, space);
  if (!start) throw new Error("시작 값이 없다");
  const before = rects(dock);
  const moved = moveJunction(dock, junction, start, { x: -5000, y: -40 }, true, space);
  const after = rects(moved?.dock ?? dock);
  expect(moved?.clamped).toEqual({ row: "first", column: null });
  expect(after[0]?.h).toBe((before[0]?.h ?? 0) - 40);
});
