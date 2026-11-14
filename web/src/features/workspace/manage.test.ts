import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, test } from "vitest";
import { windowId } from "../../layout/kinds";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { addWindow, closeWindow } from "./manage";

const room = { area: { w: 1256, h: 684 }, gap: 6 };
const client = new QueryClient();
const layout = () => useLayoutStore.getState().layout;
const active = () => useSelectionStore.getState().activeCell;
const charts = () => chartWindows(layout()).map((w) => w.id);

beforeEach(() => {
  useLayoutStore.setState({ layout: structuredClone(DEFAULT_LAYOUT), revision: 0, steps: [] });
  useSelectionStore.setState({ activeCell: chartWindows(DEFAULT_LAYOUT)[0]!.id, toast: null });
});

test("차트 창을 더하면 활성 칸의 내용과 연동 색을 복사한 새 창이 활성 칸이 된다", () => {
  const source = chartWindows(layout())[0]!;
  useLayoutStore.getState().setPeriod(source.id, "W");
  addWindow("chart", room);
  const added = chartWindows(layout()).at(-1)!;
  expect(active()).toBe(added.id);
  expect(added).toEqual({ ...chartWindows(layout())[0]!, id: added.id });
  addWindow("chart", room);
  expect(chartWindows(layout()).at(-1)!.id).toBe(active());
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
  expect(closeWindow(third!, "칸 3", client)).toBe(true);
  expect(active()).toBe(first);
  useSelectionStore.getState().setActiveCell(second!);
  expect(closeWindow(first!, "칸 1", client)).toBe(true);
  expect(active()).toBe(second);
  expect(closeWindow(second!, "칸 1", client)).toBe(false);
  expect(charts()).toEqual([second]);
});

test("닫기 알림의 되돌리기는 창을 돌리고, 알림 뒤 다른 배치 변경이 있으면 쓸 수 없다", () => {
  expect(closeWindow(windowId("screener"), "스크리너", client)).toBe(true);
  const toast = useSelectionStore.getState().toast!;
  expect(toast.text).toBe("스크리너 창을 닫았습니다");
  expect(toast.undo!.available()).toBe(true);
  toast.undo!.run();
  expect(layout().windows.some((w) => w.id === "screener")).toBe(true);
  expect(toast.undo!.available()).toBe(false);

  closeWindow(windowId("objects"), "개체 목록", client);
  const later = useSelectionStore.getState().toast!.undo!;
  addWindow("chart", room);
  expect(later.available()).toBe(false);
  later.run();
  expect(layout().windows.some((w) => w.id === "objects")).toBe(false);
});
