import { beforeEach, expect, test } from "vitest";
import { orderLedger } from "../features/order/commandLedger";
import { orderEntryKey, type OrderEntry } from "../features/order/orderEntries";
import { windowId } from "../layout/kinds";
import { DEFAULT_UI_PREFS } from "../persist/uiState";
import { DEFAULT_LAYOUT, useLayoutStore } from "./layout";
import { useUiStore } from "./ui";

const state = () => useLayoutStore.getState();
const closedEntry: OrderEntry = { quantity: 37, usedAt: 1 };
const reusedEntry: OrderEntry = { quantity: 5, usedAt: 2 };

beforeEach(() => {
  useLayoutStore.setState({ layout: structuredClone(DEFAULT_LAYOUT), revision: 0, steps: [], redos: [] });
  useUiStore.getState().load(DEFAULT_UI_PREFS, {});
});

const openSecondOrderWindow = () => {
  state().openWindow("order");
  expect(state().duplicateWindow(windowId("order"))).toBe("order-2");
};

const closeAndReuseOrderTwo = () => {
  expect(state().closeWindow(windowId("order-2"))).toBe(true);
  expect(state().openWindow("order")).toBe("order-2");
};

const restoreOriginalOrderTwo = () => {
  state().undoArrangement();
  expect(state().layout.windows.some((w) => w.id === "order-2")).toBe(false);
  state().undoArrangement();
  expect(state().layout.windows.some((w) => w.id === "order-2")).toBe(true);
};

const remembered = (layoutId: string) => useUiStore.getState().prefs.orderEntries[orderEntryKey(layoutId, "order-2", "005930")];

test("되돌리기로 되살린 호가주문창은 닫을 때의 기억을 되찾는다", () => {
  const layoutId = state().layout.id;
  openSecondOrderWindow();
  useUiStore.getState().rememberOrderEntry(orderEntryKey(layoutId, "order-2", "005930"), closedEntry);
  closeAndReuseOrderTwo();
  expect(remembered(layoutId)).toBeUndefined();
  useUiStore.getState().rememberOrderEntry(orderEntryKey(layoutId, "order-2", "005930"), reusedEntry);
  restoreOriginalOrderTwo();
  expect(remembered(layoutId)).toEqual(closedEntry);
});

test("닫은 창 id를 새 창이 받으면 응답 없던 재전송 id를 이어받지 않는다", () => {
  const action = "place|005930|buy|70000|1|krx|reuse-a";
  openSecondOrderWindow();
  const left = orderLedger.issueEach("order-2", action);
  orderLedger.settleEach("order-2", action, left, "unanswered");
  closeAndReuseOrderTwo();
  expect(orderLedger.issueEach("order-2", action)).not.toBe(left);
});

test("되돌리기로 되살린 호가주문창은 자기 재전송 id를 다시 쓴다", () => {
  const action = "place|005930|buy|70000|1|krx|reuse-b";
  openSecondOrderWindow();
  const left = orderLedger.issueEach("order-2", action);
  orderLedger.settleEach("order-2", action, left, "unanswered");
  closeAndReuseOrderTwo();
  restoreOriginalOrderTwo();
  expect(orderLedger.issueEach("order-2", action)).toBe(left);
});

test("새 창이 남긴 기억과 재전송 id는 되돌리기 뒤 다시 하기로 함께 돌아온다", () => {
  const layoutId = state().layout.id;
  const action = "place|005930|buy|70000|1|krx|reuse-c";
  expect(state().openWindow("order")).toBe("order");
  useUiStore.getState().rememberOrderEntry(orderEntryKey(layoutId, "order", "005930"), reusedEntry);
  const unanswered = orderLedger.issueEach("order", action);
  orderLedger.settleEach("order", action, unanswered, "unanswered");
  state().undoArrangement();
  expect(state().layout.windows.some((w) => w.id === "order")).toBe(false);
  state().redoArrangement();
  expect(state().layout.windows.some((w) => w.id === "order")).toBe(true);
  expect(useUiStore.getState().prefs.orderEntries[orderEntryKey(layoutId, "order", "005930")]).toEqual(reusedEntry);
  expect(orderLedger.issueEach("order", action)).toBe(unanswered);
});

test("id를 다시 준 뒤에 끝난 닫힌 창의 응답 없음은 새 창의 재전송 줄에 들어가지 않는다", () => {
  const action = "place|005930|buy|70000|1|krx|reuse-d";
  openSecondOrderWindow();
  const sending = orderLedger.issueEach("order-2", action);
  closeAndReuseOrderTwo();
  orderLedger.settleEach("order-2", action, sending, "unanswered");
  expect(orderLedger.issueEach("order-2", action)).not.toBe(sending);
});
