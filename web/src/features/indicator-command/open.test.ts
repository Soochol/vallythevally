import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_UI_PREFS } from "../../persist/uiState";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { groupOfWindow } from "../../layout/dock/tree";
import { openIndicatorCommand } from "./open";

const CELL = chartWindows(DEFAULT_LAYOUT)[0]!.id;
const indicatorsShown = () => {
  const { windows, placement } = useLayoutStore.getState().layout;
  const id = windows.find((w) => w.kind === "indicators")?.id;
  return id !== undefined && placement.dock !== null && groupOfWindow(placement.dock.root, id)?.active === id;
};
const screen = (desktop: boolean) => vi.stubGlobal("matchMedia", () => ({ matches: desktop }));

beforeEach(() => {
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  useUiStore.getState().load(DEFAULT_UI_PREFS, {});
  useSelectionStore.setState({ dialog: null, inspector: null });
});
afterEach(() => vi.unstubAllGlobals());

test("가운데 창 방식은 모드 없이 열면 띄운 지표가 있을 때 띄운 지표 탭, 없을 때 지표 추가 탭이다", () => {
  screen(true);
  openIndicatorCommand(CELL);
  expect(useSelectionStore.getState().dialog).toEqual({ kind: "indicatorCommand", cellId: CELL, mode: "current", indicatorId: null });
  for (const config of chartWindows(useLayoutStore.getState().layout)[0]!.chartSettings.indicators) useLayoutStore.getState().removeIndicator(CELL, config.id);
  openIndicatorCommand(CELL);
  expect(useSelectionStore.getState().dialog).toMatchObject({ mode: "add" });
  openIndicatorCommand(CELL, "compare");
  expect(useSelectionStore.getState().dialog).toMatchObject({ mode: "compare" });
  expect(indicatorsShown()).toBe(false);
});

test("차트 옆 방식은 데스크톱에서 가운데 창 대신 지표 창을 보이고 탭과 지표를 요청한다", () => {
  screen(true);
  useUiStore.getState().load({ ...DEFAULT_UI_PREFS, indicatorWindow: "inspector" }, {});
  const id = chartWindows(useLayoutStore.getState().layout)[0]!.chartSettings.indicators[0]!.id;
  openIndicatorCommand(CELL, "current", id);
  expect(useSelectionStore.getState().dialog).toBeNull();
  expect(indicatorsShown()).toBe(true);
  expect(useSelectionStore.getState().takeInspectorRequest()).toEqual({ cellId: CELL, mode: "current", indicatorId: id });
  expect(useSelectionStore.getState().takeInspectorRequest()).toBeNull();
});

test("데스크톱이 아니면 차트 옆 방식이어도 가운데 창을 연다", () => {
  screen(false);
  useUiStore.getState().load({ ...DEFAULT_UI_PREFS, indicatorWindow: "inspector" }, {});
  openIndicatorCommand(CELL, "add");
  expect(useSelectionStore.getState().dialog).toEqual({ kind: "indicatorCommand", cellId: CELL, mode: "add", indicatorId: null });
  expect(useSelectionStore.getState().inspector).toBeNull();
  expect(indicatorsShown()).toBe(false);
});
