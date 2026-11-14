import { expect, test } from "vitest";
import { windowId, type WindowKind, type WindowRef } from "../kinds";
import type { DockNode, DockPlacement } from "../placement";
import { defaultDock } from "./fit";
import { layoutDock, type DockSpace } from "./geometry";
import { splitArea, splitGroup } from "./split";

const ref = (id: string, kind: WindowKind): WindowRef => ({ id: windowId(id), kind });
const group = (id: string, tabs: string[], active = tabs[0] ?? ""): DockNode => ({ kind: "group", id, tabs: tabs.map(windowId), active: windowId(active) });
const split = (dir: "row" | "column", ratio: number, first: DockNode, second: DockNode): DockNode => ({ kind: "split", dir, ratio, first, second });

const c1 = ref("c1", "chart");
const c2 = ref("c2", "chart");
const w = ref("w", "watchlist");
const s = ref("s", "screener");
const o = ref("o", "objects");
const windows = [c1, c2, w, s, o];
const space: DockSpace = { area: { w: 1256, h: 684 }, gap: 6, windows };
const dock = defaultDock([c1, w, s, o]);
const sideRest = group("g2", ["w", "o"]);

test.each([
  ["left", split("row", 0.5, group("g3", ["s"]), group("g1", ["c1"]))],
  ["right", split("row", 0.5, group("g1", ["c1"]), group("g3", ["s"]))],
  ["top", split("column", 0.5, group("g3", ["s"]), group("g1", ["c1"]))],
  ["bottom", split("column", 0.5, group("g1", ["c1"]), group("g3", ["s"]))],
] as const)("묶음의 %s 가장자리에 놓으면 반으로 나눠 새 묶음을 둔다", (edge, expected) => {
  expect(splitGroup(dock, windowId("s"), "g1", edge, space)).toEqual({ ok: true, dock: { root: split("row", 0.72, expected, sideRest), floats: [] } });
});

test("반으로 나누면 최소 크기를 못 지킬 때 비율을 옮겨 양쪽을 지킨다", () => {
  const short: DockSpace = { ...space, area: { w: 1256, h: 500 } };
  const result = splitGroup(dock, windowId("s"), "g1", "bottom", short);
  if (!result.ok) throw new Error(result.reason);
  const boxes = layoutDock(result.dock.root, short.area, short.gap).groups;
  expect(boxes.map((box) => [box.group.id, box.rect.h])).toEqual([["g1", 500 - 6 - 274], ["g3", 240 + 34], ["g2", 500]]);
});

test("어떤 비율로도 최소 크기를 못 지키면 나누지 않고 자리가 작다고 알린다", () => {
  const charts = defaultDock([c1, c2, w, s, o]);
  expect(splitGroup(charts, windowId("s"), "g3", "left", space)).toEqual({ ok: false, reason: "too-small" });
  expect(splitGroup(charts, windowId("s"), "g1", "bottom", space)).toEqual({ ok: false, reason: "too-small" });
  expect(splitGroup(dock, windowId("s"), "g1", "right", { ...space, area: { w: 1256, h: 260 } })).toEqual({ ok: false, reason: "too-small" });
});

test("하나뿐인 탭을 자기 묶음에 나눠 놓으면 아무것도 바꾸지 않는다", () => {
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    const result = splitGroup(dock, windowId("c1"), "g1", edge, space);
    expect(result.ok && result.dock).toBe(dock);
  }
  const lone: DockPlacement = { root: group("g1", ["c1"]), floats: [] };
  const result = splitArea(lone, windowId("c1"), "right", space);
  expect(result.ok && result.dock).toBe(lone);
});

test("하나뿐인 탭을 다른 묶음에 나눠 놓으면 빈 묶음은 사라진다", () => {
  const charts = defaultDock([c1, c2, w]);
  expect(splitGroup(charts, windowId("c2"), "g3", "bottom", space)).toEqual({
    ok: true,
    dock: { root: split("row", 0.72, group("g1", ["c1"]), split("column", 0.5, group("g3", ["w"]), group("g2", ["c2"]))), floats: [] },
  });
});

test("작업 영역의 가장자리에 놓으면 트리 전체 옆에 새 묶음을 둔다", () => {
  const rest = split("row", 0.72, group("g1", ["c1"]), sideRest);
  expect(splitArea(dock, windowId("s"), "bottom", space)).toEqual({ ok: true, dock: { root: split("column", 0.5, rest, group("g3", ["s"])), floats: [] } });
  expect(splitArea(dock, windowId("s"), "left", space)).toEqual({ ok: true, dock: { root: split("row", 0.5, group("g3", ["s"]), rest), floats: [] } });
  expect(splitArea(dock, windowId("s"), "right", { ...space, area: { w: 600, h: 684 } })).toEqual({ ok: false, reason: "too-small" });
});

test("떠 있는 창을 가장자리에 놓으면 떠 있는 항목이 사라진다", () => {
  const floating: DockPlacement = { root: group("g1", ["c1"]), floats: [{ window: windowId("w"), rect: { x: 0.6, y: 0.1, w: 0.3, h: 0.4 } }] };
  expect(splitGroup(floating, windowId("w"), "g1", "right", space)).toEqual({ ok: true, dock: { root: split("row", 0.5, group("g1", ["c1"]), group("g2", ["w"])), floats: [] } });
});
