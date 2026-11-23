import { describe, expect, it } from "vitest";
import type { MarketOverviewBreadth } from "../../api/generated/MarketOverviewBreadth";
import { breadthShares, formatOptionalCount } from "./breadth";

const breadth = (patch: Partial<MarketOverviewBreadth>): MarketOverviewBreadth => ({ rising: 500, flat: 100, falling: 400, upperLimit: 3, lowerLimit: 1, ...patch });
const NONE: MarketOverviewBreadth = { rising: null, flat: null, falling: null, upperLimit: null, lowerLimit: null };

describe("breadth", () => {
  it("없는 종목 수는 '-'로 쓰고 있는 수는 자릿점을 넣는다", () => {
    expect(formatOptionalCount(null)).toBe("-");
    expect(formatOptionalCount(0)).toBe("0");
    expect(formatOptionalCount(1_234)).toBe("1,234");
  });
  it("세 칸이 모두 있으면 합이 100인 비율이다", () => {
    expect(breadthShares(breadth({}))).toEqual({ up: 50, flat: 10, down: 40 });
  });
  it("없는 칸은 막대 비율에서 빠지고 남은 칸이 나눈다", () => {
    expect(breadthShares(breadth({ flat: null }))).toEqual({ up: (500 / 900) * 100, flat: 0, down: (400 / 900) * 100 });
  });
  it("다섯 칸이 모두 없으면 막대가 없다", () => {
    expect(breadthShares(NONE)).toBeNull();
  });
});
