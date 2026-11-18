import { beforeEach, expect, test } from "vitest";
import { workArea } from "../layout/canvas/geometry";
import { placementForMode } from "../layout/modes";
import { MAX_WINDOWS, windowId } from "../layout/kinds";
import { byteLength, PAYLOAD_LIMIT_BYTES } from "../persist/bytes";
import { DEFAULT_UI_PREFS } from "../persist/uiState";
import { DEFAULT_LAYOUT, fittedDock, useLayoutStore, windowRefs } from "./layout";
import { useUiStore } from "./ui";

const state = () => useLayoutStore.getState();
const room = { dock: { area: { w: 1400, h: 760 }, gap: 6 }, canvas: workArea(1400, 712)! };
const activate = () => {
  const { layout } = state();
  state().settlePlacement(placementForMode(layout.placement, windowRefs(layout.windows), "canvas", room));
  state().setCanvasArea(room.canvas);
  useUiStore.getState().setLayoutMode("canvas");
};

beforeEach(() => {
  useLayoutStore.setState({ layout: structuredClone(DEFAULT_LAYOUT), steps: [], revision: 0, session: 1, canvasArea: null });
  useUiStore.getState().load(DEFAULT_UI_PREFS, {});
});

test("전환 초기화는 기록과 세션을 바꾸지 않고 이전 도킹 기록을 되돌려도 캔버스를 지우지 않는다", () => {
  state().setDock(fittedDock(state().layout));
  const steps = state().steps;
  activate();
  expect(state().steps.map((step) => step.id)).toEqual(steps.map((step) => step.id));
  expect(state().session).toBe(1);
  const canvas = state().layout.placement.canvas;
  state().undoArrangement();
  expect(state().layout.placement.canvas).toBe(canvas);
});

test("포인터 트랜잭션은 현재 창 설정과 다른 방식의 배치를 보존하며 한 단계로 반영한다", () => {
  activate();
  const expected = state().layout.placement.canvas!;
  const dock = state().layout.placement.dock;
  const id = windowId("cell-0");
  const next = { ...expected, rects: { ...expected.rects, [id]: { ...expected.rects[id]!, x: .2 } } };
  state().setPeriod(id, "W");
  expect(state().commitCanvas({ session: 1, expected, next })).toBe(true);
  expect(state().steps).toHaveLength(1);
  expect(state().layout.windows[0]).toMatchObject({ period: "W" });
  expect(state().layout.placement.dock).toBe(dock);
  expect(state().commitCanvas({ session: 1, expected, next })).toBe(false);
  expect(state().commitCanvas({ session: 0, expected: next, next })).toBe(false);
  expect(state().steps).toHaveLength(1);
});

test("캔버스에서 창 더하기·보이기·닫기는 활성 배치만 한 단계씩 바꾸고 닫기 되돌리기는 자리를 복원한다", () => {
  state().settleDock(fittedDock(state().layout));
  activate();
  const dock = state().layout.placement.dock;
  const id = state().addChart(windowId("cell-0"), null)!;
  expect(state().steps).toHaveLength(1);
  expect(state().layout.placement.dock).toBe(dock);
  expect(state().layout.placement.canvas!.order.at(-1)).toBe(id);
  const canvas = state().layout.placement.canvas!;
  state().showWindow("watchlist");
  expect(state().layout.windows).toHaveLength(4);
  expect(state().steps).toHaveLength(2);
  expect(state().layout.placement.canvas!.order.at(-1)).toBe("watchlist");
  state().selectTab(id);
  expect(state().layout.placement.canvas!.order.at(-1)).toBe(id);
  expect(state().layout.placement.dock).toBe(dock);
  expect(state().closeWindow(id)).toBe(true);
  expect(state().layout.placement.canvas!.rects[id]).toBeUndefined();
  state().undoArrangement();
  expect(state().layout.placement.canvas!.rects[id]).toEqual(canvas.rects[id]);
  expect(state().layout.placement.dock).toBe(dock);
});

test("작업 영역 등록을 해제하면 캔버스 설정이어도 휴대폰 명령은 기존 도킹에 적용된다", () => {
  activate();
  const canvas = state().layout.placement.canvas;
  state().setCanvasArea(null);
  state().showWindow("indicators");
  expect(state().layout.placement.canvas).toBe(canvas);
  expect(state().layout.placement.dock).not.toBeNull();
});

test("같은 자리와 차례는 기록하지 않고 방식을 떠난 트랜잭션은 버린다", () => {
  activate();
  const expected = state().layout.placement.canvas!;
  expect(state().commitCanvas({ session: 1, expected, next: structuredClone(expected) })).toBe(true);
  expect(state().steps).toHaveLength(0);
  useUiStore.getState().setLayoutMode("dock");
  const next = { ...expected, order: [...expected.order].reverse() };
  expect(state().commitCanvas({ session: 1, expected, next })).toBe(false);
  expect(state().steps).toHaveLength(0);
  expect(state().layout.placement.canvas).toBe(expected);
});

test("캔버스에서 같은 종류 창 더하기는 둘째 창을 맨 앞에 더하고 보이기는 첫 창을 앞으로 가져오며 복제는 하지 않는다", () => {
  activate();
  expect(state().openWindow("watchlist")).toBe("watchlist-2");
  expect(state().layout.placement.canvas!.order.at(-1)).toBe("watchlist-2");
  expect(state().steps).toHaveLength(1);
  state().showWindow("watchlist");
  expect(state().layout.windows.filter((w) => w.kind === "watchlist")).toHaveLength(2);
  expect(state().layout.placement.canvas!.order.at(-1)).toBe("watchlist");
  const before = state().layout.windows;
  expect(state().duplicateWindow(windowId("watchlist"))).toBeNull();
  expect(state().layout.windows).toBe(before);
});

test("캔버스에 창 50개를 더해도 배치 JSON은 64KB보다 작고 51번째 창은 더해지지 않는다", () => {
  activate();
  while (state().layout.windows.length < MAX_WINDOWS) expect(state().openWindow("trades")).not.toBeNull();
  expect(byteLength(JSON.stringify(state().layout.placement))).toBeLessThan(PAYLOAD_LIMIT_BYTES);
  const before = state().layout.windows;
  expect(state().openWindow("book")).toBeNull();
  expect(state().layout.windows).toBe(before);
});
