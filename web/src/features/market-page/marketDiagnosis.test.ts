import { describe, expect, it } from "vitest";
import type { MarketOverviewIndex } from "../../api/generated/MarketOverviewIndex";
import { diagnoseMarket } from "./marketDiagnosis";

const makeIndex = (patch: Partial<MarketOverviewIndex> & { code: string; name: string }): MarketOverviewIndex => ({
  level: 2650,
  changeRate: 0.5,
  tradeValueEok: 80_000,
  breadth: { rising: 500, flat: 50, falling: 350, upperLimit: 3, lowerLimit: 1 },
  volatility: null,
  ...patch,
});

const kospi = (patch: Partial<MarketOverviewIndex> = {}) =>
  makeIndex({ code: "001", name: "코스피", volatility: { level: 18, changeRate: -1 }, ...patch });

const kosdaq = (patch: Partial<MarketOverviewIndex> = {}) =>
  makeIndex({ code: "101", name: "코스닥", level: 850, ...patch });

describe("diagnoseMarket", () => {
  it("두 지수가 모두 없으면 null을 돌려준다", () => {
    expect(diagnoseMarket(null, null)).toBeNull();
  });

  it("양 시장이 함께 오르면 동반 강세로 분류한다", () => {
    const result = diagnoseMarket(kospi({ changeRate: 1.1 }), kosdaq({ changeRate: 0.8 }))!;
    expect(result.kind).toBe("jointBull");
    expect(result.badge).toBe("동반 강세");
    expect(result.tone).toBe("up");
    expect(result.summary).toContain("+1.10%");
    expect(result.summary).toContain("+0.80%");
    expect(result.axes).toHaveLength(5);
  });

  it("양 시장이 함께 내리면 동반 약세로 분류한다", () => {
    const result = diagnoseMarket(kospi({ changeRate: -0.9 }), kosdaq({ changeRate: -1.4 }))!;
    expect(result.kind).toBe("jointBear");
    expect(result.badge).toBe("동반 약세");
    expect(result.tone).toBe("down");
  });

  it("코스피만 크게 오르면 디커플링 코스피 쏠림으로 분류한다", () => {
    const result = diagnoseMarket(kospi({ changeRate: 0.85 }), kosdaq({ changeRate: -0.3 }))!;
    expect(result.kind).toBe("kospiLead");
    expect(result.badge).toBe("디커플링 · 코스피 쏠림");
  });

  it("코스닥만 크게 오르면 디커플링 코스닥 쏠림으로 분류한다", () => {
    const result = diagnoseMarket(kospi({ changeRate: -0.1 }), kosdaq({ changeRate: 1.2 }))!;
    expect(result.kind).toBe("kosdaqLead");
    expect(result.badge).toBe("디커플링 · 코스닥 쏠림");
  });

  it("변동폭이 작으면 보합 탐색으로 분류하고 5축 점수를 5~98 사이로 맞춘다", () => {
    const result = diagnoseMarket(
      kospi({ changeRate: 0.05, breadth: { rising: null, flat: null, falling: null, upperLimit: null, lowerLimit: null }, volatility: null }),
      kosdaq({ changeRate: -0.05, breadth: { rising: null, flat: null, falling: null, upperLimit: null, lowerLimit: null } }),
    )!;
    expect(result.kind).toBe("mixed");
    expect(result.badge).toBe("보합 탐색");
    expect(result.tone).toBe("flat");
    for (const axis of result.axes) {
      expect(axis.score).toBeGreaterThanOrEqual(5);
      expect(axis.score).toBeLessThanOrEqual(98);
    }
  });
});
