import { expect, test } from "vitest";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import type { PendingWrite } from "./pendingWrites";
import { capacityProblem, type DragSource, type DragTarget, dragGhostText, dragQuantity, dragSide, groupOpenOrders, groupWithPending, HIGH_VALUE_WON, judgeDrag, needsHighValueConfirm, type PriceGroup, quantityOf, sideTotal } from "./orderRules";

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

const stamped = { code: "005930", since: 0 } as const;

test("접수한 신규 주문은 재조회에 없어도 칩에 더하고 재조회에 나타나면 재조회 값을 쓴다", () => {
  const placed = order("0000099", "buy", 70_000, 10);
  const writes: PendingWrite[] = [{ ...stamped, kind: "placed", order: placed }];
  const shown = groupWithPending([], writes, "005930").get("buy:70000");
  expect(shown?.quantity).toBe(10);
  expect(shown?.pending).toBeUndefined();
  const listed = order("0000099", "buy", 70_000, 4);
  const groups = groupWithPending([listed], writes, "005930");
  expect(groups.get("buy:70000")?.quantity).toBe(4);
  expect(groups.get("buy:70000")?.orders).toEqual([listed]);
});

test("접수한 취소의 주문은 재조회가 아직 돌려줘도 빼고 남은 수량이 0이면 칩을 지운다", () => {
  const gone = (orderNo: string): PendingWrite => ({ ...stamped, kind: "gone", orderNo });
  const orders = [order("0000001", "buy", 70_000, 5), order("0000002", "buy", 70_000, 7)];
  expect(groupWithPending(orders, [gone("0000001")], "005930").get("buy:70000")?.quantity).toBe(7);
  expect(groupWithPending(orders, [gone("0000001"), gone("0000002")], "005930").size).toBe(0);
});

test("보내는 중 표시는 빈 칸에 방향·수량의 칩을 그리고 합계에는 넣지 않는다", () => {
  const writes: PendingWrite[] = [{ ...stamped, kind: "sending", key: "k", side: "sell", price: 70_100, quantity: 3 }];
  const groups = groupWithPending([], writes, "005930");
  expect(groups.get("sell:70100")).toEqual({ side: "sell", price: 70_100, quantity: 3, orders: [], pending: "sending" });
  expect(sideTotal(groups, "sell")).toEqual({ quantity: 0, count: 0 });
});

test("취소 중·정정 중 표시는 대상 주문의 칩에 붙고 가격 단위 표시는 그 가격 칩 전체에 붙는다", () => {
  const orders = [order("0000001", "buy", 70_000, 5), order("0000002", "buy", 69_900, 7), order("0000003", "sell", 70_100, 2)];
  const writes: PendingWrite[] = [
    { ...stamped, kind: "canceling", key: "a", orderNo: "0000001" },
    { ...stamped, kind: "modifying", key: "b", orderNo: "0000002" },
    { ...stamped, kind: "canceling-price", key: "c", side: "sell", price: 70_100 },
  ];
  const groups = groupWithPending(orders, writes, "005930");
  expect(groups.get("buy:70000")?.pending).toBe("canceling");
  expect(groups.get("buy:69900")?.pending).toBe("modifying");
  expect(groups.get("sell:70100")?.pending).toBe("canceling");
});

test("다른 종목의 표시는 무시한다", () => {
  const writes: PendingWrite[] = [
    { code: "000660", since: 0, kind: "sending", key: "k", side: "buy", price: 70_000, quantity: 10 },
    { code: "000660", since: 0, kind: "gone", orderNo: "0000001" },
    { code: "000660", since: 0, kind: "placed", order: { ...order("0000099", "buy", 70_000, 10), code: "000660" } },
  ];
  const groups = groupWithPending([order("0000001", "buy", 70_000, 5)], writes, "005930");
  expect([...groups.keys()]).toEqual(["buy:70000"]);
  expect(groups.get("buy:70000")?.quantity).toBe(5);
  expect(groups.get("buy:70000")?.pending).toBeUndefined();
});

test("접수한 신규를 곧바로 취소하면 재조회 전에도 그 칩에서 뺀다", () => {
  const placed = order("0000099", "buy", 70_000, 10);
  const writes: PendingWrite[] = [{ ...stamped, kind: "placed", order: placed }, { ...stamped, kind: "gone", orderNo: "0000099" }];
  expect(groupWithPending([], writes, "005930").size).toBe(0);
});
