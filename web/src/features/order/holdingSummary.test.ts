import { describe, expect, it } from "vitest";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import { averageRowPrice, costTitle, formatFillTime, holdingOf, isEtfOrEtnAfterHours, profitText, remainingToSell, sellableFill, sellOrderQuantity, toggledUnit } from "./holdingSummary";
import { groupOpenOrders } from "./orderRules";

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
    expect(sellOrderQuantity(groups)).toBe(50);
    expect(sellOrderQuantity(new Map())).toBe(0);
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
