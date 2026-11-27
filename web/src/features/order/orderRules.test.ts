import { expect, test } from "vitest";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import type { PendingWrite } from "./pendingWrites";
import { type BuyingPower, buyBlock, buyingPowerOf, buyPreview, buyQuantityForRatio, buyRatioLabel, capacityProblem, dragCancels, type DragSource, marginOf, maxBuyQuantity, modifyBuyProblem, type DragTarget, dragGhostText, dragQuantity, dragSide, groupOpenOrders, groupWithPending, HIGH_VALUE_WON, judgeDrag, needsHighValueConfirm, orderCountOf, orderQuantityForPrice, planCancel, type PriceGroup, quantityForAmount, quantityForRatio, RATIO_PRESETS, sideTotal, typedQuantity } from "./orderRules";

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

test("금액은 가격으로 나눈 몫을 수량으로 쓰고 가격이 없으면 수량을 내지 않는다", () => {
  expect(quantityForAmount(1_000_000, 71_000)).toBe(14);
  expect(quantityForAmount(500, 71_000)).toBe(0);
  expect(quantityForAmount(1_000_000, 0)).toBeNull();
  expect(quantityForAmount(1_000_000, null)).toBeNull();
});

test("비율은 기준 수량의 25·50·75% 내림과 전량을 내고 기준 수량이 없으면 0이다", () => {
  expect(RATIO_PRESETS.map((preset) => preset.label)).toEqual(["25%", "50%", "75%", "전량"]);
  expect(RATIO_PRESETS.map((preset) => quantityForRatio(70, preset.percent))).toEqual([17, 35, 52, 70]);
  expect(RATIO_PRESETS.map((preset) => quantityForRatio(3, preset.percent))).toEqual([0, 1, 2, 3]);
  expect(quantityForRatio(0, 100)).toBe(0);
  expect(quantityForRatio(-5, 50)).toBe(0);
  expect(quantityForRatio(10, 0)).toBe(0);
});

test("주문 수량은 칸의 수 그대로다", () => {
  expect(typedQuantity("14")).toBe(14);
  expect(typedQuantity("12.9")).toBe(12);
  expect(typedQuantity("")).toBe(0);
  expect(typedQuantity("0")).toBe(0);
  expect(typedQuantity("abc")).toBe(0);
});

test("수량이 없거나 매도 가능 수량을 넘는 주문은 보내기 전에 막는다", () => {
  const capacity = { sellableQuantity: 10, buying: null };
  expect(capacityProblem("sell", 11, capacity)).toBe("매도 가능 수량(10)을 넘습니다");
  expect(capacityProblem("sell", 10, capacity)).toBeNull();
  expect(capacityProblem("buy", 1_000_000, capacity)).toBeNull();
  expect(capacityProblem("buy", 0, capacity)).toBe("수량을 입력하세요");
  expect(capacityProblem("sell", 1_000, { sellableQuantity: null, buying: null })).toBeNull();
});

const cashOnly: BuyingPower = { policy: "cash_only", amount: 1_000_000, cashAmount: 1_000_000 };
const allowMargin: BuyingPower = { policy: "allow_margin", amount: 3_000_000, cashAmount: 1_000_000 };

test("매수 비율 수량은 비율 예산을 가격으로 나눠 이중 내림 없이 계산하고 라벨을 제공한다", () => {
  expect(RATIO_PRESETS.map((preset) => buyRatioLabel(preset.percent))).toEqual(["25%", "50%", "75%", "전량"]);
  expect(buyQuantityForRatio(70_000, 10_000_000, 75)).toBe(107);
  expect(buyQuantityForRatio(70_000, 10_000_000, 50)).toBe(71);
  expect(buyQuantityForRatio(70_000, 10_000_000, 25)).toBe(35);
  expect(buyQuantityForRatio(70_000, 10_000_000, 100)).toBe(142);
  expect(buyQuantityForRatio(0, 10_000_000, 50)).toBe(0);
  expect(buyQuantityForRatio(70_000, 0, 50)).toBe(0);
  expect(buyQuantityForRatio(70_000, 10_000_000, 0)).toBe(0);
});

test("매수 비율 활성 상태에서는 클릭한 가격 기준으로 비율 수량을 계산하고 매도나 일반 상태는 입력 수량을 그대로 쓴다", () => {
  const power: BuyingPower = { policy: "cash_only", amount: 10_000_000, cashAmount: 10_000_000 };
  expect(orderQuantityForPrice("buy", 70_000, 15, power, 25)).toBe(35);
  expect(orderQuantityForPrice("buy", 70_000, 15, power, 50)).toBe(71);
  expect(orderQuantityForPrice("buy", 70_000, 15, power, 75)).toBe(107);
  expect(orderQuantityForPrice("buy", 70_000, 15, power, 100)).toBe(142);
  expect(orderQuantityForPrice("buy", 70_100, 15, power, 100)).toBe(142);
  expect(orderQuantityForPrice("buy", 69_000, 15, power, 100)).toBe(144);
  expect(orderQuantityForPrice("buy", 70_100, 15, power, null)).toBe(15);
  expect(orderQuantityForPrice("sell", 70_100, 15, power, 100)).toBe(15);
  expect(orderQuantityForPrice("sell", 70_100, 15, power, 50)).toBe(15);
  expect(orderQuantityForPrice("buy", 70_100, 15, null, 100)).toBe(15);
});

test("막기 정책은 현금을 넘는 매수에 최대 수량을 알려 주고 한도 안이면 통과시킨다", () => {
  expect(buyBlock(71_000, 14, cashOnly)).toBeNull();
  expect(buyBlock(71_000, 15, cashOnly)).toEqual({ text: "현금 주문가능 1,000,000원을 넘습니다 (미수 막음) · 최대 14", maxQuantity: 14 });
  expect(maxBuyQuantity(71_000, 1_000_000)).toBe(14);
});

test("현금이 가격보다 작으면 살 수 있는 수량이 없다", () => {
  const poor: BuyingPower = { policy: "cash_only", amount: 50_000, cashAmount: 50_000 };
  expect(buyBlock(71_000, 1, poor)).toEqual({ text: "현금 주문가능 50,000원을 넘습니다 (미수 막음) · 살 수 있는 수량이 없습니다", maxQuantity: 0 });
  expect(buyBlock(71_000, 1, { policy: "cash_only", amount: 0, cashAmount: 0 })?.maxQuantity).toBe(0);
});

test("허용 정책은 현금을 넘어도 미수 포함 한도 안이면 보내고 그 한도를 넘으면 막는다", () => {
  expect(buyBlock(71_000, 20, allowMargin)).toBeNull();
  expect(buyPreview(71_000, 20, allowMargin)).toBe("margin");
  expect(marginOf(71_000 * 20, allowMargin)).toBe(420_000);
  expect(buyPreview(71_000, 14, allowMargin)).toBeNull();
  expect(buyBlock(71_000, 43, allowMargin)).toEqual({ text: "미수 포함 주문가능 3,000,000원을 넘습니다 · 최대 42", maxQuantity: 42 });
});

test("미수 포함 한도를 모르면 허용에서도 한도는 현금 값이라 미수가 생기지 않는다", () => {
  const unknownMargin: BuyingPower = { policy: "allow_margin", amount: 1_000_000, cashAmount: 1_000_000 };
  expect(buyPreview(71_000, 14, unknownMargin)).toBeNull();
  expect(buyPreview(71_000, 15, unknownMargin)).toBe("over");
});

test("정책을 모르거나 수량이 없으면 미리보기도 막음도 없다", () => {
  expect(buyPreview(71_000, 1_000, null)).toBeNull();
  expect(buyBlock(71_000, 1_000, null)).toBeNull();
  expect(buyPreview(71_000, 0, cashOnly)).toBeNull();
  expect(marginOf(9_999_999, cashOnly)).toBe(0);
});

test("매수 정정은 가격을 올려 늘어난 금액만 한도로 검사한다", () => {
  expect(modifyBuyProblem(70_000, 71_000, 400, cashOnly)).toBeNull();
  expect(modifyBuyProblem(70_000, 71_000, 1_001, cashOnly)).toBe("정정으로 늘어난 1,001,000원이 현금 주문가능 1,000,000원을 넘습니다 (미수 막음)");
  expect(modifyBuyProblem(71_000, 70_000, 1_000_000, cashOnly)).toBeNull();
  expect(modifyBuyProblem(70_000, 71_000, 1_000_000, null)).toBeNull();
});

test("조회 응답에서 한도를 뽑고 없으면 모른다", () => {
  expect(buyingPowerOf(null)).toBeNull();
  const orderable = { policy: "allow_margin", amount: 3, cashAmount: 1 } as TradingOrderable;
  expect(buyingPowerOf(orderable)).toEqual({ policy: "allow_margin", amount: 3, cashAmount: 1 });
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
  const writes: PendingWrite[] = [{ ...stamped, kind: "sending", key: "k", side: "sell", price: 70_100, quantity: 3, listedWhenIn: 3 }];
  const groups = groupWithPending([], writes, "005930");
  expect(groups.get("sell:70100")).toEqual({ side: "sell", price: 70_100, quantity: 3, orders: [], pending: "sending" });
  expect(sideTotal(groups, "sell")).toEqual({ quantity: 0, count: 0 });
});

test("같은 빈 칸에 보내는 중 표시가 둘이면 칩 수량은 둘의 합이고 이미 걸린 가격의 칩은 그대로다", () => {
  const sending = (key: string, price: number, quantity: number): PendingWrite => ({ ...stamped, kind: "sending", key, side: "buy", price, quantity, listedWhenIn: 0 });
  const writes = [sending("a", 70_000, 10), sending("b", 70_000, 15), sending("c", 69_900, 4)];
  const groups = groupWithPending([order("0000001", "buy", 69_900, 5)], writes, "005930");
  expect(groups.get("buy:70000")).toMatchObject({ quantity: 25, pending: "sending" });
  expect(groups.get("buy:69900")?.quantity).toBe(5);
  expect(groups.get("buy:69900")?.pending).toBeUndefined();
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
    { code: "000660", since: 0, kind: "sending", key: "k", side: "buy", price: 70_000, quantity: 10, listedWhenIn: 0 },
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

test("가격 묶음들의 주문 수를 센다", () => {
  const groups = [{ orders: [1, 2] }, { orders: [3] }];
  expect(orderCountOf(groups)).toBe(3);
  expect(orderCountOf([])).toBe(0);
});

test("사다리 밖에 놓는 끌기만 취소로 본다", () => {
  const source: DragSource = { kind: "order", order: order("0000001", "buy", 70_000, 5) };
  expect(dragCancels({ kind: "outside" }, source)).toBe(true);
  expect(dragCancels({ kind: "ladder" }, source)).toBe(false);
  expect(dragCancels({ kind: "cell", side: "buy", price: 69_900 }, source)).toBe(false);
});

test("여러 건 취소 대상은 지금 그 가격들에 걸린 주문이고 보내는 중 칩만 있는 가격은 빼며 건수를 함께 낸다", () => {
  const sending = (price: number): PendingWrite => ({ ...stamped, kind: "sending", key: `s${price}`, side: "buy", price, quantity: 1, listedWhenIn: 0 });
  const groups = groupWithPending([order("0000001", "buy", 70_000, 5), order("0000002", "buy", 70_000, 7), order("0000003", "buy", 69_900, 3)], [sending(69_800)], "005930");
  const keys = [{ side: "buy", price: 70_000 }, { side: "buy", price: 69_900 }, { side: "buy", price: 69_800 }] as const;
  const plan = planCancel(groups, [sending(69_800)], "005930", keys);
  expect(plan).toMatchObject({ kind: "ready", orderCount: 3 });
  expect(plan.kind === "ready" ? plan.targets.map((group) => group.price) : []).toEqual([70_000, 69_900]);
  expect(planCancel(groups, [], "005930", [{ side: "sell", price: 70_000 }])).toEqual({ kind: "empty" });
});

test("대상 가격에 보내는 중인 주문이 있으면 여러 건 취소를 계획하지 않는다", () => {
  const writes: PendingWrite[] = [{ ...stamped, kind: "sending", key: "s", side: "buy", price: 70_000, quantity: 1, listedWhenIn: 0 }];
  const groups = groupWithPending([order("0000001", "buy", 70_000, 5), order("0000003", "buy", 69_900, 3)], writes, "005930");
  expect(planCancel(groups, writes, "005930", [{ side: "buy", price: 70_000 }, { side: "buy", price: 69_900 }])).toEqual({ kind: "sending" });
  expect(planCancel(groups, writes, "005930", [{ side: "buy", price: 69_900 }])).toMatchObject({ kind: "ready", orderCount: 1 });
  expect(planCancel(groups, writes, "000660", [{ side: "buy", price: 70_000 }])).toMatchObject({ kind: "ready" });
});
