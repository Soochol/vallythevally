import { expect, test } from "vitest";
import { cancelAction, cancelBatchAction, createLedger, modifyAction, newIdFor, placeAction } from "./commandLedger";

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

test("신규처럼 묶지 않는 동작은 요청마다 새 id이고 답을 못 받은 뒤 같은 동작을 다시 할 때만 그 id를 쓴다", () => {
  const ledger = createLedger(counter());
  const action = placeAction("005930", "buy", 71_000, 10, "krx");
  const first = ledger.issueEach(action);
  const second = ledger.issueEach(action);
  expect(first).toBe("id-1");
  expect(second).toBe("id-2");
  ledger.settleEach(action, first, "unanswered");
  ledger.settleEach(action, second, "answered");
  expect(ledger.issueEach(action)).toBe(first);
  ledger.settleEach(action, first, "answered");
  expect(ledger.issueEach(action)).toBe("id-3");
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
