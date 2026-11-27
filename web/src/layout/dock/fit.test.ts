import { expect, test } from "vitest";
import { WINDOW_HEAD_HEIGHT, WINDOW_KIND_LIST, WINDOW_KINDS, windowId, type WindowKind, type WindowRef } from "../kinds";
import type { DockNode, DockPlacement } from "../placement";
import { defaultDock, fitDock, type WindowList } from "./fit";
import { drawDock, layoutDock, type DockSpace } from "./geometry";
import { listGroups, selectTab } from "./tree";

const ref = (id: string, kind: WindowKind): WindowRef => ({ id: windowId(id), kind, rateHidden: false });
const group = (id: string, tabs: string[], active = tabs[0] ?? ""): DockNode => ({ kind: "group", id, tabs: tabs.map(windowId), active: windowId(active) });
const row = (ratio: number, first: DockNode, second: DockNode): DockNode => ({ kind: "split", dir: "row", ratio, first, second });
const float = (window: string) => ({ window: windowId(window), rect: { x: 0.5, y: 0.1, w: 0.3, h: 0.4 } });

const c1 = ref("c1", "chart");
const c2 = ref("c2", "chart");
const c3 = ref("c3", "chart");
const w = ref("w", "watchlist");
const s = ref("s", "screener");
const o = ref("o", "trades");

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

const kindOf = (windows: readonly WindowRef[], id: string) => windows.find((window) => window.id === id)!.kind;
const lowGroups = (dock: DockPlacement, space: DockSpace) =>
  layoutDock(drawDock(dock, space).dock.root, space.area, space.gap).groups
    .filter(({ group: node, rect }) => rect.h < WINDOW_KINDS[kindOf(space.windows, node.active)].minSize.h + WINDOW_HEAD_HEIGHT)
    .map(({ group: node, rect }) => [node.active, rect.h]);

test("빈 레이아웃에 창 열 가지를 차례로 더해도 어느 묶음도 고른 탭 종류의 최소 높이보다 낮게 그려지지 않는다", () => {
  const area = { w: 1392, h: 790 };
  let windows: WindowList = [c1];
  let dock = fitDock(null, windows);
  for (const kind of WINDOW_KIND_LIST) {
    const added = ref(`${kind}-new`, kind);
    windows = [...windows, added];
    dock = selectTab(fitDock(dock, windows), added.id);
    expect({ kind, low: lowGroups(dock, { area, gap: 6, windows }) }).toEqual({ kind, low: [] });
  }
  expect(listGroups(dock.root).flatMap((node) => node.tabs)).toHaveLength(13);
});

test("창 열두 가지를 한꺼번에 기본 배치해도 어느 묶음도 고른 탭 종류의 최소 높이보다 낮게 그려지지 않는다", () => {
  const windows: WindowList = [c1, ...WINDOW_KIND_LIST.filter((kind) => kind !== "chart").map((kind) => ref(kind, kind))];
  const area = { w: 1392, h: 790 };
  const sideTabs = ["watchlist", "screener", "indicators", "trades", "book", "program", "order", "ranking", "whale"];
  const unconstrained = defaultDock(windows);
  expect(listGroups(unconstrained.root).map((node) => node.tabs)).toEqual([["c1"], ["brokers"], ["premarket"], sideTabs]);
  const fitted = defaultDock(windows, { h: area.h, gap: 6 });
  expect(listGroups(fitted.root).map((node) => node.tabs)).toEqual([["c1"], ["brokers", "premarket"], sideTabs]);
  expect(lowGroups(fitted, { area, gap: 6, windows })).toEqual([]);
});

test("넓은 자리 종류를 세로로 쌓아 최소 높이를 못 지키면 둘째부터 한 묶음의 탭으로 둔다", () => {
  const b = ref("b", "brokers");
  const windows: WindowList = [c1, c2, b, w];
  expect(listGroups(defaultDock(windows).root).map((node) => node.tabs)).toEqual([["c1"], ["c2"], ["b"], ["w"]]);
  expect(listGroups(defaultDock(windows, { h: 790, gap: 6 }).root).map((node) => node.tabs)).toEqual([["c1"], ["c2"], ["b"], ["w"]]);
  const short = defaultDock(windows, { h: 600, gap: 6 });
  expect(listGroups(short.root).map((node) => [node.id, node.tabs, node.active])).toEqual([["g1", ["c1"], "c1"], ["g2", ["c2", "b"], "c2"], ["g3", ["w"], "w"]]);
  expect(lowGroups(short, { area: { w: 1392, h: 600 }, gap: 6, windows })).toEqual([]);
});

test("호가주문은 세로 자리의 탭으로 들어가 높이를 가득 받는다", () => {
  const order = ref("o", "order");
  const dock = selectTab(fitDock(defaultDock([c1, w, s]), [c1, w, s, order]), order.id);
  expect(dock.root).toEqual(row(0.72, group("g1", ["c1"]), group("g2", ["w", "s", "o"], "o")));
  const boxes = layoutDock(dock.root, { w: 1392, h: 790 }, 6).groups;
  expect(boxes.find((box) => box.group.active === order.id)?.rect.h).toBe(790);
});
