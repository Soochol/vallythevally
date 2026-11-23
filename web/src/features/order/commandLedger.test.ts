import { expect, test } from "vitest";
import { actionInAccount, cancelAction, cancelBatchAction, createLedger, modifyAction, newIdFor, placeAction } from "./commandLedger";

const counter = () => {
  let n = 0;
  return () => `id-${++n}`;
};

test("취소·정정의 응답 전 같은 동작은 명령 하나로 묶인다", () => {
  for (const action of [cancelAction("0000001"), modifyAction("0000001", 71_000), cancelBatchAction("005930", "buy", 71_000)]) {
    const ledger = createLedger(counter());
    const first = ledger.issue(action);
    const duplicate = ledger.issue(action);
    expect(first).toEqual({ id: "id-1", send: true });
    expect(duplicate).toEqual({ id: "id-1", send: false });
  }
});

const WINDOW = "order";

test("신규처럼 묶지 않는 동작은 요청마다 새 id이고 답을 못 받은 뒤 같은 동작을 다시 할 때만 그 id를 쓴다", () => {
  const ledger = createLedger(counter());
  const action = placeAction("005930", "buy", 71_000, 10, "krx");
  const first = ledger.issueEach(WINDOW, action);
  const second = ledger.issueEach(WINDOW, action);
  expect(first).toBe("id-1");
  expect(second).toBe("id-2");
  ledger.settleEach(WINDOW, action, first, "unanswered");
  ledger.settleEach(WINDOW, action, second, "answered");
  const retry = ledger.issueEach(WINDOW, action);
  const whileRetrying = ledger.issueEach(WINDOW, action);
  expect(retry).toBe(first);
  expect(whileRetrying).toBe("id-3");
  ledger.settleEach(WINDOW, action, retry, "answered");
  ledger.settleEach(WINDOW, action, whileRetrying, "answered");
  expect(ledger.issueEach(WINDOW, action)).toBe("id-4");
});

test("응답 없는 신규 id가 둘이면 다음 두 신규가 앞 id, 뒤 id 순서로 쓰고 세 번째는 새 id다", () => {
  const ledger = createLedger(counter());
  const action = placeAction("005930", "buy", 71_000, 10, "krx");
  const first = ledger.issueEach(WINDOW, action);
  const second = ledger.issueEach(WINDOW, action);
  ledger.settleEach(WINDOW, action, first, "unanswered");
  ledger.settleEach(WINDOW, action, second, "unanswered");
  expect([ledger.issueEach(WINDOW, action), ledger.issueEach(WINDOW, action), ledger.issueEach(WINDOW, action)]).toEqual(["id-1", "id-2", "id-3"]);
});

test("답을 받은 신규 id는 다시 나오지 않는다", () => {
  const ledger = createLedger(counter());
  const action = placeAction("005930", "buy", 71_000, 10, "krx");
  const first = ledger.issueEach(WINDOW, action);
  const second = ledger.issueEach(WINDOW, action);
  ledger.settleEach(WINDOW, action, first, "answered");
  ledger.settleEach(WINDOW, action, second, "unanswered");
  expect(ledger.issueEach(WINDOW, action)).toBe("id-2");
  expect(ledger.issueEach(WINDOW, action)).toBe("id-3");
});

test("한 창에서 응답 없던 신규 id는 다른 창의 같은 동작에 나오지 않고 그 창의 다음 같은 동작에는 나온다", () => {
  const ledger = createLedger(counter());
  const action = placeAction("005930", "buy", 71_000, 10, "krx");
  const inA = ledger.issueEach("order", action);
  ledger.settleEach("order", action, inA, "unanswered");
  expect(ledger.issueEach("order-2", action)).toBe("id-2");
  expect(ledger.issueEach("order", action)).toBe(inA);
});

test("정정·취소는 창이 달라도 응답 전 같은 동작을 하나로 묶는다", () => {
  const ledger = createLedger(counter());
  const action = cancelAction("0000001");
  expect(ledger.issue(action)).toEqual({ id: "id-1", send: true });
  expect(ledger.issue(action)).toEqual({ id: "id-1", send: false });
});

test("끝난 동작을 다시 하면 새 명령이다", () => {
  const ledger = createLedger(counter());
  const action = placeAction("005930", "buy", 71_000, 10, "krx");
  ledger.issue(action);
  ledger.settle(action, "answered");
  expect(ledger.issue(action)).toEqual({ id: "id-2", send: true });
});

test("다른 가격·방향·수량의 동작은 서로 다른 명령이다", () => {
  const ledger = createLedger(counter());
  const ids = [
    placeAction("005930", "buy", 71_000, 10, "krx"),
    placeAction("005930", "buy", 71_100, 10, "krx"),
    placeAction("005930", "sell", 71_000, 10, "krx"),
    placeAction("005930", "buy", 71_000, 20, "krx"),
  ].map((action) => ledger.issue(action).id);
  expect(new Set(ids).size).toBe(4);
});

test("일괄 취소는 요청마다 새 batchId를 만들고 답을 못 받은 같은 동작의 재전송에만 같은 값을 쓴다", () => {
  const ledger = createLedger(newIdFor);
  const at71000 = cancelBatchAction("005930", "buy", 71_000);

  const first = ledger.issue(at71000);
  expect(first.id).toMatch(/^batch-[0-9a-f-]{36}$/);
  ledger.settle(at71000, "unanswered");
  const resent = ledger.issue(at71000);
  expect(resent).toEqual({ id: first.id, send: true });

  const otherPrice = ledger.issue(cancelBatchAction("005930", "buy", 71_100));
  const otherSide = ledger.issue(cancelBatchAction("005930", "sell", 71_000));
  expect(new Set([first.id, otherPrice.id, otherSide.id]).size).toBe(3);

  ledger.settle(at71000, "answered");
  const later = ledger.issue(at71000);
  expect(later.send).toBe(true);
  expect(later.id).not.toBe(first.id);
});

test("같은 가격 일괄 취소도 계좌가 다르면 서로 합쳐지지 않는다", () => {
  const ledger = createLedger(newIdFor);
  const action = cancelBatchAction("005930", "buy", 71_000);
  const first = ledger.issue(actionInAccount(action, "account-a"));
  const second = ledger.issue(actionInAccount(action, "account-b"));
  expect([first.send, second.send]).toEqual([true, true]);
  expect(ledger.issue(actionInAccount(action, "account-a")).send).toBe(false);
});

test("창의 재전송 줄을 꺼내면 그 창만 비고 되돌려 넣으면 그대로 되찾는다", () => {
  const ledger = createLedger(counter());
  const action = placeAction("005930", "buy", 71_000, 10, "krx");
  ledger.settleEach("order-2", action, "left-2", "unanswered");
  ledger.settleEach("order-3", action, "left-3", "unanswered");
  const taken = ledger.takeWindowResends("order-2");
  expect(ledger.issueEach("order-2", action)).toBe("id-1");
  expect(ledger.issueEach("order-3", action)).toBe("left-3");
  ledger.restoreWindowResends("order-2", taken);
  expect(ledger.issueEach("order-2", action)).toBe("left-2");
  expect(ledger.takeWindowResends("order-9").size).toBe(0);
});
