import { beforeEach, expect, test } from "vitest";
import { rectsForArea } from "../../layout/canvas/arrange";
import { workArea } from "../../layout/canvas/geometry";
import { windowId } from "../../layout/kinds";
import { DEFAULT_LAYOUT, useLayoutStore, windowRefs, type EditableLayout } from "../../stores/layout";
import { useUiStore } from "../../stores/ui";
import { DEFAULT_UI_PREFS } from "../../persist/uiState";
import { setLadderRate } from "./canvasCommands";

const ORDER = windowId("order");
const area = workArea(1440, 900)!;
const state = () => useLayoutStore.getState();
const orderWidth = () => rectsForArea(state().layout.placement.canvas!, windowRefs(state().layout.windows), area)[ORDER]!.w;
const layout: EditableLayout = {
  ...DEFAULT_LAYOUT,
  windows: [DEFAULT_LAYOUT.windows[0]!, { id: ORDER, link: null, kind: "order", venue: "krx" }],
  placement: { v: 1, dock: null, canvas: { rects: { [windowId("cell-0")]: { x: 0, y: 0, w: 0.3, h: 0.5 }, [ORDER]: { x: 0.4, y: 0, w: 0.4, h: 0.8 } }, order: [windowId("cell-0"), ORDER] } },
};

beforeEach(() => {
  useUiStore.getState().load({ ...DEFAULT_UI_PREFS, layoutMode: "canvas" }, {});
  state().load(layout);
  state().setWorkspaceArea({ w: 1440, h: 948 });
  state().setCanvasArea(area);
});

test("등락률을 끄면 폭과 설정을 한 번에 바꾸고 실행 취소 목록은 그대로다", () => {
  const before = orderWidth();
  const { revision } = state();
  setLadderRate(false);
  expect(useUiStore.getState().prefs.orderSettings.rate).toBe(false);
  expect(orderWidth()).toBeCloseTo(before - 48, 6);
  expect(state().revision).toBe(revision + 1);
  expect(state().steps).toHaveLength(0);
  setLadderRate(false);
  expect(state().revision).toBe(revision + 1);
});

test("끄기 전 배치로 되돌려도 좁은 폭이고 다시 켜면 처음 폭이다", () => {
  const before = orderWidth();
  const expected = state().layout.placement.canvas!;
  state().commitCanvas({ session: state().session, expected, next: { ...expected, rects: { ...expected.rects, [ORDER]: { x: 0.1, y: 0, w: 0.5, h: 0.8 } } } });
  const moved = orderWidth();
  setLadderRate(false);
  expect(orderWidth()).toBeCloseTo(moved - 48, 6);
  state().undoArrangement();
  expect(orderWidth()).toBeCloseTo(before - 48, 6);
  setLadderRate(true);
  expect(orderWidth()).toBeCloseTo(before, 6);
  state().redoArrangement();
  expect(orderWidth()).toBeCloseTo(moved, 6);
});

test("다른 창에서 설정만 바뀌어 들어오거나 화면 크기를 모르면 배치를 고치지 않는다", () => {
  const { placement } = state().layout;
  const { prefs, extra, load } = useUiStore.getState();
  load({ ...prefs, orderSettings: { ...prefs.orderSettings, rate: false } }, extra);
  expect(state().layout.placement).toBe(placement);
  load(prefs, extra);
  state().setWorkspaceArea(null);
  setLadderRate(false);
  expect(useUiStore.getState().prefs.orderSettings.rate).toBe(false);
  expect(state().layout.placement).toBe(placement);
});
