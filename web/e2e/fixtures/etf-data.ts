import type { ApiError } from "../../src/api/generated/ApiError";
import type { EtfAccumulation } from "../../src/api/generated/EtfAccumulation";
import type { EtfChangePair } from "../../src/api/generated/EtfChangePair";
import type { EtfChangeRow } from "../../src/api/generated/EtfChangeRow";
import type { EtfChanges } from "../../src/api/generated/EtfChanges";
import type { EtfFlowRanking } from "../../src/api/generated/EtfFlowRanking";
import type { EtfFundDetail } from "../../src/api/generated/EtfFundDetail";
import type { EtfFundList } from "../../src/api/generated/EtfFundList";
import type { EtfFundSummary } from "../../src/api/generated/EtfFundSummary";
import type { EtfHistory } from "../../src/api/generated/EtfHistory";
import type { EtfHolding } from "../../src/api/generated/EtfHolding";
import type { EtfMaStates } from "../../src/api/generated/EtfMaStates";
import type { EtfSharesSeries } from "../../src/api/generated/EtfSharesSeries";
import type { EtfSimilarFund } from "../../src/api/generated/EtfSimilarFund";
import type { EtfSimilarFunds } from "../../src/api/generated/EtfSimilarFunds";
import type { EtfStockHolders } from "../../src/api/generated/EtfStockHolders";
import type { FixtureReply } from "./scenario";

export const NO_MA: EtfMaStates = { ma20: null, ma60: null, ma120: null };

const holding = (code: string, name: string, weightBps: number, ma: EtfMaStates = NO_MA): EtfHolding => ({ code, name, weightBps, ma });

const MEGA_TECH: EtfHolding[] = [
  holding("005380", "현대차", 2400),
  holding("005930", "삼성전자", 2200, { ma20: "above", ma60: "below", ma120: "equal" }),
  holding("000660", "SK하이닉스", 1800, { ma20: "below", ma60: "below", ma120: "above" }),
  holding("035420", "NAVER", 1100, { ma20: "above", ma60: "above", ma120: "above" }),
  holding("051910", "LG화학", 900),
  holding("000270", "기아", 700),
  holding("028260", "삼성물산", 500),
  holding("086520", "에코프로", 300),
  holding("0222D0", "합성종목", 100),
];

const SEMICONDUCTOR: EtfHolding[] = [
  holding("402340", "SK스퀘어", 3900),
  holding("005930", "삼성전자", 3100),
  holding("000660", "SK하이닉스", 2600),
  holding("086520", "에코프로", 400),
];

const NASDAQ: EtfHolding[] = [
  holding("005380", "현대차", 6500),
  holding("035420", "NAVER", 1500),
  holding("051910", "LG화학", 1200),
  holding("000270", "기아", 800),
];

const effectiveHoldings = (holdings: readonly EtfHolding[]) => {
  const total = holdings.reduce((sum, h) => sum + h.weightBps, 0);
  return 1 / holdings.reduce((sum, h) => sum + (h.weightBps / total) ** 2, 0);
};

const summary = (
  base: Pick<EtfFundSummary, "code" | "name" | "issuer" | "style" | "benchmark" | "status"> & {
    recentActivity?: EtfFundSummary["recentActivity"];
    latestAumWon?: number | null;
    netFlow5dWon?: number | null;
  },
  holdings: readonly EtfHolding[],
): EtfFundSummary => ({
  ...base,
  holdingsCount: holdings.length,
  top5WeightBps: holdings.toSorted((a, b) => b.weightBps - a.weightBps).slice(0, 5).reduce((sum, h) => sum + h.weightBps, 0),
  effectiveHoldings: effectiveHoldings(holdings),
  recentActivity: base.recentActivity ?? null,
  latestAumWon: base.latestAumWon ?? null,
  netFlow5dWon: base.netFlow5dWon ?? null,
});

const SNAPSHOT_STATUS = { source: "snapshot", holdingsAsOf: "2026-10-30", lastAttemptAt: null, refreshFailed: false } as const;

export const ETF_DETAILS: readonly EtfFundDetail[] = [
  {
    fund: summary(
      {
        code: "444200",
        name: "SOL 코리아메가테크액티브",
        issuer: "신한자산운용",
        style: "active",
        benchmark: "KRX 메가테크",
        status: SNAPSHOT_STATUS,
        recentActivity: { added: 1, removed: 1, increased: 1, decreased: 1 },
      },
      MEGA_TECH,
    ),
    holdings: MEGA_TECH,
    maAsOf: null,
  },
  { fund: summary({ code: "091160", name: "KODEX 반도체", issuer: "삼성자산운용", style: "passive", benchmark: "KRX 반도체", status: SNAPSHOT_STATUS }, SEMICONDUCTOR), holdings: SEMICONDUCTOR, maAsOf: null },
  {
    fund: summary({ code: "426030", name: "TIME 미국나스닥100액티브", issuer: "타임폴리오자산운용", style: "active", benchmark: "나스닥100", status: { source: "collected", holdingsAsOf: "2026-11-17", lastAttemptAt: 1_795_000_000, refreshFailed: true } }, NASDAQ),
    holdings: NASDAQ,
    maAsOf: null,
  },
];

export const ETF_FUNDS: EtfFundList = { funds: ETF_DETAILS.map((detail) => detail.fund) };

export const etfDetailOf = (code: string): EtfFundDetail => {
  const detail = ETF_DETAILS.find((entry) => entry.fund.code === code);
  if (!detail) throw new Error(`ETF fixture 없음: ${code}`);
  return detail;
};

export const withEtfMa = (code: string, ma: EtfMaStates): EtfFundDetail => {
  const detail = etfDetailOf(code);
  return { ...detail, holdings: detail.holdings.map((h) => ({ ...h, ma })) };
};

const notFound = (code: string): FixtureReply => ({ status: 404, body: { error: { code: "not_found", message: `ETF ${code} 없음`, reason: null, retryAt: null, manualActionRequired: false } } satisfies ApiError });

export const etfHoldersOf = (code: string): EtfStockHolders => {
  const holders = ETF_DETAILS.flatMap((detail) => {
    const found = detail.holdings.find((h) => h.code === code);
    return found ? [{ fund: detail.fund, weightBps: found.weightBps }] : [];
  });
  const name = ETF_DETAILS.flatMap((detail) => detail.holdings).find((h) => h.code === code)?.name ?? null;
  return { code, name, ma: NO_MA, maAsOf: null, holders };
};

export const etfSimilarOf = (code: string): EtfSimilarFunds | null => {
  const target = ETF_DETAILS.find((entry) => entry.fund.code === code);
  if (!target) return null;
  const targetWeights = new Map(target.holdings.map((h) => [h.code, h.weightBps]));
  const items: EtfSimilarFund[] = [];
  for (const other of ETF_DETAILS) {
    if (other.fund.code === code) continue;
    let overlapBps = 0;
    let commonCount = 0;
    for (const h of other.holdings) {
      const targetWeight = targetWeights.get(h.code);
      if (targetWeight !== undefined) {
        overlapBps += Math.min(targetWeight, h.weightBps);
        commonCount += 1;
      }
    }
    if (overlapBps > 0) items.push({ fund: other.fund, overlapBps, commonCount });
  }
  items.sort((a, b) => b.overlapBps - a.overlapBps || b.commonCount - a.commonCount || a.fund.code.localeCompare(b.fund.code));
  return { code, items };
};

const changeRow = (code: string, name: string, beforeQuantity: number | null, afterQuantity: number | null, realChange: number | null, kind: EtfChangeRow["kind"]): EtfChangeRow => ({ code, name, beforeQuantity, afterQuantity, realChange, kind });

export const LATEST_CHANGES: EtfChanges = {
  code: "444200",
  before: "2026-11-14",
  after: "2026-11-18",
  commonScale: 0.94,
  rows: [
    changeRow("402340", "SK스퀘어", null, 50, null, "added"),
    changeRow("000660", "SK하이닉스", 1000, 1200, 0.2766, "increased"),
    changeRow("005930", "삼성전자", 2000, 1500, -0.2021, "decreased"),
    changeRow("086520", "에코프로", 300, null, null, "removed"),
    changeRow("035420", "NAVER", 800, 752, 0, "unchanged"),
  ],
};

export const EARLIER_CHANGES: EtfChanges = {
  code: "444200",
  before: "2026-11-10",
  after: "2026-11-14",
  commonScale: 1,
  rows: [changeRow("051910", "LG화학", 400, 440, 0.1, "increased"), changeRow("000270", "기아", 700, 700, 0, "unchanged")],
};

const pairOf = (changes: EtfChanges, counts: Pick<EtfChangePair, "added" | "removed" | "increased" | "decreased">): EtfChangePair => ({ before: changes.before, after: changes.after, commonScale: changes.commonScale, ...counts });

export const MEGA_HISTORY: EtfHistory = {
  code: "444200",
  firstCollectedOn: "2026-11-10",
  pairs: [pairOf(LATEST_CHANGES, { added: 1, removed: 1, increased: 1, decreased: 1 }), pairOf(EARLIER_CHANGES, { added: 0, removed: 0, increased: 1, decreased: 0 })],
};

export const SINGLE_DAY_HISTORY: EtfHistory = { code: "091160", firstCollectedOn: "2026-11-18", pairs: [] };

const NO_HISTORY = (code: string): EtfHistory => ({ code, firstCollectedOn: null, pairs: [] });

export const ACCUMULATION_5_ACTIVE: EtfAccumulation = {
  window: 5,
  style: "active",
  direction: "buy",
  fromDate: "2026-11-11",
  toDate: "2026-11-18",
  collectedDays: 6,
  maAsOf: "2026-11-18",
  rows: [
    {
      code: "000660",
      name: "SK하이닉스",
      buyingEtfCount: 2,
      addedEtfCount: 1,
      increasedEtfCount: 1,
      sellingEtfCount: 0,
      removedEtfCount: 0,
      decreasedEtfCount: 0,
      medianRealChange: 0.2766,
      ma: { ma20: "above", ma60: "above", ma120: "above" },
      contributors: [
        { fundCode: "426030", fundName: "TIME 미국나스닥100액티브", style: "active", kind: "added", realChange: null, beforeWeightBps: null, afterWeightBps: 650 },
        { fundCode: "444200", fundName: "SOL 코리아메가테크액티브", style: "active", kind: "increased", realChange: 0.2766, beforeWeightBps: 1410, afterWeightBps: 1800 },
      ],
    },
    {
      code: "402340",
      name: "SK스퀘어",
      buyingEtfCount: 1,
      addedEtfCount: 1,
      increasedEtfCount: 0,
      sellingEtfCount: 0,
      removedEtfCount: 0,
      decreasedEtfCount: 0,
      medianRealChange: null,
      ma: { ma20: "above", ma60: "equal", ma120: "below" },
      contributors: [
        { fundCode: "444200", fundName: "SOL 코리아메가테크액티브", style: "active", kind: "added", realChange: null, beforeWeightBps: null, afterWeightBps: 520 },
      ],
    },
  ],
};

export const ACCUMULATION_5_ALL: EtfAccumulation = {
  window: 5,
  style: "all",
  direction: "buy",
  fromDate: "2026-11-11",
  toDate: "2026-11-18",
  collectedDays: 6,
  maAsOf: "2026-11-18",
  rows: [
    {
      code: "000660",
      name: "SK하이닉스",
      buyingEtfCount: 3,
      addedEtfCount: 1,
      increasedEtfCount: 2,
      sellingEtfCount: 0,
      removedEtfCount: 0,
      decreasedEtfCount: 0,
      medianRealChange: 0.2133,
      ma: { ma20: "above", ma60: "above", ma120: "above" },
      contributors: [
        { fundCode: "426030", fundName: "TIME 미국나스닥100액티브", style: "active", kind: "added", realChange: null, beforeWeightBps: null, afterWeightBps: 650 },
        { fundCode: "444200", fundName: "SOL 코리아메가테크액티브", style: "active", kind: "increased", realChange: 0.2766, beforeWeightBps: 1410, afterWeightBps: 1800 },
        { fundCode: "091160", fundName: "KODEX 반도체", style: "passive", kind: "increased", realChange: 0.15, beforeWeightBps: 2260, afterWeightBps: 2600 },
      ],
    },
    {
      code: "005930",
      name: "삼성전자",
      buyingEtfCount: 1,
      addedEtfCount: 0,
      increasedEtfCount: 1,
      sellingEtfCount: 0,
      removedEtfCount: 0,
      decreasedEtfCount: 0,
      medianRealChange: 0.085,
      ma: { ma20: "above", ma60: "below", ma120: "equal" },
      contributors: [
        { fundCode: "091160", fundName: "KODEX 반도체", style: "passive", kind: "increased", realChange: 0.085, beforeWeightBps: 2860, afterWeightBps: 3100 },
      ],
    },
  ],
};

export const ACCUMULATION_20_ACTIVE: EtfAccumulation = {
  window: 20,
  style: "active",
  direction: "buy",
  fromDate: "2026-10-21",
  toDate: "2026-11-18",
  collectedDays: 21,
  maAsOf: "2026-11-18",
  rows: [
    {
      code: "035420",
      name: "NAVER",
      buyingEtfCount: 2,
      addedEtfCount: 0,
      increasedEtfCount: 2,
      sellingEtfCount: 0,
      removedEtfCount: 0,
      decreasedEtfCount: 0,
      medianRealChange: 0.315,
      ma: { ma20: "above", ma60: "above", ma120: "above" },
      contributors: [
        { fundCode: "444200", fundName: "SOL 코리아메가테크액티브", style: "active", kind: "increased", realChange: 0.42, beforeWeightBps: 775, afterWeightBps: 1100 },
        { fundCode: "426030", fundName: "TIME 미국나스닥100액티브", style: "active", kind: "increased", realChange: 0.21, beforeWeightBps: 1240, afterWeightBps: 1500 },
      ],
    },
    ACCUMULATION_5_ACTIVE.rows[0]!,
  ],
};

export const ACCUMULATION_20_ALL: EtfAccumulation = {
  ...ACCUMULATION_20_ACTIVE,
  style: "all",
  rows: [ACCUMULATION_5_ALL.rows[0]!, ACCUMULATION_20_ACTIVE.rows[0]!, ACCUMULATION_5_ALL.rows[1]!],
};

export const ACCUMULATION_5_ACTIVE_SELL: EtfAccumulation = {
  window: 5,
  style: "active",
  direction: "sell",
  fromDate: "2026-11-11",
  toDate: "2026-11-18",
  collectedDays: 6,
  maAsOf: "2026-11-18",
  rows: [
    {
      code: "086520",
      name: "에코프로",
      buyingEtfCount: 0,
      addedEtfCount: 0,
      increasedEtfCount: 0,
      sellingEtfCount: 2,
      removedEtfCount: 1,
      decreasedEtfCount: 1,
      medianRealChange: -0.245,
      ma: { ma20: "below", ma60: "below", ma120: "below" },
      contributors: [
        { fundCode: "444200", fundName: "SOL 코리아메가테크액티브", style: "active", kind: "removed", realChange: null, beforeWeightBps: 380, afterWeightBps: null },
        { fundCode: "426030", fundName: "TIME 미국나스닥100액티브", style: "active", kind: "decreased", realChange: -0.245, beforeWeightBps: 620, afterWeightBps: 450 },
      ],
    },
    {
      code: "005930",
      name: "삼성전자",
      buyingEtfCount: 0,
      addedEtfCount: 0,
      increasedEtfCount: 0,
      sellingEtfCount: 1,
      removedEtfCount: 0,
      decreasedEtfCount: 1,
      medianRealChange: -0.2021,
      ma: { ma20: "above", ma60: "below", ma120: "equal" },
      contributors: [
        { fundCode: "444200", fundName: "SOL 코리아메가테크액티브", style: "active", kind: "decreased", realChange: -0.2021, beforeWeightBps: 2750, afterWeightBps: 2200 },
      ],
    },
  ],
};

export const ACCUMULATION_5_ALL_SELL: EtfAccumulation = {
  window: 5,
  style: "all",
  direction: "sell",
  fromDate: "2026-11-11",
  toDate: "2026-11-18",
  collectedDays: 6,
  maAsOf: "2026-11-18",
  rows: [
    {
      ...ACCUMULATION_5_ACTIVE_SELL.rows[0]!,
      sellingEtfCount: 3,
      decreasedEtfCount: 2,
      contributors: [
        ...ACCUMULATION_5_ACTIVE_SELL.rows[0]!.contributors,
        { fundCode: "091160", fundName: "KODEX 반도체", style: "passive", kind: "decreased", realChange: -0.18, beforeWeightBps: 490, afterWeightBps: 400 },
      ],
    },
    ACCUMULATION_5_ACTIVE_SELL.rows[1]!,
  ],
};

export const READY_SHARES_STATUS = {
  state: "ready",
  configured: true,
  latestDate: "2026-11-20",
  firstDate: "2026-10-20",
  collectedDays: 22,
  backfillTargetDays: 60,
  lastAttemptAt: 1_795_170_000,
  message: null,
} as const;

export const FLOWS_5D_ALL: EtfFlowRanking = {
  status: READY_SHARES_STATUS,
  window: 5,
  direction: "all",
  scope: "all",
  sort: "amount",
  fromDate: "2026-11-13",
  toDate: "2026-11-20",
  summary: {
    totalEtfCount: 3,
    totalAumWon: 4_850_000_000_000,
    totalNetFlowWon: 41_000_000_000,
    inflowEtfCount: 2,
    outflowEtfCount: 1,
    inflowTotalWon: 73_000_000_000,
    outflowTotalWon: -32_000_000_000,
    topInflowCode: "091160",
    topInflowName: "KODEX 반도체",
    topInflowWon: 52_000_000_000,
    topOutflowCode: "069500",
    topOutflowName: "KODEX 200",
    topOutflowWon: -32_000_000_000,
  },
  rows: [
    {
      code: "091160",
      name: "KODEX 반도체",
      issuer: "삼성자산운용",
      inCatalog: true,
      style: "passive",
      listedShares: 19_200_000,
      shareChange: 1_200_000,
      shareChangePct: 6.67,
      netFlowWon: 52_000_000_000,
      netFlow1dWon: 12_000_000_000,
      netFlow5dWon: 52_000_000_000,
      netFlow20dWon: 128_000_000_000,
      flowToAumPct: 6.45,
      aumWon: 860_000_000_000,
      marketCapWon: 861_000_000_000,
      nav: 44_790,
      closePrice: 44_850,
      premiumBps: 13,
      streakDays: 4,
      sparklineFlow: [4e9, 8e9, 10e9, 18e9, 12e9],
    },
    {
      code: "069500",
      name: "KODEX 200",
      issuer: null,
      inCatalog: false,
      style: null,
      listedShares: 97_000_000,
      shareChange: -900_000,
      shareChangePct: -0.92,
      netFlowWon: -32_000_000_000,
      netFlow1dWon: -8_000_000_000,
      netFlow5dWon: -32_000_000_000,
      netFlow20dWon: -74_000_000_000,
      flowToAumPct: -0.91,
      aumWon: 3_490_000_000_000,
      marketCapWon: 3_488_000_000_000,
      nav: 35_980,
      closePrice: 35_960,
      premiumBps: -6,
      streakDays: -3,
      sparklineFlow: [-5e9, -7e9, -6e9, -6e9, -8e9],
    },
    {
      code: "444200",
      name: "SOL 코리아메가테크액티브",
      issuer: "신한자산운용",
      inCatalog: true,
      style: "active",
      listedShares: 25_000_000,
      shareChange: 1_050_000,
      shareChangePct: 4.38,
      netFlowWon: 21_000_000_000,
      netFlow1dWon: 6_000_000_000,
      netFlow5dWon: 21_000_000_000,
      netFlow20dWon: 64_000_000_000,
      flowToAumPct: 4.39,
      aumWon: 500_000_000_000,
      marketCapWon: 500_500_000_000,
      nav: 20_000,
      closePrice: 20_020,
      premiumBps: 10,
      streakDays: 3,
      sparklineFlow: [2e9, 3e9, 5e9, 5e9, 6e9],
    },
  ],
};

export const SHARES_SERIES_BY_CODE: Record<string, EtfSharesSeries> = {
  "091160": {
    status: READY_SHARES_STATUS,
    code: "091160",
    name: "KODEX 반도체",
    inCatalog: true,
    latest: {
      date: "2026-11-20",
      listedShares: 19_200_000,
      aumWon: 860_000_000_000,
      marketCapWon: 861_000_000_000,
      nav: 44_790,
      closePrice: 44_850,
      premiumBps: 13,
      netFlow1dWon: 12_000_000_000,
      netFlow5dWon: 52_000_000_000,
      netFlow20dWon: 128_000_000_000,
      shareChange5dPct: 6.67,
      shareChange20dPct: 14.2,
      streakDays: 4,
    },
    points: [
      { date: "2026-11-17", listedShares: 18_000_000, shareDelta: 0, netFlowWon: 0, cumNetFlowWon: 0, aumWon: 774_000_000_000, marketCapWon: 774_900_000_000, nav: 43_000, closePrice: 43_050, premiumBps: 12, tradingValueWon: 18_000_000_000, splitAdjusted: false },
      { date: "2026-11-18", listedShares: 18_500_000, shareDelta: 500_000, netFlowWon: 21_750_000_000, cumNetFlowWon: 21_750_000_000, aumWon: 804_750_000_000, marketCapWon: 805_000_000_000, nav: 43_500, closePrice: 43_515, premiumBps: 3, tradingValueWon: 22_000_000_000, splitAdjusted: false },
      { date: "2026-11-19", listedShares: 18_900_000, shareDelta: 400_000, netFlowWon: 17_680_000_000, cumNetFlowWon: 39_430_000_000, aumWon: 835_380_000_000, marketCapWon: 836_000_000_000, nav: 44_200, closePrice: 44_230, premiumBps: 7, tradingValueWon: 24_000_000_000, splitAdjusted: false },
      { date: "2026-11-20", listedShares: 19_200_000, shareDelta: 300_000, netFlowWon: 13_437_000_000, cumNetFlowWon: 52_867_000_000, aumWon: 860_000_000_000, marketCapWon: 861_000_000_000, nav: 44_790, closePrice: 44_850, premiumBps: 13, tradingValueWon: 26_000_000_000, splitAdjusted: false },
    ],
  },
  "069500": {
    status: READY_SHARES_STATUS,
    code: "069500",
    name: "KODEX 200",
    inCatalog: false,
    latest: {
      date: "2026-11-20",
      listedShares: 97_000_000,
      aumWon: 3_490_000_000_000,
      marketCapWon: 3_488_000_000_000,
      nav: 35_980,
      closePrice: 35_960,
      premiumBps: -6,
      netFlow1dWon: -8_000_000_000,
      netFlow5dWon: -32_000_000_000,
      netFlow20dWon: -74_000_000_000,
      shareChange5dPct: -0.92,
      shareChange20dPct: -2.15,
      streakDays: -3,
    },
    points: [
      { date: "2026-11-18", listedShares: 98_000_000, shareDelta: 0, netFlowWon: 0, cumNetFlowWon: 0, aumWon: 3_479_000_000_000, marketCapWon: 3_479_000_000_000, nav: 35_500, closePrice: 35_500, premiumBps: 0, tradingValueWon: 120_000_000_000, splitAdjusted: false },
      { date: "2026-11-19", listedShares: 97_500_000, shareDelta: -500_000, netFlowWon: -17_850_000_000, cumNetFlowWon: -17_850_000_000, aumWon: 3_480_750_000_000, marketCapWon: 3_479_000_000_000, nav: 35_700, closePrice: 35_680, premiumBps: -6, tradingValueWon: 115_000_000_000, splitAdjusted: false },
      { date: "2026-11-20", listedShares: 97_000_000, shareDelta: -500_000, netFlowWon: -17_990_000_000, cumNetFlowWon: -35_840_000_000, aumWon: 3_490_000_000_000, marketCapWon: 3_488_000_000_000, nav: 35_980, closePrice: 35_960, premiumBps: -6, tradingValueWon: 118_000_000_000, splitAdjusted: false },
    ],
  },
  "444200": {
    status: READY_SHARES_STATUS,
    code: "444200",
    name: "SOL 코리아메가테크액티브",
    inCatalog: true,
    latest: {
      date: "2026-11-20",
      listedShares: 25_000_000,
      aumWon: 500_000_000_000,
      marketCapWon: 500_500_000_000,
      nav: 20_000,
      closePrice: 20_020,
      premiumBps: 10,
      netFlow1dWon: 6_000_000_000,
      netFlow5dWon: 21_000_000_000,
      netFlow20dWon: 64_000_000_000,
      shareChange5dPct: 4.38,
      shareChange20dPct: 12.5,
      streakDays: 3,
    },
    points: [
      { date: "2026-11-18", listedShares: 12_000_000, shareDelta: 0, netFlowWon: 0, cumNetFlowWon: 0, aumWon: 468_000_000_000, marketCapWon: 468_000_000_000, nav: 39_000, closePrice: 39_000, premiumBps: 0, tradingValueWon: 14_000_000_000, splitAdjusted: false },
      { date: "2026-11-19", listedShares: 24_000_000, shareDelta: 0, netFlowWon: 0, cumNetFlowWon: 0, aumWon: 472_800_000_000, marketCapWon: 473_000_000_000, nav: 19_700, closePrice: 19_710, premiumBps: 5, tradingValueWon: 15_000_000_000, splitAdjusted: true },
      { date: "2026-11-20", listedShares: 25_000_000, shareDelta: 1_000_000, netFlowWon: 20_000_000_000, cumNetFlowWon: 20_000_000_000, aumWon: 500_000_000_000, marketCapWon: 500_500_000_000, nav: 20_000, closePrice: 20_020, premiumBps: 10, tradingValueWon: 17_000_000_000, splitAdjusted: false },
    ],
  },
};

export function etfBaseline(path: string, method: string, query: URLSearchParams = new URLSearchParams()): FixtureReply | null {
  if (method !== "GET") return null;
  if (path === "/api/etf/flows") {
    const window = Number(query.get("window") ?? "5");
    const direction = (query.get("direction") ?? "all") as EtfFlowRanking["direction"];
    const scope = (query.get("scope") ?? "all") as EtfFlowRanking["scope"];
    const sort = (query.get("sort") ?? "amount") as EtfFlowRanking["sort"];
    let rows = [...FLOWS_5D_ALL.rows];
    if (scope === "catalog") rows = rows.filter((r) => r.inCatalog);
    if (scope === "active") rows = rows.filter((r) => r.style === "active");
    if (scope === "passive") rows = rows.filter((r) => r.style === "passive");
    if (direction === "inflow") rows = rows.filter((r) => r.netFlowWon > 0);
    if (direction === "outflow") rows = rows.filter((r) => r.netFlowWon < 0);
    return { body: { ...FLOWS_5D_ALL, window, direction, scope, sort, rows } };
  }
  const shares = /^\/api\/etf\/funds\/([^/]+)\/shares$/.exec(path);
  if (shares) {
    const code = decodeURIComponent(shares[1]!);
    const found = SHARES_SERIES_BY_CODE[code];
    return found ? { body: found } : notFound(code);
  }
  if (path === "/api/etf/accumulation") {
    const window = query.get("window") ?? "5";
    const style = query.get("style") ?? "active";
    const direction = query.get("direction") ?? "buy";
    if (direction === "sell") {
      return { body: style === "all" ? ACCUMULATION_5_ALL_SELL : ACCUMULATION_5_ACTIVE_SELL };
    }
    if (window === "20") return { body: style === "all" ? ACCUMULATION_20_ALL : ACCUMULATION_20_ACTIVE };
    return { body: style === "all" ? ACCUMULATION_5_ALL : ACCUMULATION_5_ACTIVE };
  }
  const similar = /^\/api\/etf\/funds\/([^/]+)\/similar$/.exec(path);
  if (similar) {
    const code = decodeURIComponent(similar[1]!);
    const payload = etfSimilarOf(code);
    return payload ? { body: payload } : notFound(code);
  }
  const history = /^\/api\/etf\/funds\/([^/]+)\/history$/.exec(path);
  if (history) {
    const code = decodeURIComponent(history[1]!);
    if (!ETF_DETAILS.some((entry) => entry.fund.code === code)) return notFound(code);
    return { body: code === MEGA_HISTORY.code ? MEGA_HISTORY : code === SINGLE_DAY_HISTORY.code ? SINGLE_DAY_HISTORY : NO_HISTORY(code) };
  }
  if (/^\/api\/etf\/funds\/[^/]+\/changes$/.test(path)) {
    const found = [LATEST_CHANGES, EARLIER_CHANGES].find((changes) => changes.before === query.get("before") && changes.after === query.get("after"));
    return found ? { body: found } : notFound(path);
  }
  if (path === "/api/etf/funds") return { body: ETF_FUNDS };
  const stock = /^\/api\/etf\/stocks\/([^/]+)$/.exec(path);
  if (stock) return { body: etfHoldersOf(decodeURIComponent(stock[1]!)) };
  const match = /^\/api\/etf\/funds\/([^/]+)$/.exec(path);
  if (!match) return null;
  const code = decodeURIComponent(match[1]!);
  const detail = ETF_DETAILS.find((entry) => entry.fund.code === code);
  return detail ? { body: detail } : notFound(code);
}
