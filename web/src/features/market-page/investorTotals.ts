import type { MarketOverviewInvestorDay } from "../../api/generated/MarketOverviewInvestorDay";
import type { MarketOverviewProgramDay } from "../../api/generated/MarketOverviewProgramDay";
import type { Subject } from "./cumulativeLines";

export type SubjectTotals = Record<Subject, number | null>;

export function investorTotals(investors: readonly MarketOverviewInvestorDay[] | null, program: readonly MarketOverviewProgramDay[] | null): SubjectTotals {
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return {
    individual: investors === null ? null : sum(investors.map((day) => Number(day.individualEok))),
    foreign: investors === null ? null : sum(investors.map((day) => Number(day.foreignEok))),
    institution: investors === null ? null : sum(investors.map((day) => Number(day.institutionEok))),
    program: program === null ? null : sum(program.map((day) => day.totalEok)),
  };
}
