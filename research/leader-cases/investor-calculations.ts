import type { DayHistory } from "../../web/src/api/generated/DayHistory.ts";
import type { InvestorNetSharesDay } from "../../web/src/api/generated/InvestorNetSharesDay.ts";
import { INSTITUTIONS, type CumulativeFlow, type Day, type Institution, type SourceResult } from "./bundle-types.ts";

function zero(): Record<Institution, number> {
  return { institution: 0, financialInvestment: 0, insurance: 0, investmentTrust: 0, otherFinancial: 0, bank: 0, pensionFund: 0, privateFund: 0, government: 0 };
}
export function accumulateInstitutions(result: SourceResult<DayHistory<InvestorNetSharesDay>>, calendar: Day[]): CumulativeFlow[] {
  if (result.kind === "missing") return calendar.map((date) => ({ day: date, segmentStart: null, completeSinceObservationStart: false, knownNetSinceStart: null, segmentNet: null, reason: result.reason }));
  const history = result.data;
  const days = new Map(history.days.map((d) => [d.day, d]));
  const skipped = new Set(history.skippedDays.map((d) => d.day));
  let segmentStart: Day | null = null;
  let segmentNet = zero();
  const knownNet = zero();
  let hasObserved = false;
  let broken = false;
  const undated = history.undatedRows.length > 0;
  return calendar.map((date) => {
    const row = days.get(date);
    const reason = history.coverage.kind === "no_readable_dates" ? "no_readable_dates" : skipped.has(date) ? "skipped_numeric_row" : !row ? "observation_missing" : null;
    if (reason !== null) {
      if (hasObserved) broken = true;
      segmentStart = null;
      segmentNet = zero();
      return { day: date, segmentStart, completeSinceObservationStart: false, knownNetSinceStart: null, segmentNet: null, reason };
    }
    segmentStart ??= date;
    hasObserved = true;
    for (const key of INSTITUTIONS) { segmentNet[key] += row![key]; knownNet[key] += row![key]; }
    return { day: date, segmentStart, completeSinceObservationStart: !broken && !undated, knownNetSinceStart: { ...knownNet }, segmentNet: { ...segmentNet }, reason: undated ? "undated_rows_prevent_gap_localization" : broken ? "partial_sum_excludes_missing_observations" : "net_change_since_first_observed_day_not_holdings" };
  });
}
