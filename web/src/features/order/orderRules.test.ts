import { expect, test } from "vitest";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import { capacityProblem, dragGhostText, groupOpenOrders, HIGH_VALUE_WON, judgeDrag, needsHighValueConfirm, quantityOf, sideTotal } from "./orderRules";

const order = (orderNo: string, side: "buy" | "sell", price: number, openQuantity: number, code = "005930"): TradingOpenOrder => ({
  orderNo, code, name: "삼성전자", side, quantity: openQuantity, price, openQuantity, status: "접수", orderedAt: "090000", originalOrderNo: null, venue: "krx",
});

test("같은 방향·가격의 미체결 잔량은 한 칩으로 합친다", () => {
  const groups = groupOpenOrders([order("0000003", "buy", 71_000, 5), order("0000001", "buy", 71_000, 7), order("0000002", "sell", 71_000, 4), order("0000004", "buy", 70_900, 1), order("0000005", "buy", 71_000, 9, "000660"), order("0000006", "buy", 71_000, 0)], "005930");
  expect(groups.get("buy:71000")?.quantity).toBe(12);
  expect(groups.get("buy:71000")?.orders.map((o) => o.orderNo)).toEqual(["0000001", "0000003"]);
  expect(groups.get("sell:71000")?.quantity).toBe(4);
  expect([...groups.keys()].sort()).toEqual(["buy:70900", "buy:71000", "sell:71000"]);
  expect(sideTotal(groups, "buy")).toEqual({ quantity: 13, count: 3 });
  expect(sideTotal(groups, "sell")).toEqual({ quantity: 4, count: 1 });
});

test("끌기: 같은 방향 다른 가격 칸이면 정정", () => {
  expect(judgeDrag({ chipSide: "buy", chipPrice: 71_000, target: { kind: "cell", side: "buy", price: 71_100 }, escaped: false })).toEqual({ kind: "modify", price: 71_100 });
});

test("끌기: 사다리 밖이면 취소", () => {
  expect(judgeDrag({ chipSide: "sell", chipPrice: 71_000, target: { kind: "outside" }, escaped: false })).toEqual({ kind: "cancel" });
});

test("끌기: Esc면 어디 위에 있어도 중단", () => {
  expect(judgeDrag({ chipSide: "buy", chipPrice: 71_000, target: { kind: "outside" }, escaped: true })).toEqual({ kind: "abort" });
  expect(judgeDrag({ chipSide: "buy", chipPrice: 71_000, target: { kind: "cell", side: "buy", price: 71_100 }, escaped: true })).toEqual({ kind: "abort" });
});

test("끌기: 반대 방향 칸, 같은 가격, 가격 열 위는 아무 일도 하지 않는다", () => {
  const chip = { chipSide: "buy", chipPrice: 71_000, escaped: false } as const;
  expect(judgeDrag({ ...chip, target: { kind: "cell", side: "sell", price: 71_100 } })).toEqual({ kind: "abort" });
  expect(judgeDrag({ ...chip, target: { kind: "cell", side: "buy", price: 71_000 } })).toEqual({ kind: "abort" });
  expect(judgeDrag({ ...chip, target: { kind: "ladder" } })).toEqual({ kind: "abort" });
});

test("고스트는 정정 가격이나 취소를 알린다", () => {
  const chip = { side: "buy", price: 71_000 } as const;
  expect(dragGhostText({ kind: "cell", side: "buy", price: 71_100 }, chip)).toBe("→ 71,100원");
  expect(dragGhostText({ kind: "outside" }, chip)).toBe("놓으면 취소");
  expect(dragGhostText({ kind: "ladder" }, chip)).toBe("");
});

test("1억원 경계에서 확인이 필요하다", () => {
  expect(HIGH_VALUE_WON).toBe(100_000_000);
  expect(needsHighValueConfirm(100_000, 999)).toBe(false);
  expect(needsHighValueConfirm(100_000, 1_000)).toBe(true);
  expect(needsHighValueConfirm(100_000, 1_001)).toBe(true);
  expect(needsHighValueConfirm(99_999, 1_000)).toBe(false);
});

test("금액 방식은 가격으로 나눈 몫을 수량으로 쓴다", () => {
  expect(quantityOf("amount", 1_000_000, 71_000)).toBe(14);
  expect(quantityOf("shares", 12.9, 71_000)).toBe(12);
  expect(quantityOf("shares", 0, 71_000)).toBe(0);
  expect(quantityOf("amount", 500, 71_000)).toBe(0);
});

test("가능 수량·금액을 넘는 주문은 보내기 전에 막는다", () => {
  const capacity = { sellableQuantity: 10, buyableAmount: 1_000_000 };
  expect(capacityProblem("sell", 71_000, 11, capacity)).toContain("매도 가능 수량");
  expect(capacityProblem("sell", 71_000, 10, capacity)).toBeNull();
  expect(capacityProblem("buy", 71_000, 15, capacity)).toContain("매수 가능 금액");
  expect(capacityProblem("buy", 71_000, 14, capacity)).toBeNull();
  expect(capacityProblem("buy", 71_000, 0, capacity)).toBe("수량을 입력하세요");
  expect(capacityProblem("buy", 71_000, 1_000, { sellableQuantity: null, buyableAmount: null })).toBeNull();
});
