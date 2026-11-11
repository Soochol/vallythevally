import { BALANCE_KEYS, FLOW_KEYS, type Bundle, type FinancialMetrics, type Measure, type SourceResult, type TtmMeasure } from "./bundle-types.ts";
import { array, boolean, choice, code, date, finite, link, literal, nullable, object, ordered, record, string, union, type Parser } from "./input-schema.ts";
import { parseSectorMap } from "./sector-map.ts";
import { decodeDocument, type BundleDocument, type InflatePage } from "./bundle-document.ts";

const reason: Parser<string> = (input) => { const value = string(input); if (!value.trim()) throw new Error("missing_reason"); return value; };
const nullValue = union(object({ value: finite, reason: literal(null) }), object({ value: literal(null), reason }));
const fact = object({ endpoint: string, receipt: string, filedOn: date, url: link, accountId: nullable(string), accountName: string, match: choice(["standard-id", "account-name", "reported"]), field: string });
const measure: Parser<Measure> = (input) => ({ ...nullValue(input), ...object({ unit: choice(["KRW", "KRW/share", "shares", "percent", "multiple"]), sources: array(fact), availableFrom: nullable(date) })(input) });
const pathKind = choice(["annual", "annual-ytd", "four-quarters"]);
const ttm: Parser<TtmMeasure> = (input) => ({ ...measure(input), ...object({ evaluatedOn: nullable(date), paths: array(object({ kind: pathKind, result: measure })), activePaths: array(pathKind) })(input) });
const metrics: Parser<FinancialMetrics> = object({ periodEps: measure, operatingMarginPct: measure, revenueYoyPct: measure, operatingProfitYoyPct: measure, operatingProfitAccelerationPp: measure, parentNetIncomeTtm: ttm, operatingProfitTtm: ttm, revenueTtm: ttm, operatingCashFlowTtm: ttm, investingCashFlowTtm: ttm, capexTtm: ttm, freeCashFlowTtm: measure, epsTtm: measure, bps: measure, parentRoePct: measure, debtRatioPct: measure, freeCashFlow: measure, inventoryWarningPp: measure, receivablesWarningPp: measure });
function source<T>(data: Parser<T>): Parser<SourceResult<T>> {
  return union(object({ kind: literal("ok"), source: string, data }), object({ kind: literal("missing"), source: string, reason: string }));
}
const accounts = object({ revenue: measure, operatingProfit: measure, parentNetIncome: measure, operatingCashFlow: measure, investingCashFlow: measure, capex: measure, parentEquity: measure, equity: measure, liabilities: measure, inventory: measure, receivables: measure });
const period = object({ year: finite, quarter: choice([1, 2, 3, 4]), periodEnd: date, filedOn: nullable(date), availableFrom: nullable(date), filingLagDays: nullable(finite), single: accounts, cumulative: accounts, reportedEps: measure, commonShares: measure, outstandingCommonShares: measure, otherShares: measure, dps: measure });
const disclosure = object({ corpCode: string, stockCode: nullable(string), corpName: nullable(string), receipt: string, filedOn: date, title: string, url: link });
const flow = object({ institution: finite, financialInvestment: finite, insurance: finite, investmentTrust: finite, otherFinancial: finite, bank: finite, pensionFund: finite, privateFund: finite, government: finite });
const coverage = union(union(object({ kind: literal("whole_range") }), object({ kind: literal("no_readable_dates") })), object({ kind: literal("kiwoom_starts_later"), firstDay: date }));
function history<T>(row: Parser<T>) {
  return object({ symbol: string, from: date, to: date, coverage, days: array(row), skippedDays: array(object({ day: date, field: string, reason: string })), undatedRows: array(object({ dt: string, reason: string })) });
}
const n = nullable(finite);
const bar = { o: finite, h: finite, l: finite, c: finite, v: finite };
const bundleShape = {
  schemaVersion: literal(2), generatedAt: string, code, range: object({ from: date, to: date }), calendar: array(date), sectorMap: parseSectorMap,
  symbol: source(object({ code: string, name: string, kind: choice(["index", "common", "preferred", "etf", "reit"]), market: choice(["kospi", "kosdaq"]), nxtEnabled: boolean })),
  currentFundamentals: source(object({ fetchedAt: string, historical: literal(false), values: object({ symbol: string, marketCap: n, listedShares: n, per: n, pbr: n, roe: n, eps: n, bps: n, foreignExhaustionRate: n, high52w: n, low52w: n }) })),
  prices: array(source(object({ symbol: string, daily: array(object({ ...bar, t: finite, day: date })), weekly: array(object({ ...bar, weekStart: date, observedOn: date, turnoverWon: nullValue })), firstObservedOn: nullable(date), source: string, pages: finite, currentExcluded: boolean }))),
  sectors: array(object({ id: string, daily: array(object({ day: date, value: n, reason: nullable(string), members: array(string), returnContributors: array(string) })), weekly: array(object({ day: date, value: n, return13w: n, rank: n, rankedSectors: finite, rankedMembers: finite, breadthPct: n, newHighCount: finite, eligibleCount: finite, unknownCount: finite, memberRanks: array(object({ code: string, return13w: n, rank: n })) })) })),
  technical: array(object({ day: date, sma10: n, sma30: n, sma40: n, high52w: nullable(boolean), disparity40Pct: n, drawdownPct: finite, rangePct: n, rsi14: n, macd: n, macdSignal: n, macdHistogram: n, stockToMarket: n, stockToSector: n, sectorToMarket: n, stockToMarketHigh52w: nullable(boolean), stockToSectorHigh52w: nullable(boolean), sectorToMarketHigh52w: nullable(boolean), turnoverWon: nullValue, turnoverSma10Won: nullValue, marketSharePct: nullValue, marketCapRank: nullValue })),
  markets: array(object({ symbol: string, days: array(object({ day: date, close: finite, sma200: n, sma200Change: n, drawdownPct: finite, regime: nullable(choice(["bull", "bear", "sideways"])), reason: nullable(string) })) })),
  foreignHoldings: source(history(object({ day: date, shares: finite, weightPct: finite }))),
  investorNetShares: source(history((input) => ({ ...flow(input), ...object({ day: date, individual: finite, foreign: finite, otherCorporation: finite })(input) }))),
  institutionCumulative: array(object({ day: date, segmentStart: nullable(date), completeSinceObservationStart: boolean, knownNetSinceStart: nullable(flow), segmentNet: nullable(flow), reason: nullable(string) })),
  dart: object({ identity: object({ targetCode: string, requestedCorpCode: string, companies: array(object({ corpCode: string, stockCode: nullable(string), corpName: nullable(string) })), verification: union(union(object({ kind: literal("verified") }), object({ kind: literal("mismatch"), reason: literal("dart_stock_code_mismatch") })), object({ kind: literal("unverified"), reason: string })) }), financials: object({ quarters: array(period), annual: array(period), latestMetrics: array(object({ year: finite, quarter: choice([1, 2, 3, 4]), values: metrics })), latestAnnualMetrics: array(object({ year: finite, values: metrics })), timeline: array(object({ day: date, financialPeriod: nullable(string), values: nullable(metrics) })), limitations: array(string) }), sourceFailures: array(object({ source: string, reason: string })), disclosures: source(array(disclosure)), capitalEvents: array(source(array(object({ endpoint: string, disclosure, fields: record(string), effect: literal("announcement-only") })))) }),
  fred: array(source(object({ id: string, unit: choice(["KRW/USD", "percent"]), frequency: choice(["daily", "monthly"]), observations: array(object({ day: date, value: n })), aligned: array(object({ day: date, sourceDay: nullable(date), value: n, reason: nullable(string) })), vintage: literal("latest-download") }))),
  valuation: array(object({ day: date, financialPeriod: nullable(string), epsTtm: measure, bps: measure, per: measure, pbr: measure, perBands: array(object({ multiple: finite, price: measure })), pbrBands: array(object({ multiple: finite, price: measure })) })),
  returnDecomposition: object({ from: nullable(date), to: nullable(date), priceFactor: n, earningsFactor: nullValue, perFactor: nullValue }),
  corrections: array(object({ from: date, trough: date, recoveredOn: nullable(date), depthPct: finite, observations: finite, volume: finite })),
  missing: array(object({ source: string, reason: string })), limitations: array(string),
} satisfies { [K in keyof Bundle]: Parser<Bundle[K]> };
const bundle: Parser<Bundle> = object(bundleShape);

export function parseBundle(input: unknown): Bundle {
  return checkedBundle(bundle(input));
}
export async function parseDocumentBundle(document: BundleDocument, inflate: InflatePage): Promise<Bundle> {
  const result = await decodeDocument(document, inflate, (key, value) => bundleShape[key](value));
  return checkedBundle(result as Bundle);
}
function checkedBundle(result: Bundle): Bundle {
  if (result.range.from > result.range.to) throw new Error("invalid_bundle_range");
  ordered(result.calendar, (d) => d);
  for (const p of result.prices) if (p.kind === "ok") { ordered(p.data.daily, (b) => b.day); ordered(p.data.weekly, (b) => b.weekStart); }
  ordered(result.technical, (p) => p.day);
  ordered(result.valuation, (p) => p.day);
  ordered(result.dart.financials.timeline, (p) => p.day);
  ordered(result.dart.financials.quarters, (p) => p.periodEnd);
  ordered(result.dart.financials.annual, (p) => p.periodEnd);
  ordered(result.institutionCumulative, (p) => p.day);
  for (const s of result.sectors) { ordered(s.daily, (p) => p.day); ordered(s.weekly, (p) => p.day); }
  for (const m of result.markets) ordered(m.days, (p) => p.day);
  for (const f of result.fred) if (f.kind === "ok") { ordered(f.data.observations, (p) => p.day); ordered(f.data.aligned, (p) => p.day); }
  for (const h of [result.foreignHoldings, result.investorNetShares]) if (h.kind === "ok") ordered<{ day: string }>(h.data.days, (p) => p.day);
  for (const p of result.dart.financials.quarters.concat(result.dart.financials.annual)) {
    for (const key of [...FLOW_KEYS, ...BALANCE_KEYS]) if (p.single[key].value === null && !p.single[key].reason) throw new Error("missing_measure_reason");
  }
  return result;
}
