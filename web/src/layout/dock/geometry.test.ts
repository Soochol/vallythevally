import { expect, test } from "vitest";
import { windowId, type WindowKind, type WindowRef } from "../kinds";
import type { DockNode, DockPlacement, Rect } from "../placement";
import { dockMinSize, dropTarget, heldMinSize, layoutDock, moveDivider, tabsMinSize, type DockSpace } from "./geometry";

const ref = (id: string, kind: WindowKind): WindowRef => ({ id: windowId(id), kind });
const group = (id: string, tabs: string[]): DockNode => ({ kind: "group", id, tabs: tabs.map(windowId), active: windowId(tabs[0] ?? "") });

const windows = [ref("c1", "chart"), ref("c2", "chart"), ref("w", "watchlist"), ref("s", "screener"), ref("o", "objects")];
const space: DockSpace = { area: { w: 1256, h: 684 }, gap: 6, windows };

const tree: DockNode = {
  kind: "split",
  dir: "row",
  ratio: 0.72,
  first: { kind: "split", dir: "column", ratio: 0.5, first: group("g1", ["c1"]), second: group("g2", ["c2"]) },
  second: { kind: "split", dir: "column", ratio: 0.6, first: group("g3", ["w", "s"]), second: group("g4", ["o"]) },
};
const dock: DockPlacement = { root: tree, floats: [] };

const undersized = (root: DockNode, at: DockSpace) =>
  layoutDock(root, at.area, at.gap).groups.filter(({ group: node, rect }) => {
    const least = tabsMinSize(at.windows, node.tabs);
    return rect.w < least.w || rect.h < least.h;
  });

const area = (rect: Rect) => rect.w * rect.h;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("1256×684 영역에서 묶음과 경계가 빈틈도 겹침도 없이 영역을 채운다", () => {
  const layout = layoutDock(tree, space.area, space.gap);
  expect(layout.groups.map((box) => box.group.id)).toEqual(["g1", "g2", "g3", "g4"]);
  expect(layout.gutters).toHaveLength(3);
  expect(layout.gutters.every((gutter) => (gutter.node.dir === "row" ? gutter.rect.w : gutter.rect.h) === 6)).toBe(true);
  const rects = [...layout.groups.map((box) => box.rect), ...layout.gutters.map((gutter) => gutter.rect)];
  expect(rects.reduce((sum, rect) => sum + area(rect), 0)).toBe(1256 * 684);
  for (const rect of rects) {
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(1256);
    expect(rect.y + rect.h).toBeLessThanOrEqual(684);
  }
  rects.forEach((a, i) => rects.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
  expect(layout.groups[0]?.rect).toEqual({ x: 0, y: 0, w: 903, h: 339 });
  expect(layout.groups[3]?.rect).toEqual({ x: 909, y: 414, w: 347, h: 270 });
});

test("묶음의 최소 크기는 탭 최소 크기의 큰 값에 창 머리를 더하고, 나눔은 간격과 함께 더한다", () => {
  expect(dockMinSize(group("g3", ["w", "s"]), space)).toEqual({ w: 280, h: 240 + 34 });
  expect(dockMinSize(tree, space)).toEqual({ w: 280 + 280 + 6, h: Math.max(194 + 194 + 6, 274 + 174 + 6) });
});

test("경계를 옮기면 비율이 바뀌고, 최소 크기에 닿으면 멈췄다고 알린다", () => {
  const moved = moveDivider(dock, [], 0.6, space);
  expect(moved.clamped).toBe(false);
  expect(moved.dock.root.kind === "split" && moved.dock.root.ratio).toBe(0.6);

  const pushed = moveDivider(dock, [], 0.95, space);
  expect(pushed.clamped).toBe(true);
  expect(layoutDock(pushed.dock.root, space.area, space.gap).groups[2]?.rect.w).toBe(280);

  const pulled = moveDivider(dock, ["first"], 0.01, space);
  expect(pulled.clamped).toBe(true);
  expect(layoutDock(pulled.dock.root, space.area, space.gap).groups[0]?.rect.h).toBe(160 + 34);
  expect(dock.root).toBe(tree);
});

test("이미 최소 크기 합보다 작은 자리의 경계는 바꾸지 않는다", () => {
  const small: DockSpace = { ...space, area: { w: 500, h: 684 } };
  const result = moveDivider(dock, [], 0.5, small);
  expect(result).toEqual({ dock, clamped: true });
  expect(result.dock).toBe(dock);
});

test("포인터가 가장자리에 가까우면 그쪽, 아니면 가운데를 가리킨다", () => {
  const rect = { x: 100, y: 100, w: 400, h: 200 };
  expect(dropTarget(rect, { x: 110, y: 200 })).toEqual({ zone: "left", preview: { x: 100, y: 100, w: 200, h: 200 } });
  expect(dropTarget(rect, { x: 490, y: 200 })).toEqual({ zone: "right", preview: { x: 300, y: 100, w: 200, h: 200 } });
  expect(dropTarget(rect, { x: 300, y: 110 })).toEqual({ zone: "top", preview: { x: 100, y: 100, w: 400, h: 100 } });
  expect(dropTarget(rect, { x: 300, y: 290 })).toEqual({ zone: "bottom", preview: { x: 100, y: 200, w: 400, h: 100 } });
  expect(dropTarget(rect, { x: 300, y: 200 })).toEqual({ zone: "center", preview: rect });
});

test("바깥 경계를 끝까지 옮겨도 안쪽 묶음은 최소 크기를 지킨다", () => {
  const nested: DockPlacement = { root: { kind: "split", dir: "row", ratio: 0.5, first: group("g1", ["c1"]), second: { kind: "split", dir: "row", ratio: 0.5, first: group("g2", ["w"]), second: group("g3", ["s"]) } }, floats: [] };
  const result = moveDivider(nested, [], 0.99, space);
  expect(result.clamped).toBe(true);
  expect(undersized(result.dock.root, space)).toEqual([]);
  expect(layoutDock(result.dock.root, space.area, space.gap).groups.map((box) => box.rect.w)).toEqual([1256 - 6 - 566, 280, 280]);
});

test("영역이 간격보다 작으면 비율을 바꾸지 않는다", () => {
  const result = moveDivider(dock, [], 5, { ...space, area: { w: 3, h: 3 } });
  expect(result).toEqual({ dock, clamped: true });
});

test("소수 px 영역과 간격에서도 멈춘 쪽이 최소 크기를 지킨다", () => {
  const pair: DockPlacement = { root: { kind: "split", dir: "row", ratio: 0.5, first: group("g1", ["w"]), second: group("g2", ["s"]) }, floats: [] };
  const fractional: DockSpace = { ...space, area: { w: 520.6, h: 400.4 }, gap: 6.5 };
  for (const ratio of [0.01, 0.99]) {
    const result = moveDivider(pair, [], ratio, fractional);
    expect(result.clamped).toBe(true);
    expect(undersized(result.dock.root, fractional)).toEqual([]);
  }
});

test("비율을 둔 최소 크기는 모든 묶음이 들어가는 가장 작은 폭과 같다", () => {
  const row = (ratio: number, first: DockNode, second: DockNode): DockNode => ({ kind: "split", dir: "row", ratio, first, second });
  const trees = [
    row(0.6445, group("g1", ["c1"]), group("g2", ["w"])),
    row(0.766568848490715, row(0.5433138398220763, group("g1", ["s"]), group("g2", ["c1"])), group("g3", ["o"])),
    row(0.72, group("g1", ["c1"]), row(1 / 3, group("g2", ["w"]), row(0.5, group("g3", ["s"]), group("g4", ["o"])))),
  ];
  for (const gap of [0, 6, 7]) {
    for (const node of trees) {
      const at: DockSpace = { ...space, gap, area: { w: 0, h: 684 } };
      const fits = (w: number) => undersized(node, { ...at, area: { w, h: 684 } }).length === 0;
      const least = heldMinSize(node, at).w;
      expect({ gap, least, fits: fits(least), below: fits(least - 1) }).toEqual({ gap, least, fits: true, below: false });
    }
  }
});

test("경계는 최소 크기가 허락하는 끝까지 간다", () => {
  const nested: DockPlacement = {
    root: { kind: "split", dir: "row", ratio: 706 / 931, first: { kind: "split", dir: "row", ratio: 0.6445, first: group("g1", ["c1"]), second: group("g2", ["w"]) }, second: group("g3", ["c2"]) },
    floats: [],
  };
  const narrow: DockSpace = { ...space, area: { w: 925, h: 567 } };
  const result = moveDivider(nested, [], 0.0001, narrow);
  expect(result.clamped).toBe(true);
  expect(layoutDock(result.dock.root, narrow.area, narrow.gap).groups.map((box) => box.rect.w)).toEqual([403, 220, 290]);
});

test("무한대 비율은 끝까지 밀고, 크기를 모르는 영역에서는 비율을 바꾸지 않는다", () => {
  const pushed = moveDivider(dock, [], Infinity, space);
  expect(pushed.clamped).toBe(true);
  expect(layoutDock(pushed.dock.root, space.area, space.gap).groups[2]?.rect.w).toBe(280);
  for (const w of [NaN, Infinity]) expect(moveDivider(dock, [], 0.5, { ...space, area: { w, h: 684 } })).toEqual({ dock, clamped: true });
});
