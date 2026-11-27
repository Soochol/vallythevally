import { beforeEach, expect, test } from "vitest";
import { workArea } from "../../layout/canvas/geometry";
import { windowId } from "../../layout/kinds";
import { placementForMode } from "../../layout/modes";
import { DEFAULT_UI_PREFS } from "../../persist/uiState";
import { resetActiveWindow, touchWindow } from "../../stores/activeWindow";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore, windowRefs } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { addWindow, closeWindow } from "./manage";

const room = { area: { w: 1256, h: 684 }, gap: 6 };
const layout = () => useLayoutStore.getState().layout;
const active = () => useSelectionStore.getState().activeCell;
const charts = () => chartWindows(layout()).map((w) => w.id);

beforeEach(() => {
  resetActiveWindow();
  useLayoutStore.setState({ layout: structuredClone(DEFAULT_LAYOUT), revision: 0, steps: [], canvasArea: null, lastUsedLink: null });
  useSelectionStore.setState({ activeCell: chartWindows(DEFAULT_LAYOUT)[0]!.id, toast: null });
  useUiStore.getState().load(DEFAULT_UI_PREFS, {});
});

test("차트 창을 더하면 활성 칸의 내용과 상속한 연동 색을 가진 새 창이 활성 칸이 된다", () => {
  const source = chartWindows(layout())[0]!;
  useLayoutStore.getState().setPeriod(source.id, "W");
  addWindow("chart", room);
  const added = chartWindows(layout()).at(-1)!;
  expect(active()).toBe(added.id);
  expect(added).toEqual({ ...chartWindows(layout())[0]!, id: added.id, link: "a" });
  useLayoutStore.getState().setLink(added.id, "b");
  touchWindow(added.id);
  addWindow("chart", room);
  const third = chartWindows(layout()).at(-1)!;
  expect(third.id).toBe(active());
  expect(third.link).toBe("b");
});

test("하나만 두는 종류를 다시 더하면 창 수가 그대로이고 그 탭을 고른다", () => {
  addWindow("indicators", room);
  const count = layout().windows.length;
  useLayoutStore.getState().selectTab(windowId("watchlist"));
  addWindow("indicators", room);
  expect(layout().windows).toHaveLength(count);
  const dock = layout().placement.dock!;
  expect(JSON.stringify(dock)).toContain('"active":"indicators"');
});

test("활성 칸의 차트 창을 닫으면 남은 차트 창 가운데 창 목록의 첫 창이 활성 칸이 된다", () => {
  addWindow("chart", room);
  addWindow("chart", room);
  const [first, second, third] = charts();
  expect(active()).toBe(third);
  expect(closeWindow(third!, "칸 3")).toBe(true);
  expect(active()).toBe(first);
  useSelectionStore.getState().setActiveCell(second!);
  expect(closeWindow(first!, "칸 1")).toBe(true);
  expect(active()).toBe(second);
  expect(closeWindow(second!, "칸 1")).toBe(false);
  expect(charts()).toEqual([second]);
});

test("닫기 알림의 되돌리기는 창을 돌리고, 알림 뒤 다른 배치 변경이 있으면 쓸 수 없다", () => {
  expect(closeWindow(windowId("screener"), "스크리너")).toBe(true);
  const toast = useSelectionStore.getState().toast!;
  expect(toast.text).toBe("스크리너 창을 닫았습니다");
  expect(toast.undo!.available()).toBe(true);
  toast.undo!.run();
  expect(layout().windows.some((w) => w.id === "screener")).toBe(true);
  expect(toast.undo!.available()).toBe(false);

  closeWindow(windowId("watchlist"), "관심종목");
  const later = useSelectionStore.getState().toast!.undo!;
  addWindow("chart", room);
  expect(later.available()).toBe(false);
  later.run();
  expect(layout().windows.some((w) => w.id === "watchlist")).toBe(false);
});

test("활성 칸을 닫을 때 첫 차트가 다른 탭 뒤에 숨어 있으면 그 탭을 골라 보인다", () => {
  addWindow("chart", null);
  addWindow("chart", room);
  const [first, tabbed, beside] = charts();
  const dock = () => layout().placement.dock!;
  expect(JSON.stringify(dock())).toContain(`"tabs":["${first}","${tabbed}"],"active":"${tabbed}"`);
  useSelectionStore.getState().setActiveCell(beside!);
  expect(closeWindow(beside!, "칸 3")).toBe(true);
  expect(active()).toBe(first);
  expect(JSON.stringify(dock())).toContain(`"tabs":["${first}","${tabbed}"],"active":"${first}"`);
});

test("활성 캔버스 차트 닫기와 남은 차트 앞으로 보이기는 한 단계이며 알림 한 번으로 복원한다", () => {
  const state = () => useLayoutStore.getState();
  const canvasArea = workArea(1256, 636)!;
  state().settlePlacement(placementForMode(layout().placement, windowRefs(layout().windows), "canvas", { dock: room, canvas: canvasArea }));
  state().setCanvasArea(canvasArea);
  useUiStore.getState().setLayoutMode("canvas");
  const id = addWindow("chart", room)!;
  state().setPeriod(id, "W");
  const before = layout().placement;
  const steps = state().steps.length;
  const first = charts()[0]!;
  expect(before.canvas!.order.at(-1)).toBe(id);
  expect(before.canvas!.order.indexOf(first)).toBeLessThan(before.canvas!.order.indexOf(windowId("watchlist")));
  expect(closeWindow(id, "차트")).toBe(true);
  expect(state().steps).toHaveLength(steps + 1);
  expect(layout().placement.canvas!.order.at(-1)).toBe(first);
  expect(active()).toBe(first);
  state().setPeriod(first, "M");
  const undo = useSelectionStore.getState().toast!.undo!;
  expect(undo.available()).toBe(true);
  undo.run();
  expect(layout().placement).toBe(before);
  expect(chartWindows(layout()).find((window) => window.id === id)?.period).toBe("W");
  expect(chartWindows(layout()).find((window) => window.id === first)?.period).toBe("M");
  expect(undo.available()).toBe(false);
});
