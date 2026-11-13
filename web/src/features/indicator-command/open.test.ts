import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_UI_PREFS } from "../../persist/uiState";
import { DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { openIndicatorCommand } from "./open";

const screen = (desktop: boolean) => vi.stubGlobal("matchMedia", () => ({ matches: desktop }));

beforeEach(() => {
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  useUiStore.getState().load(DEFAULT_UI_PREFS, {});
  useSelectionStore.setState({ dialog: null, inspector: null });
});
afterEach(() => vi.unstubAllGlobals());

test("가운데 창 방식은 모드 없이 열면 띄운 지표가 있을 때 띄운 지표 탭, 없을 때 지표 추가 탭이다", () => {
  screen(true);
  openIndicatorCommand(0);
  expect(useSelectionStore.getState().dialog).toEqual({ kind: "indicatorCommand", slot: 0, mode: "current", indicatorId: null });
  for (const config of useLayoutStore.getState().layout.cells[0]!.chartSettings.indicators) useLayoutStore.getState().removeIndicator(0, config.id);
  openIndicatorCommand(0);
  expect(useSelectionStore.getState().dialog).toMatchObject({ mode: "add" });
  openIndicatorCommand(0, "compare");
  expect(useSelectionStore.getState().dialog).toMatchObject({ mode: "compare" });
  expect(useUiStore.getState().prefs.rightPanel).toBe("watch");
});

test("차트 옆 방식은 데스크톱에서 창 대신 접힌 우측 패널을 지표 보기로 열고 탭과 지표를 요청한다", () => {
  screen(true);
  useUiStore.getState().load({ ...DEFAULT_UI_PREFS, indicatorWindow: "inspector", watchCollapsed: true }, {});
  const id = useLayoutStore.getState().layout.cells[0]!.chartSettings.indicators[0]!.id;
  openIndicatorCommand(0, "current", id);
  expect(useSelectionStore.getState().dialog).toBeNull();
  expect(useUiStore.getState().prefs).toMatchObject({ rightPanel: "indicators", watchCollapsed: false });
  expect(useSelectionStore.getState().takeInspectorRequest()).toEqual({ slot: 0, mode: "current", indicatorId: id });
  expect(useSelectionStore.getState().takeInspectorRequest()).toBeNull();
});

test("데스크톱이 아니면 차트 옆 방식이어도 가운데 창을 연다", () => {
  screen(false);
  useUiStore.getState().load({ ...DEFAULT_UI_PREFS, indicatorWindow: "inspector" }, {});
  openIndicatorCommand(0, "add");
  expect(useSelectionStore.getState().dialog).toEqual({ kind: "indicatorCommand", slot: 0, mode: "add", indicatorId: null });
  expect(useSelectionStore.getState().inspector).toBeNull();
  expect(useUiStore.getState().prefs.rightPanel).toBe("watch");
});
