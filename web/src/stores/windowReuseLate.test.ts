import { beforeEach, expect, test } from "vitest";
import { orderLedger } from "../features/order/commandLedger";
import { windowId } from "../layout/kinds";
import { DEFAULT_UI_PREFS } from "../persist/uiState";
import { DEFAULT_LAYOUT, useLayoutStore } from "./layout";
import { useUiStore } from "./ui";

const state = () => useLayoutStore.getState();

beforeEach(() => {
  useLayoutStore.setState({ layout: structuredClone(DEFAULT_LAYOUT), revision: 0, steps: [], redos: [] });
  useUiStore.getState().load(DEFAULT_UI_PREFS, {});
});

test("되돌리기로 사라진 동안 끝난 응답 없음은 다시 하기로 되살린 창이 같은 id로 다시 보낸다", () => {
  const action = "place|005930|buy|70000|1|krx|late-undo";
  state().openWindow("order");
  const sending = orderLedger.issueEach("order", action);
  state().undoArrangement();
  orderLedger.settleEach("order", action, sending, "unanswered");
  state().redoArrangement();
  expect(orderLedger.issueEach("order", action)).toBe(sending);
});

test("id 재사용 뒤 끝난 닫힌 창의 응답 없음은 되돌리기로 되살린 원래 창이 같은 id로 다시 보낸다", () => {
  const action = "place|005930|buy|70000|1|krx|late-reuse";
  state().openWindow("order");
  state().duplicateWindow(windowId("order"));
  const sending = orderLedger.issueEach("order-2", action);
  state().closeWindow(windowId("order-2"));
  state().openWindow("order");
  orderLedger.settleEach("order-2", action, sending, "unanswered");
  expect(orderLedger.issueEach("order-2", action)).not.toBe(sending);
  state().undoArrangement();
  state().undoArrangement();
  expect(orderLedger.issueEach("order-2", action)).toBe(sending);
});
