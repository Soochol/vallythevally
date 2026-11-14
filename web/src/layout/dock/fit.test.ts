import { expect, test } from "vitest";
import { windowId, type WindowKind, type WindowRef } from "../kinds";
import type { DockNode, DockPlacement } from "../placement";
import { defaultDock, fitDock, type WindowList } from "./fit";
import { layoutDock } from "./geometry";

const ref = (id: string, kind: WindowKind): WindowRef => ({ id: windowId(id), kind });
const group = (id: string, tabs: string[], active = tabs[0] ?? ""): DockNode => ({ kind: "group", id, tabs: tabs.map(windowId), active: windowId(active) });
const row = (ratio: number, first: DockNode, second: DockNode): DockNode => ({ kind: "split", dir: "row", ratio, first, second });
const float = (window: string) => ({ window: windowId(window), rect: { x: 0.5, y: 0.1, w: 0.3, h: 0.4 } });

const c1 = ref("c1", "chart");
const c2 = ref("c2", "chart");
const c3 = ref("c3", "chart");
const w = ref("w", "watchlist");
const s = ref("s", "screener");
const o = ref("o", "objects");

test("기본 배치는 차트를 왼쪽에, 나머지를 오른쪽 묶음의 탭으로 72:28에 둔다", () => {
  expect(defaultDock([c1, w, s, o])).toEqual({ root: row(0.72, group("g1", ["c1"]), group("g2", ["w", "s", "o"])), floats: [] });
});

test("차트 셋은 왼쪽에 같은 높이로 쌓인다", () => {
  const dock = defaultDock([c1, c2, c3, w]);
  const boxes = layoutDock(dock.root, { w: 1256, h: 684 }, 0).groups;
  expect(boxes.map((box) => [box.group.tabs, box.rect])).toEqual([
    [["c1"], { x: 0, y: 0, w: 904, h: 228 }],
    [["c2"], { x: 0, y: 228, w: 904, h: 228 }],
    [["c3"], { x: 0, y: 456, w: 904, h: 228 }],
    [["w"], { x: 904, y: 0, w: 352, h: 684 }],
  ]);
});

test("간격이 있어도 쌓은 차트의 높이가 같다", () => {
  const boxes = layoutDock(defaultDock([c1, c2, c3, w]).root, { w: 1256, h: 684 }, 6).groups;
  expect(boxes.slice(0, 3).map((box) => box.rect.h)).toEqual([224, 224, 224]);
});

test("차트만 있으면 오른쪽 묶음이 없다", () => {
  expect(defaultDock([c1])).toEqual({ root: group("g1", ["c1"]), floats: [] });
  expect(defaultDock([c1, c2]).root).toEqual({ kind: "split", dir: "column", ratio: 0.5, first: group("g1", ["c1"]), second: group("g2", ["c2"]) });
});

test("저장된 배치가 없으면 기본 배치를 만든다", () => {
  const windows: WindowList = [c1, w, s];
  expect(fitDock(null, windows)).toEqual(defaultDock(windows));
});

test("창 목록에 없는 창의 탭과 떠 있는 창을 지운다", () => {
  const dock: DockPlacement = { root: row(0.7, group("g1", ["c1", "gone"]), group("g2", ["w"])), floats: [float("lost"), float("s")] };
  expect(fitDock(dock, [c1, w, s])).toEqual({ root: row(0.7, group("g1", ["c1"]), group("g2", ["w"])), floats: [float("s")] });
});

test("탭이 하나도 남지 않은 묶음은 없어지고 이웃이 자리를 채운다", () => {
  const dock: DockPlacement = {
    root: row(0.5, group("g1", ["c1"]), { kind: "split", dir: "column", ratio: 0.4, first: group("g2", ["gone"]), second: group("g3", ["w"]) }),
    floats: [],
  };
  expect(fitDock(dock, [c1, w]).root).toEqual(row(0.5, group("g1", ["c1"]), group("g3", ["w"])));
});

test("배치에 없는 차트는 차트가 있는 첫 묶음에, 다른 창은 차트가 아닌 창이 있는 첫 묶음에 탭으로 넣는다", () => {
  const dock: DockPlacement = { root: row(0.6, group("g1", ["w"]), row(0.5, group("g2", ["c1"]), group("g3", ["o"]))), floats: [] };
  expect(fitDock(dock, [c1, c2, w, s, o]).root).toEqual(row(0.6, group("g1", ["w", "s"]), row(0.5, group("g2", ["c1", "c2"]), group("g3", ["o"]))));
});

test("넣을 묶음이 없으면 전체의 오른쪽에 새 묶음으로 나눠 놓는다", () => {
  expect(fitDock({ root: group("g1", ["c1"]), floats: [] }, [c1, w, s]).root).toEqual(row(0.72, group("g1", ["c1"]), group("g2", ["w", "s"])));
  expect(fitDock({ root: group("g1", ["w"]), floats: [] }, [w, c1]).root).toEqual(row(0.28, group("g1", ["w"]), group("g2", ["c1"])));
});

test("탭과 떠 있는 창에 함께 있으면 탭만, 두 묶음에 있으면 처음 것만 남긴다", () => {
  const dock: DockPlacement = { root: row(0.7, group("g1", ["c1", "w"]), group("g2", ["w", "s"])), floats: [float("s"), float("c1")] };
  expect(fitDock(dock, [c1, w, s])).toEqual({ root: row(0.7, group("g1", ["c1", "w"]), group("g2", ["s"])), floats: [] });
});

test("묶음의 고른 탭이 탭에 없으면 첫 탭으로 고친다", () => {
  const dock: DockPlacement = { root: row(0.7, group("g1", ["c1"], "w"), group("g2", ["gone", "w", "s"], "gone")), floats: [] };
  expect(fitDock(dock, [c1, w, s]).root).toEqual(row(0.7, group("g1", ["c1"]), group("g2", ["w", "s"], "w")));
});

test("모든 묶음이 사라지면 떠 있지 않은 창으로 기본 배치를 만들고 떠 있는 창은 둔다", () => {
  expect(fitDock({ root: group("g9", ["gone"]), floats: [float("w")] }, [c1, w, s])).toEqual({ root: row(0.72, group("g1", ["c1"]), group("g2", ["s"])), floats: [float("w")] });
  expect(fitDock({ root: group("g9", ["gone"]), floats: [float("c1"), float("w")] }, [c1, w])).toEqual({ root: group("g1", ["c1"]), floats: [float("w")] });
});

test("맞출 것이 없으면 받은 배치를 그대로 돌려준다", () => {
  const dock: DockPlacement = { root: row(0.7, group("g1", ["c1", "c2"], "c2"), group("g2", ["w", "s"])), floats: [float("o")] };
  expect(fitDock(dock, [c1, c2, w, s, o])).toBe(dock);
});
