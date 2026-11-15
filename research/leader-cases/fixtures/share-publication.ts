import type { Bundle, FinancialPeriod, Measure } from "../bundle-types.ts";
import { financialData } from "../financial-calculations.ts";
import { day } from "../source-utils.ts";
import { dartPatternFixture } from "./dart-patterns.ts";
import { calendar } from "./sources.ts";

export async function sharePublicationBundles(base: Bundle) {
  const { dart } = await dartPatternFixture({ revisedAccounts: true, currentShares: true });
  const current = dart.financials.quarters.find((p) => p.year === 2021 && p.quarter === 4)!;
  const bundle = (commonShares: Measure, outstandingCommonShares: Measure): Bundle => {
    const replace = (p: FinancialPeriod) => p.year === 2021 && p.quarter === 4 ? { ...p, commonShares, outstandingCommonShares } : p;
    return { ...base, range: { ...base.range, to: day("2022-03-31") }, calendar: [...base.calendar, ...calendar("2021-03-19", "2022-03-31")], dart: { ...dart, financials: financialData(dart.financials.quarters.map(replace), dart.financials.annual.map(replace)) } };
  };
  return {
    independent: bundle(current.commonShares, current.outstandingCommonShares),
    separateDates: bundle(current.commonShares, { ...current.outstandingCommonShares, availableFrom: day("2022-03-23") }),
    explicitNull: bundle({ ...current.commonShares, value: null, reason: "invalid_share_count" }, { ...current.outstandingCommonShares, value: null, reason: "common_share_snapshot_missing_or_ambiguous", availableFrom: day("2022-03-23") }),
    missingAvailability: bundle({ ...current.commonShares, availableFrom: null }, { ...current.outstandingCommonShares, availableFrom: null }),
    sourceDates: bundle({ ...current.commonShares, availableFrom: day("2022-03-23"), sources: current.commonShares.sources.map((s) => ({ ...s, filedOn: day("2022-03-23") })) }, { ...current.outstandingCommonShares, sources: current.outstandingCommonShares.sources.map((s) => ({ ...s, filedOn: day("2022-03-22") })) }),
  };
}
