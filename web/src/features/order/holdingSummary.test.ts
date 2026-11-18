import { describe, expect, it } from "vitest";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import { averageRowPrice, formatFillTime, holdingOf, ladderClosed, profitText, sellableFill, toggledUnit } from "./holdingSummary";

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

describe("매입수량 누르기", () => {
  it("매도 가능 수량을 주 단위로 채운다", () => {
    expect(sellableFill(HOLDING)).toEqual({ mode: "shares", input: "100" });
  });

  it("매도 가능 수량이 없으면 채우지 않는다", () => {
    expect(sellableFill({ ...HOLDING, sellableQuantity: 0 })).toBeNull();
    expect(sellableFill(null)).toBeNull();
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

describe("시간외 빈 상태", () => {
  const AT_1531 = 15 * 3600 + 31 * 60;
  it("시간외를 고르면 닫힌다", () => {
    expect(ladderClosed("after", 10 * 3600, true)).toBe(true);
  });
  it("KRX 전용 종목은 15:30 뒤 닫힌다", () => {
    expect(ladderClosed("regular", AT_1531, false)).toBe(true);
    expect(ladderClosed("regular", AT_1531 - 120, false)).toBe(false);
    expect(ladderClosed("regular", AT_1531, true)).toBe(false);
    expect(ladderClosed("regular", AT_1531, null)).toBe(false);
  });
});

describe("체결 시각", () => {
  it("여섯 자리를 시:분:초로 쓴다", () => {
    expect(formatFillTime("093015")).toBe("09:30:15");
    expect(formatFillTime("09:30")).toBe("09:30");
  });
});
