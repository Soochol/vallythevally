import type { Bar } from "../../web/src/api/generated/Bar.ts";
import type { DayHistory } from "../../web/src/api/generated/DayHistory.ts";
import type { ForeignHoldingDay } from "../../web/src/api/generated/ForeignHoldingDay.ts";
import type { InvestorNetSharesDay } from "../../web/src/api/generated/InvestorNetSharesDay.ts";
import type { Fundamentals } from "../../web/src/api/generated/Fundamentals.ts";
import type { SymbolInfo } from "../../web/src/api/generated/SymbolInfo.ts";
import type { SectorMap } from "./sector-map.ts";

export type Day = string & { readonly __brand: "Day" };
export type SourceResult<T> = { kind: "ok"; source: string; data: T } | { kind: "missing"; source: string; reason: string };
export type NullValue = { value: number; reason: null } | { value: null; reason: string };
export interface FactSource {
  endpoint: string;
  receipt: string;
  filedOn: Day;
  url: string;
  accountId: string | null;
  accountName: string;
  match: "standard-id" | "account-name" | "reported";
  field: string;
}
export type Unit = "KRW" | "KRW/share" | "shares" | "percent" | "multiple";
export type Measure = NullValue & { unit: Unit; sources: FactSource[]; availableFrom: Day | null };
export type DailyBar = Bar & { day: Day };
export interface WeeklyBar {
  weekStart: Day;
  observedOn: Day;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  turnoverWon: NullValue;
}
export interface PriceSeries {
  symbol: string;
  daily: DailyBar[];
  weekly: WeeklyBar[];
  firstObservedOn: Day | null;
  source: string;
  pages: number;
  currentExcluded: boolean;
}
export const FLOW_KEYS = ["revenue", "operatingProfit", "parentNetIncome", "operatingCashFlow", "investingCashFlow", "capex"] as const;
export const BALANCE_KEYS = ["parentEquity", "equity", "liabilities", "inventory", "receivables"] as const;
export type FlowKey = (typeof FLOW_KEYS)[number];
export type BalanceKey = (typeof BALANCE_KEYS)[number];
export type AccountKey = FlowKey | BalanceKey;
export type Accounts = Record<AccountKey, Measure>;
export type Quarter = 1 | 2 | 3 | 4;
export interface FinancialPeriod {
  year: number;
  quarter: Quarter;
  periodEnd: Day;
  filedOn: Day | null;
  availableFrom: Day | null;
  filingLagDays: number | null;
  single: Accounts;
  cumulative: Accounts;
  reportedEps: Measure;
  commonShares: Measure;
  outstandingCommonShares: Measure;
  otherShares: Measure;
  dps: Measure;
}
export interface FinancialMetrics {
  periodEps: Measure;
  operatingMarginPct: Measure;
  revenueYoyPct: Measure;
  operatingProfitYoyPct: Measure;
  operatingProfitAccelerationPp: Measure;
  parentNetIncomeTtm: Measure;
  operatingProfitTtm: Measure;
  revenueTtm: Measure;
  operatingCashFlowTtm: Measure;
  investingCashFlowTtm: Measure;
  capexTtm: Measure;
  freeCashFlowTtm: Measure;
  epsTtm: Measure;
  bps: Measure;
  parentRoePct: Measure;
  debtRatioPct: Measure;
  freeCashFlow: Measure;
  inventoryWarningPp: Measure;
  receivablesWarningPp: Measure;
}
export interface FinancialData {
  quarters: FinancialPeriod[];
  annual: FinancialPeriod[];
  metrics: Array<{ year: number; quarter: Quarter; values: FinancialMetrics }>;
  annualMetrics: Array<{ year: number; values: FinancialMetrics }>;
  limitations: string[];
}
export interface Disclosure {
  receipt: string;
  filedOn: Day;
  title: string;
  url: string;
}
export interface CapitalEvent {
  endpoint: string;
  disclosure: Disclosure;
  fields: Record<string, string>;
  effect: "announcement-only";
}
export interface DartData {
  financials: FinancialData;
  sourceFailures: Array<{ source: string; reason: string }>;
  disclosures: SourceResult<Disclosure[]>;
  capitalEvents: Array<SourceResult<CapitalEvent[]>>;
}
export interface SectorDay {
  day: Day;
  value: number | null;
  reason: string | null;
  members: string[];
  returnContributors: string[];
}
export interface SectorWeek {
  day: Day;
  value: number | null;
  return13w: number | null;
  rank: number | null;
  rankedSectors: number;
  rankedMembers: number;
  breadthPct: number | null;
  newHighCount: number;
  eligibleCount: number;
  unknownCount: number;
  memberRanks: Array<{ code: string; return13w: number | null; rank: number | null }>;
}
export interface SectorSeries {
  id: string;
  daily: SectorDay[];
  weekly: SectorWeek[];
}
export interface TechnicalWeek {
  day: Day;
  sma10: number | null;
  sma30: number | null;
  sma40: number | null;
  high52w: boolean | null;
  disparity40Pct: number | null;
  drawdownPct: number;
  rangePct: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  stockToMarket: number | null;
  stockToSector: number | null;
  sectorToMarket: number | null;
  stockToMarketHigh52w: boolean | null;
  stockToSectorHigh52w: boolean | null;
  sectorToMarketHigh52w: boolean | null;
  turnoverWon: NullValue;
  turnoverSma10Won: NullValue;
  marketSharePct: NullValue;
  marketCapRank: NullValue;
}
export interface MarketDay {
  day: Day;
  close: number;
  sma200: number | null;
  sma200Change: number | null;
  drawdownPct: number;
  regime: "bull" | "bear" | "sideways" | null;
  reason: string | null;
}
export interface FredObservation { day: Day; value: number | null }
export interface FredSeries {
  id: string;
  unit: "KRW/USD" | "percent";
  frequency: "daily" | "monthly";
  observations: FredObservation[];
  aligned: Array<{ day: Day; sourceDay: Day | null; value: number | null; reason: string | null }>;
  vintage: "latest-download";
}
export const INSTITUTIONS = ["institution", "financialInvestment", "insurance", "investmentTrust", "otherFinancial", "bank", "pensionFund", "privateFund", "government"] as const;
export type Institution = (typeof INSTITUTIONS)[number];
export interface CumulativeFlow {
  day: Day;
  segmentStart: Day | null;
  completeSinceObservationStart: boolean;
  knownNetSinceStart: Record<Institution, number> | null;
  segmentNet: Record<Institution, number> | null;
  reason: string | null;
}
export interface ValuationDay {
  day: Day;
  financialPeriod: string | null;
  epsTtm: Measure;
  bps: Measure;
  per: Measure;
  pbr: Measure;
  perBands: Array<{ multiple: number; price: Measure }>;
  pbrBands: Array<{ multiple: number; price: Measure }>;
}
export interface Bundle {
  schemaVersion: 1;
  generatedAt: string;
  code: string;
  range: { from: Day; to: Day };
  calendar: Day[];
  sectorMap: SectorMap;
  symbol: SourceResult<SymbolInfo>;
  currentFundamentals: SourceResult<{ fetchedAt: string; values: Fundamentals; historical: false }>;
  prices: Array<SourceResult<PriceSeries>>;
  sectors: SectorSeries[];
  technical: TechnicalWeek[];
  markets: Array<{ symbol: string; days: MarketDay[] }>;
  foreignHoldings: SourceResult<DayHistory<ForeignHoldingDay>>;
  investorNetShares: SourceResult<DayHistory<InvestorNetSharesDay>>;
  institutionCumulative: CumulativeFlow[];
  dart: DartData;
  fred: Array<SourceResult<FredSeries>>;
  valuation: ValuationDay[];
  returnDecomposition: { from: Day | null; to: Day | null; priceFactor: number | null; earningsFactor: NullValue; perFactor: NullValue };
  corrections: Array<{ from: Day; trough: Day; recoveredOn: Day | null; depthPct: number; observations: number; volume: number }>;
  missing: Array<{ source: string; reason: string }>;
  limitations: string[];
}
