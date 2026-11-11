import { BALANCE_KEYS, FLOW_KEYS, type AccountKey, type Accounts, type Day, type FinancialData, type FinancialMetrics, type FinancialPeriod, type Measure, type Quarter, type Unit, type ValuationDay } from "./bundle-types.ts";
import { day } from "./source-utils.ts";

export function absent(reason: string, unit: Unit = "KRW"): Measure {
  return { value: null, reason, unit, sources: [], availableFrom: null };
}
export function calculate(inputs: Measure[], unit: Unit, formula: (values: number[]) => number | null, missingReason = "missing_input"): Measure {
  const sources = inputs.flatMap((x) => x.sources);
  const dates = inputs.map((x) => x.availableFrom);
  const availableFrom = dates.every((x) => x !== null) ? dates.reduce<Day | null>((latest, d) => d !== null && (latest === null || d > latest) ? d : latest, null) : null;
  if (inputs.some((x) => x.value === null)) return { value: null, reason: missingReason, unit, sources, availableFrom };
  const value = formula(inputs.map((x) => x.value ?? 0));
  return value === null || !Number.isFinite(value) ? { value: null, reason: "invalid_denominator_or_basis", unit, sources, availableFrom } : { value, reason: null, unit, sources, availableFrom };
}
export function emptyAccounts(reason: string): Accounts {
  return { revenue: absent(reason), operatingProfit: absent(reason), parentNetIncome: absent(reason), operatingCashFlow: absent(reason), investingCashFlow: absent(reason), capex: absent(reason), parentEquity: absent(reason), equity: absent(reason), liabilities: absent(reason), inventory: absent(reason), receivables: absent(reason) };
}
export function periodEnd(year: number, quarter: Quarter): Day {
  const month = quarter * 3;
  return day(new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10));
}
export function completeQuarters(reports: FinancialPeriod[]): FinancialPeriod[] {
  return reports.map((p) => {
    const single = { ...p.single };
    const prior = reports.find((r) => r.year === p.year && r.quarter === p.quarter - 1);
    for (const key of FLOW_KEYS) {
      if (p.quarter === 4 || (p.quarter > 1 && (key === "operatingCashFlow" || key === "investingCashFlow" || key === "capex"))) {
        single[key] = prior ? calculate([p.cumulative[key], prior.cumulative[key]], "KRW", ([a, b]) => a! - b!, "previous_cumulative_unavailable") : absent("previous_cumulative_unavailable");
      }
    }
    if (single.capex.value !== null && single.capex.value < 0) single.capex = { ...single.capex, value: null, reason: "negative_differenced_capex_requires_verification" };
    for (const key of BALANCE_KEYS) single[key] = p.cumulative[key];
    return { ...p, single, reportedEps: p.quarter === 4 ? absent("annual_eps_minus_ytd_eps_not_valid_with_weighted_shares", "KRW/share") : p.reportedEps };
  });
}
function ordinal(p: Pick<FinancialPeriod, "year" | "quarter">): number { return p.year * 4 + p.quarter; }
function sumTtm(period: FinancialPeriod, quarters: FinancialPeriod[], key: AccountKey): Measure {
  const window = quarters.filter((p) => ordinal(p) <= ordinal(period) && ordinal(p) > ordinal(period) - 4);
  if (window.length !== 4) return absent("need_four_consecutive_quarters");
  return calculate(window.map((p) => p.single[key]), "KRW", (v) => v.reduce((a, b) => a + b, 0), "ttm_quarter_missing");
}
function yoy(now: Measure, prior: Measure | undefined): Measure {
  if (!prior) return absent("prior_year_period_missing", "percent");
  return calculate([now, prior], "percent", ([a, b]) => b! > 0 ? (a! / b! - 1) * 100 : null, "yoy_input_missing");
}
function perShare(income: Measure, periods: FinancialPeriod[]): Measure {
  if (periods.length === 0) return absent("historical_common_share_basis_unavailable", "KRW/share");
  const shares = periods.map((p) => p.outstandingCommonShares);
  return calculate([income, ...shares, ...periods.map((p) => p.otherShares)], "KRW/share", ([profit, ...v]) => {
    const common = v.slice(0, periods.length), other = v.slice(periods.length);
    return common[0]! > 0 && common.every((x) => x === common[0]) && other.every((x) => x === 0) ? profit! / common[0]! : null;
  }, "historical_common_share_basis_unavailable");
}
export function financialMetrics(period: FinancialPeriod, quarters: FinancialPeriod[], periodSet = quarters, frequency: "quarterly" | "annual" = "quarterly"): FinancialMetrics {
  const priorYear = periodSet.find((p) => p.year === period.year - 1 && p.quarter === period.quarter);
  const priorQuarter = frequency === "annual" ? priorYear : quarters.find((p) => ordinal(p) === ordinal(period) - 1);
  const priorQuarterYear = frequency === "annual" ? periodSet.find((p) => p.year === period.year - 2) : quarters.find((p) => ordinal(p) === ordinal(period) - 5);
  const revenueYoy = yoy(period.single.revenue, priorYear?.single.revenue);
  const opYoy = yoy(period.single.operatingProfit, priorYear?.single.operatingProfit);
  const priorOpYoy = priorQuarter ? yoy(priorQuarter.single.operatingProfit, priorQuarterYear?.single.operatingProfit) : absent("prior_quarter_missing", "percent");
  const niTtm = sumTtm(period, quarters, "parentNetIncome");
  const window = quarters.filter((p) => ordinal(p) <= ordinal(period) && ordinal(p) > ordinal(period) - 4);
  const eps = window.length !== 4 ? absent("need_four_consecutive_quarters", "KRW/share") : perShare(niTtm, window);
  const bps = calculate([period.single.parentEquity, period.outstandingCommonShares, period.otherShares], "KRW/share", ([equity, common, other]) => common! > 0 && other === 0 ? equity! / common! : null, "historical_common_share_basis_unavailable");
  const roe = priorYear ? calculate([niTtm, period.single.parentEquity, priorYear.single.parentEquity], "percent", ([income, end, start]) => end! > 0 && start! > 0 ? income! / ((end! + start!) / 2) * 100 : null) : absent("prior_year_equity_missing", "percent");
  const operatingCashFlowTtm = sumTtm(period, quarters, "operatingCashFlow");
  const investingCashFlowTtm = sumTtm(period, quarters, "investingCashFlow");
  const capexTtm = sumTtm(period, quarters, "capex");
  const periodEps = period.reportedEps.value !== null ? period.reportedEps : perShare(period.single.parentNetIncome, window);
  return {
    periodEps,
    operatingMarginPct: calculate([period.single.operatingProfit, period.single.revenue], "percent", ([op, revenue]) => revenue! > 0 ? op! / revenue! * 100 : null),
    revenueYoyPct: revenueYoy,
    operatingProfitYoyPct: opYoy,
    operatingProfitAccelerationPp: calculate([opYoy, priorOpYoy], "percent", ([a, b]) => a! - b!),
    parentNetIncomeTtm: niTtm,
    operatingProfitTtm: sumTtm(period, quarters, "operatingProfit"),
    revenueTtm: sumTtm(period, quarters, "revenue"),
    operatingCashFlowTtm, investingCashFlowTtm, capexTtm,
    freeCashFlowTtm: calculate([operatingCashFlowTtm, capexTtm], "KRW", ([cf, capex]) => cf! - capex!),
    epsTtm: eps,
    bps,
    parentRoePct: roe,
    debtRatioPct: calculate([period.single.liabilities, period.single.equity], "percent", ([liabilities, equity]) => equity! > 0 ? liabilities! / equity! * 100 : null),
    freeCashFlow: calculate([period.single.operatingCashFlow, period.single.capex], "KRW", ([cf, capex]) => cf! - capex!),
    inventoryWarningPp: calculate([yoy(period.single.inventory, priorYear?.single.inventory), revenueYoy], "percent", ([a, b]) => a! - b!),
    receivablesWarningPp: calculate([yoy(period.single.receivables, priorYear?.single.receivables), revenueYoy], "percent", ([a, b]) => a! - b!),
  };
}
export function financialData(reports: FinancialPeriod[], annual: FinancialPeriod[]): FinancialData {
  const quarters = completeQuarters(reports).sort((a, b) => ordinal(a) - ordinal(b));
  return { quarters, annual, metrics: quarters.map((p) => ({ year: p.year, quarter: p.quarter, values: financialMetrics(p, quarters) })), annualMetrics: annual.map((p) => ({ year: p.year, values: financialMetrics(p, quarters, annual, "annual") })), limitations: [
    "Latest OpenDART snapshots only; corrected values are withheld until their own matching receipt date, and original vintages are not reconstructed.",
    "December fiscal year only; report titles must identify the expected period. Non-December fiscal years are unavailable.",
    "EPS TTM = controlling net income TTM / common shares excluding treasury only when all four reported quarter-end denominators match and other share classes are zero; intraperiod changes and preferred allocation require manual verification.",
    "BPS is the latest controlling equity balance / reported outstanding common shares; balances are never summed across four quarters.",
    "Quarter-end share snapshots are not effective-dated listed share history; no daily historical market capitalization is inferred.",
  ] };
}
function knownAt(value: Measure, date: Day): Measure {
  return value.value !== null && value.availableFrom !== null && value.availableFrom <= date ? value : { ...value, value: null, reason: value.reason ?? "not_yet_available" };
}
export function valuations(daily: Array<{ day: Day; c: number }>, data: FinancialData, currentListedShares: number | null = null): ValuationDay[] {
  return daily.map((b) => {
    const eligible = data.quarters.filter((p) => p.availableFrom !== null && p.availableFrom <= b.day);
    const latest = eligible.at(-1);
    let eps = latest ? knownAt(financialMetrics(latest, data.quarters).epsTtm, b.day) : absent("no_published_financial_period", "KRW/share");
    let bps = latest ? knownAt(financialMetrics(latest, data.quarters).bps, b.day) : absent("no_published_financial_period", "KRW/share");
    const shareSnapshots = data.quarters.filter((p) => p.outstandingCommonShares.value !== null);
    if (latest && (currentListedShares === null || latest.commonShares.value !== currentListedShares || shareSnapshots.some((p) => p.periodEnd > latest.periodEnd && p.outstandingCommonShares.value !== latest.outstandingCommonShares.value))) {
      eps = absent("adjusted_price_and_historical_eps_share_basis_not_reconciled", "KRW/share");
      bps = absent("adjusted_price_and_historical_bps_share_basis_not_reconciled", "KRW/share");
    }
    const per = calculate([eps], "multiple", ([v]) => v! > 0 ? b.c / v! : null);
    const pbr = calculate([bps], "multiple", ([v]) => v! > 0 ? b.c / v! : null);
    return { day: b.day, financialPeriod: latest ? `${latest.year}-Q${latest.quarter}` : null, epsTtm: eps, bps, per, pbr,
      perBands: [10, 20, 40, 80].map((multiple) => ({ multiple, price: calculate([eps], "KRW/share", ([v]) => v! > 0 ? v! * multiple : null) })),
      pbrBands: [1, 2, 4, 8].map((multiple) => ({ multiple, price: calculate([bps], "KRW/share", ([v]) => v! > 0 ? v! * multiple : null) })),
    };
  });
}
