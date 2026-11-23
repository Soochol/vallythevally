import { beforeEach, expect, test } from "vitest";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { removeIndicatorWithUndo } from "./removalUndo";

const CELL = chartWindows(DEFAULT_LAYOUT)[0]!.id;
const indicators = () => chartWindows(useLayoutStore.getState().layout).find((cell) => cell.id === CELL)!.chartSettings.indicators;

beforeEach(() => {
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  useSelectionStore.getState().clearToasts();
});

test("지표를 지우면 되돌리기 알림이 뜨고 눌러서 숨김 상태까지 그대로 되살린다", () => {
  const before = indicators();
  const gone = before[0]!;
  useLayoutStore.getState().updateIndicator(CELL, gone.id, { visible: false });
  removeIndicatorWithUndo(CELL, indicators()[0]!);
  expect(indicators()).toHaveLength(before.length - 1);
  const toast = useSelectionStore.getState().toasts.at(-1)!;
  expect(toast.undo?.available()).toBe(true);
  toast.undo!.run();
  expect(toast.undo?.available()).toBe(false);
  const restored = indicators().at(-1)!;
  expect(restored.spec).toEqual(gone.spec);
  expect(restored.visible).toBe(false);
  toast.undo!.run();
  expect(indicators()).toHaveLength(before.length);
});
