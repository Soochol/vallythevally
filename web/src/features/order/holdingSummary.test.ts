import { describe, expect, it } from "vitest";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import { averageRowPrice, costTitle, formatFillTime, holdingOf, isEtfOrEtnAfterHours, profitText, remainingToSell, sellableFill, sellOrderQuantity, sellQuantityAtPrice, toggledUnit } from "./holdingSummary";
import { groupOpenOrders, groupWithPending } from "./orderRules";
import type { PendingWrite } from "./pendingWrites";

const HOLDING: TradingHolding = { code: "005930", name: "삼성전자", quantity: 120, sellableQuantity: 100, averagePrice: 70_050, currentPrice: 70_000, evaluationProfit: -6_000, profitRateCenti: -71 };

describe("평가손익", () => {
  it("원과 % 사이를 전환한다", () => {
    expect(profitText(HOLDING, "won")).toBe("−6,000원");
    expect(profitText(HOLDING, "percent")).toBe("−0.71%");
    expect(toggledUnit("won")).toBe("percent");
    expect(toggledUnit("percent")).toBe("won");
  });

  it("보유가 없거나 수익률이 없으면 줄표다", () => {
    expect(profitText(null, "won")).toBe("-");
    expect(profitText({ ...HOLDING, profitRateCenti: null }, "percent")).toBe("-");
  });

  it("이익은 + 부호가 붙는다", () => {
    expect(profitText({ ...HOLDING, evaluationProfit: 3_000, profitRateCenti: 150 }, "won")).toBe("+3,000원");
    expect(profitText({ ...HOLDING, profitRateCenti: 150 }, "percent")).toBe("+1.50%");
  });
});

describe("매입수량 툴팁", () => {
  it("평단가 × 매입수량을 매입총금액으로 보인다", () => {
    expect(costTitle({ ...HOLDING, averagePrice: 70_040 })).toBe("매입총금액 8,404,800원");
  });

  it("보유가 없으면 툴팁이 없다", () => {
    expect(costTitle(null)).toBeUndefined();
  });
});

describe("매입수량 누르기", () => {
  it("매도 주문이 없으면 매도 가능 수량을 채운다", () => {
    expect(sellableFill(HOLDING, 0)).toBe("100");
  });

  it("매입수량에서 매도 주문 잔량을 뺀 만큼을 채운다", () => {
    expect(sellableFill({ ...HOLDING, quantity: 120, sellableQuantity: 120 }, 50)).toBe("70");
    expect(remainingToSell({ ...HOLDING, quantity: 120, sellableQuantity: 120 }, 50)).toBe(70);
  });

  it("매도 가능 수량이 더 작으면 그 값을 채운다", () => {
    expect(sellableFill({ ...HOLDING, quantity: 120, sellableQuantity: 60 }, 50)).toBe("60");
  });

  it("남은 수량이 0 이하이거나 매도 가능 수량이 없으면 채우지 않는다", () => {
    expect(sellableFill(HOLDING, 120)).toBeNull();
    expect(sellableFill(HOLDING, 150)).toBeNull();
    expect(sellableFill({ ...HOLDING, sellableQuantity: 0 }, 0)).toBeNull();
    expect(sellableFill(null, 0)).toBeNull();
  });

  it("매도 주문 잔량은 접수된 매도 주문의 합이고 매수는 세지 않는다", () => {
    const order = (orderNo: string, side: "buy" | "sell", price: number, openQuantity: number) => ({ orderNo, code: "005930", name: "삼성전자", side, quantity: openQuantity, price, openQuantity, status: "접수", orderedAt: "100000", originalOrderNo: null, venue: "krx" as const });
    const groups = groupOpenOrders([order("1", "sell", 71_000, 30), order("2", "sell", 72_000, 20), order("3", "buy", 69_000, 40)], "005930");
    expect(sellOrderQuantity(groups, [], "005930")).toBe(50);
    expect(sellOrderQuantity(new Map(), [], "005930")).toBe(0);
  });

  const sellOrder = (orderNo: string, quantity: number, price = 71_000) => ({ orderNo, code: "005930", name: "삼성전자", side: "sell" as const, quantity, price, openQuantity: quantity, status: "접수", orderedAt: "100000", originalOrderNo: null, venue: "krx" as const });
  const sending = (key: string, price: number, quantity: number, listedWhenIn: number, code = "005930", side: "buy" | "sell" = "sell"): PendingWrite => ({ kind: "sending", code, since: 10, key, side, price, quantity, listedWhenIn });
  const ordered = (orders: ReturnType<typeof sellOrder>[], writes: PendingWrite[]) => sellOrderQuantity(groupWithPending(orders, writes, "005930"), writes, "005930");

  it("접수된 매도와 같은 가격으로 보내는 중인 매도도 더하고 다른 종목·매수 쓰기는 세지 않는다", () => {
    const writes = [sending("a", 71_000, 30, 80), sending("b", 71_000, 5, 85), sending("c", 71_000, 99, 149, "000660"), sending("d", 71_000, 7, 0, "005930", "buy")];
    expect(ordered([sellOrder("1", 50)], writes)).toBe(85);
  });

  it("보내는 중 매도가 목록에 아직 없으면 목록을 다시 읽어도 남은 수량에서 빠지지 않는다", () => {
    const writes = [sending("a", 71_000, 30, 80)];
    const sellOrdered = ordered([sellOrder("1", 50)], writes);
    expect(sellOrdered).toBe(80);
    expect(remainingToSell({ ...HOLDING, quantity: 120, sellableQuantity: 120 }, sellOrdered)).toBe(40);
  });

  it("다시 읽은 목록에 보내는 중 매도가 이미 들어 있으면 두 번 세지 않는다", () => {
    const writes = [sending("a", 71_000, 30, 80)];
    const sellOrdered = ordered([sellOrder("1", 50), sellOrder("2", 30)], writes);
    expect(sellOrdered).toBe(80);
    expect(remainingToSell({ ...HOLDING, quantity: 120, sellableQuantity: 120 }, sellOrdered)).toBe(40);
  });

  it("보내던 매도가 거절·실패로 끝나면 남은 수량이 돌아온다", () => {
    const sellOrdered = ordered([sellOrder("1", 50)], []);
    expect(remainingToSell({ ...HOLDING, quantity: 120, sellableQuantity: 120 }, sellOrdered)).toBe(70);
  });

  it("같은 가격에 보내는 중 매도가 둘이면 목록에 든 만큼만 덜고 나머지를 더한다", () => {
    const writes = [sending("a", 71_000, 30, 80), sending("b", 71_000, 20, 100)];
    expect(ordered([sellOrder("1", 50)], writes)).toBe(100);
    expect(ordered([sellOrder("1", 50), sellOrder("2", 30)], writes)).toBe(100);
    expect(ordered([sellOrder("1", 50), sellOrder("2", 30), sellOrder("3", 20)], writes)).toBe(100);
  });

  it("새 보내는 중 매도의 목록 기준은 이미 보내는 중인 매도를 포함한다", () => {
    const writes = [sending("a", 71_000, 30, 80)];
    const groups = groupWithPending([sellOrder("1", 50)], writes, "005930");
    expect(sellQuantityAtPrice(groups, writes, "005930", 71_000)).toBe(80);
    expect(sellQuantityAtPrice(groups, writes, "005930", 72_000)).toBe(0);
    const listed = groupWithPending([sellOrder("1", 50), sellOrder("2", 30)], writes, "005930");
    expect(sellQuantityAtPrice(listed, writes, "005930", 71_000)).toBe(80);
  });

  it("접수된 묶음이 없는 가격의 보내는 중 매도는 묶음이 이미 더해 두 번 세지 않는다", () => {
    const writes = [sending("a", 72_000, 30, 30), sending("b", 72_000, 5, 35)];
    expect(ordered([], writes)).toBe(35);
    expect(sellQuantityAtPrice(groupWithPending([], writes, "005930"), writes, "005930", 72_000)).toBe(35);
  });

  it("현재 종목의 보유만 고른다", () => {
    expect(holdingOf([HOLDING], "000660")).toBeNull();
    expect(holdingOf([HOLDING], "005930")).toBe(HOLDING);
    expect(holdingOf([{ ...HOLDING, quantity: 0 }], "005930")).toBeNull();
  });
});

describe("평단가 점", () => {
  it("가장 가까운 행에 찍고 범위 밖이면 찍지 않는다", () => {
    expect(averageRowPrice([70_200, 70_100, 70_000, null], 70_040)).toBe(70_000);
    expect(averageRowPrice([70_200, 70_100, 70_000], 80_000)).toBeNull();
    expect(averageRowPrice([70_100], null)).toBeNull();
  });
});

describe("ETF·ETN 장 시간", () => {
  const kst = (iso: string) => Math.floor(Date.parse(`${iso}+09:00`) / 1000);
  const COMMON = { kind: "common", nxtEnabled: false } as const;
  const ETF = { kind: "etf", nxtEnabled: false } as const;
  it("보통주는 수요일 19:50에도 해당하지 않는다", () => {
    expect(isEtfOrEtnAfterHours(kst("2026-11-18T19:50:00"), COMMON)).toBe(false);
  });
  it("수요일 16:30 NXT 미거래 ETF는 해당하고 15:29와 20:00에는 해당하지 않는다", () => {
    expect(isEtfOrEtnAfterHours(kst("2026-11-18T16:30:00"), ETF)).toBe(true);
    expect(isEtfOrEtnAfterHours(kst("2026-11-18T15:29:00"), ETF)).toBe(false);
    expect(isEtfOrEtnAfterHours(kst("2026-11-18T20:00:00"), ETF)).toBe(false);
  });
  it("NXT 거래 ETF는 해당하지 않는다", () => {
    expect(isEtfOrEtnAfterHours(kst("2026-11-18T16:30:00"), { kind: "etf", nxtEnabled: true })).toBe(false);
  });
  it("종목 정보가 없으면 해당하지 않는다", () => {
    expect(isEtfOrEtnAfterHours(kst("2026-11-18T16:30:00"), null)).toBe(false);
  });
  it("NXT 미거래 ETN은 수요일 16:30에 해당하고 15:29와 20:00에는 해당하지 않는다", () => {
    const etn = { kind: "etn", nxtEnabled: false } as const;
    expect(isEtfOrEtnAfterHours(kst("2026-11-18T16:30:00"), etn)).toBe(true);
    expect(isEtfOrEtnAfterHours(kst("2026-11-18T15:29:00"), etn)).toBe(false);
    expect(isEtfOrEtnAfterHours(kst("2026-11-18T20:00:00"), etn)).toBe(false);
  });
  it("NXT 거래 ETN과 인프라투자금융·뮤추얼펀드는 16:30에 해당하지 않는다", () => {
    expect(isEtfOrEtnAfterHours(kst("2026-11-18T16:30:00"), { kind: "etn", nxtEnabled: true })).toBe(false);
    expect(isEtfOrEtnAfterHours(kst("2026-11-18T16:30:00"), { kind: "infrastructure", nxtEnabled: false })).toBe(false);
    expect(isEtfOrEtnAfterHours(kst("2026-11-18T16:30:00"), { kind: "mutualFund", nxtEnabled: false })).toBe(false);
  });
});

describe("체결 시각", () => {
  it("여섯 자리를 시:분:초로 쓴다", () => {
    expect(formatFillTime("093015")).toBe("09:30:15");
    expect(formatFillTime("09:30")).toBe("09:30");
  });
});
