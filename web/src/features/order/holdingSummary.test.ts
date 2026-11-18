import { describe, expect, it } from "vitest";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import { averageRowPrice, formatFillTime, bookNotice, holdingOf, profitText, sellableFill, toggledUnit } from "./holdingSummary";

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

describe("호가 안내", () => {
  const kst = (iso: string) => Math.floor(Date.parse(`${iso}+09:00`) / 1000);
  const COMMON = { kind: "common", nxtEnabled: false } as const;
  const ETF = { kind: "etf", nxtEnabled: false } as const;
  it("수요일 19:50 NXT 미거래 보통주는 안내가 없다", () => {
    expect(bookNotice(kst("2026-11-18T19:50:00"), COMMON)).toBeNull();
  });
  it("수요일 15:00 NXT 미거래 보통주는 안내가 없다", () => {
    expect(bookNotice(kst("2026-11-18T15:00:00"), COMMON)).toBeNull();
  });
  it("수요일 20:00과 07:59 보통주는 장 마감이다", () => {
    expect(bookNotice(kst("2026-11-18T20:00:00"), COMMON)).toBe("market-closed");
    expect(bookNotice(kst("2026-11-18T07:59:00"), COMMON)).toBe("market-closed");
  });
  it("토요일 12:00 NXT 거래 보통주는 장 마감이다", () => {
    expect(bookNotice(kst("2026-11-21T12:00:00"), { kind: "common", nxtEnabled: true })).toBe("market-closed");
  });
  it("수요일 16:30 NXT 미거래 ETF는 ETF 안내이고 15:29에는 없다", () => {
    expect(bookNotice(kst("2026-11-18T16:30:00"), ETF)).toBe("etf-after-hours");
    expect(bookNotice(kst("2026-11-18T15:29:00"), ETF)).toBeNull();
  });
  it("수요일 16:30 종목 정보가 없으면 안내가 없다", () => {
    expect(bookNotice(kst("2026-11-18T16:30:00"), null)).toBeNull();
  });
});

describe("체결 시각", () => {
  it("여섯 자리를 시:분:초로 쓴다", () => {
    expect(formatFillTime("093015")).toBe("09:30:15");
    expect(formatFillTime("09:30")).toBe("09:30");
  });
});
