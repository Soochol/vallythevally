import { beforeEach, expect, test } from "vitest";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { clearSettingsHistory, isUndoKey, registerDrawingDepth, SETTINGS_COALESCE_MS, undoChartSettings, watchChartSettings } from "./settingsHistory";

const CELL = chartWindows(DEFAULT_LAYOUT)[0]!.id;
const style = () => chartWindows(useLayoutStore.getState().layout).find((cell) => cell.id === CELL)!.chartSettings.style;
const clock = { now: 0 };
const key = (code: string, extra: Partial<KeyboardEvent> = {}) => ({ code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...extra });

let stop = () => {};
beforeEach(() => {
  stop();
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  useSelectionStore.getState().clearToasts();
  clearSettingsHistory();
  clock.now = 0;
  stop = watchChartSettings(() => clock.now);
});

test("차트 설정 변경을 기록해 되돌리고 다시 하며 알린다", () => {
  useLayoutStore.getState().setStyle(CELL, "line");
  expect(undoChartSettings({ kind: "open" })).toBe(true);
  expect(style()).toBe("candle");
  expect(useSelectionStore.getState().toasts.at(-1)?.text).toBe("지표·차트 설정 변경을 되돌렸습니다");
  expect(undoChartSettings({ kind: "open" }, true)).toBe(true);
  expect(style()).toBe("line");
  expect(undoChartSettings({ kind: "open" })).toBe(true);
  expect(undoChartSettings({ kind: "open" })).toBe(false);
});

test("짧은 간격의 연속 변경은 한 걸음으로, 떨어진 변경은 따로 되돌린다", () => {
  useLayoutStore.getState().setStyle(CELL, "line");
  clock.now += SETTINGS_COALESCE_MS - 1;
  useLayoutStore.getState().setStyle(CELL, "bar");
  clock.now += SETTINGS_COALESCE_MS;
  useLayoutStore.getState().setStyle(CELL, "area");
  undoChartSettings({ kind: "open" });
  expect(style()).toBe("bar");
  undoChartSettings({ kind: "open" });
  expect(style()).toBe("candle");
});

test("되돌린 뒤 새로 바꾸면 다시 하기는 사라진다", () => {
  useLayoutStore.getState().setStyle(CELL, "line");
  undoChartSettings({ kind: "open" });
  clock.now += SETTINGS_COALESCE_MS;
  useLayoutStore.getState().setStyle(CELL, "bar");
  expect(undoChartSettings({ kind: "open" }, true)).toBe(false);
  expect(style()).toBe("bar");
});

test("그 뒤에 드로잉이 더 그려졌으면 차트 초점의 되돌리기를 드로잉에 넘긴다", () => {
  let depth = 0;
  const release = registerDrawingDepth(CELL, () => depth);
  useLayoutStore.getState().setStyle(CELL, "line");
  depth = 1;
  expect(undoChartSettings({ kind: "chart", cellId: CELL })).toBe(false);
  expect(style()).toBe("line");
  depth = 0;
  expect(undoChartSettings({ kind: "chart", cellId: CELL })).toBe(true);
  expect(style()).toBe("candle");
  release();
});

test("레이아웃을 새로 열면 기록을 비운다", () => {
  useLayoutStore.getState().setStyle(CELL, "line");
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  expect(undoChartSettings({ kind: "open" })).toBe(false);
});

test("Ctrl+Z는 되돌리기, Ctrl+Shift+Z와 Ctrl+Y는 다시 하기다", () => {
  expect(isUndoKey(key("KeyZ"))).toBe("undo");
  expect(isUndoKey(key("KeyZ", { shiftKey: true }))).toBe("redo");
  expect(isUndoKey(key("KeyY"))).toBe("redo");
  expect(isUndoKey(key("KeyZ", { ctrlKey: false, metaKey: true }))).toBe("undo");
  expect(isUndoKey(key("KeyZ", { altKey: true }))).toBeNull();
  expect(isUndoKey(key("KeyZ", { ctrlKey: false }))).toBeNull();
});
