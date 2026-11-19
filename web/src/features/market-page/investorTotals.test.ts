import { describe, expect, it } from "vitest";
import type { MarketOverviewInvestorDay } from "../../api/generated/MarketOverviewInvestorDay";
import { investorTotals } from "./investorTotals";

const day = (individual: number, foreign: number, institution: number) => ({ date: "2026-11-09", individualEok: individual, foreignEok: foreign, institutionEok: institution }) as unknown as MarketOverviewInvestorDay;

describe("investorTotals", () => {
  it("기간의 날마다 순매수를 주체별로 더한다", () => {
    const totals = investorTotals([day(100, -50, -20), day(-30, 10, 5)], [{ date: "2026-11-09", arbitrageEok: 1, nonArbitrageEok: 2, totalEok: 3 }, { date: "2026-11-06", arbitrageEok: 0, nonArbitrageEok: 0, totalEok: -8 }]);
    expect(totals).toEqual({ individual: 70, foreign: -40, institution: -15, program: -5 });
  });
  it("실패한 구역의 주체는 값이 없다", () => {
    expect(investorTotals(null, [])).toEqual({ individual: null, foreign: null, institution: null, program: 0 });
  });
});
