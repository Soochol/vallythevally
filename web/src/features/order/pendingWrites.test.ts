import { expect, test } from "vitest";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import { createPendingWrites, PENDING_MEMORY_MS } from "./pendingWrites";

const order = (orderNo: string, price = 70_000, openQuantity = 10): TradingOpenOrder => ({
  orderNo, code: "005930", name: "삼성전자", side: "buy", quantity: openQuantity, price, openQuantity, status: "접수", orderedAt: "100000", originalOrderNo: null, venue: "krx",
});

function clocked() {
  let now = 1_000;
  const store = createPendingWrites(() => now);
  return { store, advance: (ms: number) => { now += ms; } };
}

test("보내는 중 표시는 응답이 오면 접수 기억으로 바뀐다", () => {
  const { store } = clocked();
  store.begin({ kind: "sending", key: "k", code: "005930", side: "buy", price: 70_000, quantity: 10 });
  expect(store.has("k")).toBe(true);
  store.resolve("k", [{ kind: "placed", code: "005930", order: order("0000099") }]);
  expect(store.has("k")).toBe(false);
  expect(store.snapshot().map((write) => write.kind)).toEqual(["placed"]);
});

test("거절이면 보내는 중 표시만 지우고 아무것도 남기지 않는다", () => {
  const { store } = clocked();
  store.begin({ kind: "sending", key: "k", code: "005930", side: "buy", price: 70_000, quantity: 10 });
  store.resolve("k", []);
  expect(store.snapshot()).toEqual([]);
});

test("지워진 표시의 늦은 응답은 기억을 남기지 않는다", () => {
  const { store } = clocked();
  store.begin({ kind: "sending", key: "k", code: "005930", side: "buy", price: 70_000, quantity: 10 });
  store.clear("005930");
  store.resolve("k", [{ kind: "placed", code: "005930", order: order("0000099") }]);
  expect(store.snapshot()).toEqual([]);
});

test("접수 신규의 기억은 접수 뒤에 받은 재조회가 대신하고 그 전에 받은 재조회는 건드리지 않는다", () => {
  const { store } = clocked();
  store.begin({ kind: "sending", key: "k", code: "005930", side: "buy", price: 70_000, quantity: 10 });
  store.resolve("k", [{ kind: "placed", code: "005930", order: order("0000099") }]);
  store.observe("005930", { orders: [], at: 999 });
  expect(store.snapshot()).toHaveLength(1);
  store.observe("005930", { orders: [order("0000001"), order("0000099")], at: 1_000 });
  expect(store.snapshot()).toEqual([]);
});

test("접수 뒤의 재조회에 접수 신규가 없으면 기억을 버리고 재조회 값을 따른다", () => {
  const { store } = clocked();
  store.begin({ kind: "sending", key: "k", code: "005930", side: "buy", price: 70_000, quantity: 10 });
  store.resolve("k", [{ kind: "placed", code: "005930", order: order("0000099") }]);
  store.observe("005930", { orders: [], at: 1_500 });
  expect(store.snapshot()).toEqual([]);
});

test("접수한 취소의 기억은 재조회에서 그 주문이 사라지면 버리고 남아 있으면 유지한다", () => {
  const { store } = clocked();
  store.begin({ kind: "canceling", key: "c", code: "005930", orderNo: "0000001" });
  store.resolve("c", [{ kind: "gone", code: "005930", orderNo: "0000001" }]);
  store.observe("005930", { orders: [order("0000001")], at: 2_000 });
  expect(store.snapshot()).toHaveLength(1);
  store.observe("005930", { orders: [], at: 2_000 });
  expect(store.snapshot()).toEqual([]);
});

test("30초가 지난 기억은 버리고 그 전에는 둔다", () => {
  const { store, advance } = clocked();
  store.begin({ kind: "canceling", key: "c", code: "005930", orderNo: "0000001" });
  store.resolve("c", [{ kind: "gone", code: "005930", orderNo: "0000001" }]);
  advance(PENDING_MEMORY_MS);
  store.sweep();
  expect(store.snapshot()).toHaveLength(1);
  advance(1);
  store.sweep();
  expect(store.snapshot()).toEqual([]);
});

test("진행 중 표시는 시간이 지나도 버리지 않는다", () => {
  const { store, advance } = clocked();
  store.begin({ kind: "sending", key: "k", code: "005930", side: "buy", price: 70_000, quantity: 10 });
  advance(PENDING_MEMORY_MS * 10);
  store.sweep();
  expect(store.snapshot()).toHaveLength(1);
});

test("종목을 지정해 지우면 다른 종목의 표시는 남는다", () => {
  const { store } = clocked();
  store.begin({ kind: "sending", key: "a", code: "005930", side: "buy", price: 70_000, quantity: 10 });
  store.begin({ kind: "sending", key: "b", code: "000660", side: "buy", price: 70_000, quantity: 10 });
  store.clear("005930");
  expect(store.snapshot().map((write) => write.code)).toEqual(["000660"]);
  store.clear();
  expect(store.snapshot()).toEqual([]);
});

test("다른 종목의 재조회는 이 종목의 기억을 건드리지 않는다", () => {
  const { store } = clocked();
  store.begin({ kind: "canceling", key: "c", code: "005930", orderNo: "0000001" });
  store.resolve("c", [{ kind: "gone", code: "005930", orderNo: "0000001" }]);
  store.observe("000660", { orders: [], at: 2_000 });
  expect(store.snapshot()).toHaveLength(1);
});

test("구독자는 바뀔 때마다 알림을 받고 같은 내용이면 받지 않는다", () => {
  const { store } = clocked();
  let calls = 0;
  const off = store.subscribe(() => { calls += 1; });
  store.begin({ kind: "sending", key: "k", code: "005930", side: "buy", price: 70_000, quantity: 10 });
  store.sweep();
  expect(calls).toBe(1);
  off();
  store.clear();
  expect(calls).toBe(1);
});
