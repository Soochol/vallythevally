import { expect, test } from "vitest";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import { capacityProblem, type DragSource, type DragTarget, dragGhostText, dragQuantity, dragSide, groupOpenOrders, HIGH_VALUE_WON, judgeDrag, needsHighValueConfirm, type PriceGroup, quantityOf, sideTotal } from "./orderRules";

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

const chipGroup = (side: "buy" | "sell", price: number, quantities: number[]): PriceGroup => {
  const orders = quantities.map((quantity, index) => order(`000000${index + 1}`, side, price, quantity));
  return { side, price, quantity: quantities.reduce((sum, quantity) => sum + quantity, 0), orders };
};
const chip = (price = 71_000, side: "buy" | "sell" = "buy"): DragSource => ({ kind: "chip", group: chipGroup(side, price, [5, 7]) });
const listed: DragSource = { kind: "order", order: order("0000002", "buy", 71_000, 7) };
const total: DragSource = { kind: "total", side: "buy", groups: [chipGroup("buy", 71_000, [5, 7]), chipGroup("buy", 70_900, [3])] };
const cell = (side: "buy" | "sell", price: number): DragTarget => ({ kind: "cell", side, price });
const judge = (source: DragSource, target: DragTarget, escaped = false) => judgeDrag({ source, target, escaped });

test("칩: 사다리 밖이면 그 가격 취소, 같은 방향 다른 가격 칸이면 정정", () => {
  expect(judge(chip(), { kind: "outside" })).toEqual({ kind: "cancel" });
  expect(judge(chip(71_000, "sell"), { kind: "outside" })).toEqual({ kind: "cancel" });
  expect(judge(chip(), cell("buy", 71_100))).toEqual({ kind: "modify", price: 71_100 });
});

test("칩: 반대 방향 칸, 같은 칸, 사다리 안 빈 곳, Esc는 중단", () => {
  expect(judge(chip(), cell("sell", 71_100))).toEqual({ kind: "abort" });
  expect(judge(chip(), cell("buy", 71_000))).toEqual({ kind: "abort" });
  expect(judge(chip(), { kind: "ladder" })).toEqual({ kind: "abort" });
  expect(judge(chip(), { kind: "outside" }, true)).toEqual({ kind: "abort" });
  expect(judge(chip(), cell("buy", 71_100), true)).toEqual({ kind: "abort" });
});

test("목록 항목: 사다리 밖이면 그 주문 취소, 같은 방향 다른 가격 칸이면 그 주문 정정, 목록 상자 위는 중단", () => {
  expect(judge(listed, { kind: "outside" })).toEqual({ kind: "cancel" });
  expect(judge(listed, cell("buy", 70_900))).toEqual({ kind: "modify", price: 70_900 });
  expect(judge(listed, cell("sell", 70_900))).toEqual({ kind: "abort" });
  expect(judge(listed, cell("buy", 71_000))).toEqual({ kind: "abort" });
  expect(judge(listed, { kind: "origin" })).toEqual({ kind: "abort" });
  expect(judge(listed, { kind: "outside" }, true)).toEqual({ kind: "abort" });
});

test("합계 칸: 사다리 밖이면 그 방향 전부 취소, 합계 버튼 위와 사다리 안 어느 칸이든 중단", () => {
  expect(judge(total, { kind: "outside" })).toEqual({ kind: "cancel" });
  expect(judge(total, { kind: "origin" })).toEqual({ kind: "abort" });
  expect(judge(total, cell("buy", 70_900))).toEqual({ kind: "abort" });
  expect(judge(total, cell("sell", 70_900))).toEqual({ kind: "abort" });
  expect(judge(total, { kind: "ladder" })).toEqual({ kind: "abort" });
  expect(judge(total, { kind: "outside" }, true)).toEqual({ kind: "abort" });
});

test("고스트는 출발점마다 무엇이 취소되는지 알리고 정정이면 새 가격을 보인다", () => {
  expect(dragGhostText({ kind: "outside" }, chip())).toBe("놓으면 71,000원 매수 2건 취소");
  expect(dragGhostText({ kind: "outside" }, listed)).toBe("놓으면 이 주문 취소");
  expect(dragGhostText({ kind: "outside" }, total)).toBe("놓으면 매수 3건 모두 취소");
  expect(dragGhostText(cell("buy", 71_100), chip())).toBe("→ 71,100원");
  expect(dragGhostText(cell("buy", 70_900), listed)).toBe("→ 70,900원");
  expect(dragGhostText(cell("buy", 70_900), total)).toBe("");
  expect(dragGhostText({ kind: "ladder" }, chip())).toBe("");
  expect(dragGhostText({ kind: "origin" }, listed)).toBe("");
});

test("고스트 수량은 끄는 대상의 잔량이다", () => {
  expect(dragQuantity(chip())).toBe(12);
  expect(dragQuantity(listed)).toBe(7);
  expect(dragQuantity(total)).toBe(15);
  expect(dragSide(listed)).toBe("buy");
  expect(dragSide(total)).toBe("buy");
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
  expect(capacityProblem("sell", 71_000, 11, capacity)).toBe("매도 가능 수량(10)을 넘습니다");
  expect(capacityProblem("sell", 71_000, 10, capacity)).toBeNull();
  expect(capacityProblem("buy", 71_000, 15, capacity)).toContain("매수 가능 금액");
  expect(capacityProblem("buy", 71_000, 14, capacity)).toBeNull();
  expect(capacityProblem("buy", 71_000, 0, capacity)).toBe("수량을 입력하세요");
  expect(capacityProblem("buy", 71_000, 1_000, { sellableQuantity: null, buyableAmount: null })).toBeNull();
});
