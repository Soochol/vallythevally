import { expect, test } from "vitest";
import { rectsForArea } from "./canvas/arrange";
import { countOverlaps, toPx, workArea } from "./canvas/geometry";
import { floatRects } from "./dock/floats";
import { defaultDock, type WindowList } from "./dock/fit";
import { layoutDock } from "./dock/geometry";
import { listGroups } from "./dock/tree";
import { windowId } from "./kinds";
import { canvasFromDock, dockFromCanvas, placementForMode } from "./modes";
import type { DockPlacement, Placement } from "./placement";

const a = windowId("a"), b = windowId("b"), c = windowId("c"), d = windowId("d");
const windows: WindowList = [{ id: a, kind: "chart" }, { id: b, kind: "chart" }, { id: c, kind: "watchlist" }, { id: d, kind: "trades" }];
const room = { dock: { area: { w: 1400, h: 760 }, gap: 6 }, canvas: workArea(1400, 712)! };

test("첫 캔버스는 실제 도킹 픽셀을 보존하고 같은 묶음만 24px 비켜 쌓아 고른 탭을 앞으로 놓는다", () => {
  const dock: DockPlacement = { root: { kind: "split", dir: "row", ratio: .6, first: { kind: "group", id: "left", tabs: [a, b], active: a }, second: { kind: "group", id: "right", tabs: [c, d], active: c } }, floats: [] };
  const canvas = canvasFromDock(dock, windows, room);
  const groups = layoutDock(dock.root, room.dock.area, room.dock.gap).groups;
  expect(toPx(canvas.rects[a]!, room.canvas)).toEqual(groups[0]!.rect);
  expect(toPx(canvas.rects[c]!, room.canvas)).toEqual(groups[1]!.rect);
  const behind = toPx(canvas.rects[b]!, room.canvas);
  expect(behind.x).toBe(groups[0]!.rect.x + 24);
  expect(behind.y).toBe(24);
  expect(behind.w).toBe(groups[0]!.rect.w - 24);
  expect(canvas.order).toEqual([b, a, d, c]);
  for (const left of [a, b]) for (const right of [c, d]) expect(countOverlaps([toPx(canvas.rects[left]!, room.canvas), toPx(canvas.rects[right]!, room.canvas)])).toBe(0);
});

test("최소 크기의 이웃 탭 묶음은 비켜 쌓기를 줄여 다른 묶음에 침범하지 않는다", () => {
  const tiny = { dock: { area: { w: 566, h: 194 }, gap: 6 }, canvas: workArea(566, 146)! };
  const allCharts: WindowList = [{ id: a, kind: "chart" }, { id: b, kind: "chart" }, { id: c, kind: "chart" }, { id: d, kind: "chart" }];
  const dock: DockPlacement = { root: { kind: "split", dir: "row", ratio: .5, first: { kind: "group", id: "l", tabs: [a, b], active: a }, second: { kind: "group", id: "r", tabs: [c, d], active: c } }, floats: [] };
  const result = canvasFromDock(dock, allCharts, tiny);
  expect(result.rects[a]).toEqual(result.rects[b]);
  expect(result.rects[c]).toEqual(result.rects[d]);
  const boxes = rectsForArea(result, allCharts, tiny.canvas);
  expect(boxes[a]!.w).toBe(280);
  expect(countOverlaps([boxes[a]!, boxes[c]!])).toBe(0);
});

test("캔버스에서 처음 도킹하면 앞에 있던 차트부터 왼쪽에 쌓고 나머지는 오른쪽 탭으로 묶는다", () => {
  const canvas = canvasFromDock(defaultDock(windows), windows, room);
  canvas.order = [a, c, d, b];
  const dock = dockFromCanvas(canvas, windows);
  const groups = listGroups(dock.root);
  expect(groups.map((group) => group.tabs)).toEqual([[b], [a], [c, d]]);
  expect(dock.root.kind).toBe("split");
  if (dock.root.kind === "split") expect(dock.root.dir).toBe("row");
});

test("이미 쓴 방식은 원래 배치를 보존하며 닫거나 더한 창만 맞춘다", () => {
  const dock = defaultDock(windows);
  const canvas = canvasFromDock(dock, windows, room);
  const placement: Placement = { v: 1, dock, canvas };
  expect(placementForMode(placement, windows, "canvas", room)).toBe(placement);
  expect(placementForMode(placement, windows, "dock", room)).toBe(placement);
  const added = windowId("e");
  const changed: WindowList = [windows[0], windows[2]!, windows[3]!, { id: added, kind: "chart" }];
  const next = placementForMode(placement, changed, "canvas", room);
  expect(next.dock).toBe(dock);
  expect(next.canvas!.rects[a]).toBe(canvas.rects[a]);
  expect(next.canvas!.rects[b]).toBeUndefined();
  expect(next.canvas!.order).toContain(added);
  const returned = placementForMode(next, changed, "dock", room);
  expect(returned.canvas).toBe(next.canvas);
  expect(listGroups(returned.dock!.root).flatMap((group) => group.tabs)).toEqual(expect.arrayContaining([a, c, d, added]));
  expect(listGroups(returned.dock!.root).flatMap((group) => group.tabs)).not.toContain(b);
});

test("처음 캔버스를 쓰면 보이던 기본 도킹을 기억해 왕복 뒤에도 차트 순서가 같다", () => {
  const initial: Placement = { v: 1, dock: null, canvas: null };
  const before = defaultDock(windows);
  const canvas = placementForMode(initial, windows, "canvas", room);
  expect(initial).toEqual({ v: 1, dock: null, canvas: null });
  expect(canvas.dock).toEqual(before);
  const returned = placementForMode(canvas, windows, "dock", room);
  expect(returned.dock).toBe(canvas.dock);
  expect(listGroups(returned.dock!.root).map((group) => group.tabs)).toEqual([[a], [b], [c, d]]);
});

test("캔버스만 저장된 레이아웃의 첫 도킹은 캔버스 앞 차례로 만든다", () => {
  const canvas = canvasFromDock(defaultDock(windows), windows, room);
  const converted = placementForMode({ v: 1, dock: null, canvas }, windows, "dock", room);
  expect(listGroups(converted.dock!.root).map((group) => group.tabs)).toEqual([[b], [a], [c, d]]);
  expect(converted.canvas).toBe(canvas);
});

test("떠 있는 창도 원래 도킹 작업 영역의 픽셀 크기와 자리를 보존한다", () => {
  const dock = defaultDock([windows[0], windows[2]!, windows[3]!]);
  dock.floats = [{ window: b, rect: { x: .2, y: .15, w: .4, h: .5 } }];
  const result = canvasFromDock(dock, windows, room);
  expect(toPx(result.rects[b]!, room.canvas)).toEqual({ x: 280, y: 114, w: 560, h: 380 });
  expect(result.order.at(-1)).toBe(b);
  expect(result.order.slice(0, -1)).toEqual(expect.arrayContaining([a, c, d]));
});


test("최소 크기로 커져 보이는 떠 있는 창도 첫 캔버스에서 같은 자리를 지킨다", () => {
  const dock = defaultDock([windows[0], windows[1]!, windows[3]!]);
  dock.floats = [{ window: c, rect: { x: .8, y: .8, w: .12, h: .12 } }];
  const shown = floatRects(dock, windows, workArea(room.dock.area.w, room.dock.area.h)!)[c]!;
  const result = canvasFromDock(dock, windows, room);
  expect(rectsForArea(result, windows, room.canvas)[c]).toEqual(shown);
  expect(result.order.at(-1)).toBe(c);
});
