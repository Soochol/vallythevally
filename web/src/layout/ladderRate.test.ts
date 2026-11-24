import { expect, test } from "vitest";
import { placeNewWindow, rectsForArea } from "./canvas/arrange";
import { minWindowSize, workArea } from "./canvas/geometry";
import { floatRects } from "./dock/floats";
import { contentMinSize, windowId, type WindowKind, type WindowRef } from "./kinds";
import { shiftForLadderRate, type DockMemory, type LadderRateChange } from "./ladderRate";
import type { LayoutMode, PlacementRoom } from "./modes";
import type { CanvasPlacement, DockPlacement, Placement, Rect } from "./placement";

const area = workArea(1440, 900)!;
const room: PlacementRoom = { dock: { area: { w: 1440, h: 948 }, gap: 6 }, canvas: area };
const dockArea = workArea(1440, 948)!;
const ref = (id: string, kind: WindowKind, rateHidden: boolean): WindowRef => ({ id: windowId(id), kind, rateHidden });
const list = (hidden: boolean): [WindowRef, ...WindowRef[]] => [ref("chart", "chart", false), ref("order", "order", hidden), ref("book", "book", hidden)];
const windows = { hidden: list(true), shown: list(false) };
const none: DockMemory = new Map();
const changeTo = (show: boolean, mode: LayoutMode = "canvas"): LadderRateChange => ({ show, windows, mode, room });
const rect = (x: number, w: number): Rect => ({ x, y: 0.1, w, h: 0.7 });
const canvasOf = (rects: Record<string, Rect>): CanvasPlacement => ({ rects, order: Object.keys(rects).map(windowId) });
const placementOf = (dock: DockPlacement | null, canvas: CanvasPlacement | null): Placement => ({ v: 1, dock, canvas });
const run = (placement: Placement, show: boolean, mode?: LayoutMode, memory = none) => shiftForLadderRate(placement, changeTo(show, mode), memory);
const drawn = (canvas: CanvasPlacement, hidden: boolean) => rectsForArea(canvas, hidden ? windows.hidden : windows.shown, area);

test("등락률을 끈 최소 폭은 호가주문 372px, 10호가 232px이고 다른 창은 그대로다", () => {
  expect([contentMinSize("order", true).w, contentMinSize("book", true).w, contentMinSize("order").w, contentMinSize("book").w]).toEqual([372, 232, 420, 280]);
  expect(contentMinSize("chart", true)).toBe(contentMinSize("chart"));
  expect(minWindowSize("order", true)).toEqual({ w: 372, h: minWindowSize("order").h });
});

test("새로 여는 창의 기본 폭은 끈 동안 호가주문 392px, 10호가 272px이다", () => {
  expect(["order", "book", "watchlist"].map((kind) => placeNewWindow(kind as WindowKind, [], area, true).w)).toEqual([392, 272, 320]);
  expect(["order", "book"].map((kind) => placeNewWindow(kind as WindowKind, [], area).w)).toEqual([440, 320]);
});

test("자유 배치는 그려진 폭에서 48px을 빼고 왼쪽·높이·다른 창은 그대로다", () => {
  const canvas = canvasOf({ chart: rect(0, 0.2), order: rect(0.5, 0.35), book: rect(0.22, 0.25) });
  const off = run(placementOf(null, canvas), false).placement.canvas!;
  expect(off.rects[windowId("chart")]).toBe(canvas.rects[windowId("chart")]);
  for (const id of ["order", "book"].map(windowId)) {
    expect(drawn(off, true)[id]!.w).toBeCloseTo(drawn(canvas, false)[id]!.w - 48, 6);
    expect(drawn(off, true)[id]!.x).toBeCloseTo(drawn(canvas, false)[id]!.x, 6);
    expect(off.rects[id]).toMatchObject({ y: 0.1, h: 0.7 });
  }
  expect(off.order).toBe(canvas.order);
});

test("최소 폭으로 늘어나 그려지던 창은 420 → 372 → 420이고 열 번 왕복해도 같다", () => {
  let canvas = canvasOf({ chart: rect(0, 0.2), order: rect(0.5, 0.1), book: rect(0.22, 0.05) });
  for (let round = 0; round < 10; round += 1) {
    canvas = run(placementOf(null, canvas), false).placement.canvas!;
    expect([drawn(canvas, true)[windowId("order")]!.w, drawn(canvas, true)[windowId("book")]!.w]).toEqual([expect.closeTo(372, 6), expect.closeTo(232, 6)]);
    canvas = run(placementOf(null, canvas), true).placement.canvas!;
    expect([drawn(canvas, false)[windowId("order")]!.w, drawn(canvas, false)[windowId("book")]!.w]).toEqual([expect.closeTo(420, 6), expect.closeTo(280, 6)]);
  }
});

const split = (ratio: number): DockPlacement => ({ root: { kind: "split", dir: "row", ratio, first: { kind: "group", id: "g1", tabs: [windowId("chart")], active: windowId("chart") }, second: { kind: "group", id: "g2", tabs: [windowId("order")], active: windowId("order") } }, floats: [{ window: windowId("book"), rect: rect(0.1, 0.3) }] });

test("도킹 나눔·떠 있는 창·자유 배치 저장값을 함께 고친다", () => {
  const canvas = canvasOf({ chart: rect(0, 0.2), order: rect(0.5, 0.35), book: rect(0.22, 0.25) });
  const { placement } = run(placementOf(split(0.6), canvas), false);
  const floated = floatRects(placement.dock!, windows.hidden, dockArea)[windowId("book")]!;
  expect(floated.w).toBeCloseTo(0.3 * 1440 - 48, 6);
  expect(floated.x).toBeCloseTo(0.1 * 1440, 6);
  expect(placement.dock!.root).not.toBe(split(0.6).root);
  expect(placement.dock!.root).toMatchObject({ ratio: expect.closeTo((Math.round(0.6 * 1446) + 48) / 1446, 9) });
  expect(placement.canvas).not.toBe(canvas);
});

test("저장된 도킹이 없으면 도킹 방식일 때만 그려진 기본 배치를 좁혀 저장한다", () => {
  expect(run(placementOf(null, null), false, "dock").placement.dock).not.toBeNull();
  const canvas = canvasOf({ chart: rect(0, 0.2), order: rect(0.5, 0.35), book: rect(0.22, 0.25) });
  expect(run(placementOf(null, canvas), false, "canvas").placement.dock).toBeNull();
});

test("최소 폭에 걸려 덜 옮긴 나눔도 기억으로 처음 비율에 돌아가고, 그 사이 고른 탭은 지킨다", () => {
  const start = split(0.74);
  const tabs = { ...start, root: { ...start.root, second: { kind: "group", id: "g2", tabs: [windowId("order"), windowId("book")], active: windowId("order") } } as DockPlacement["root"], floats: [] };
  const off = run(placementOf(tabs, null), false, "dock");
  const memory: DockMemory = new Map([off.remembered!]);
  const dock = off.placement.dock!;
  const picked = { ...dock, root: { ...dock.root, second: { kind: "group", id: "g2", tabs: [windowId("order"), windowId("book")], active: windowId("book") } } as DockPlacement["root"] };
  const on = run(placementOf(picked, null), true, "dock", memory).placement.dock!;
  expect(on.root).toMatchObject({ ratio: 0.74, second: { active: "book" } });
});

test("호가주문·10호가가 없는 배치는 바꾸지 않는다", () => {
  const charts: [WindowRef, ...WindowRef[]] = [ref("chart", "chart", false)];
  const placement = placementOf(null, canvasOf({ chart: rect(0, 0.2) }));
  expect(shiftForLadderRate(placement, { ...changeTo(false, "dock"), windows: { hidden: charts, shown: charts } }, none)).toEqual({ placement, remembered: null });
});
