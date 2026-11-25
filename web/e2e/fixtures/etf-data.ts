import type { ApiError } from "../../src/api/generated/ApiError";
import type { EtfAccumulation } from "../../src/api/generated/EtfAccumulation";
import type { EtfChangePair } from "../../src/api/generated/EtfChangePair";
import type { EtfChangeRow } from "../../src/api/generated/EtfChangeRow";
import type { EtfChanges } from "../../src/api/generated/EtfChanges";
import type { EtfFundDetail } from "../../src/api/generated/EtfFundDetail";
import type { EtfFundList } from "../../src/api/generated/EtfFundList";
import type { EtfFundSummary } from "../../src/api/generated/EtfFundSummary";
import type { EtfHistory } from "../../src/api/generated/EtfHistory";
import type { EtfHolding } from "../../src/api/generated/EtfHolding";
import type { EtfStockHolders } from "../../src/api/generated/EtfStockHolders";
import type { EtfMaStates } from "../../src/api/generated/EtfMaStates";
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

const summary = (base: Pick<EtfFundSummary, "code" | "name" | "issuer" | "style" | "benchmark" | "status">, holdings: readonly EtfHolding[]): EtfFundSummary => ({
  ...base,
  holdingsCount: holdings.length,
  top5WeightBps: holdings.toSorted((a, b) => b.weightBps - a.weightBps).slice(0, 5).reduce((sum, h) => sum + h.weightBps, 0),
  effectiveHoldings: effectiveHoldings(holdings),
});

const SNAPSHOT_STATUS = { source: "snapshot", holdingsAsOf: "2026-10-30", lastAttemptAt: null, refreshFailed: false } as const;

export const ETF_DETAILS: readonly EtfFundDetail[] = [
  { fund: summary({ code: "444200", name: "SOL 코리아메가테크액티브", issuer: "신한자산운용", style: "active", benchmark: "KRX 메가테크", status: SNAPSHOT_STATUS }, MEGA_TECH), holdings: MEGA_TECH, maAsOf: null },
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
      medianRealChange: 0.2766,
      ma: { ma20: "above", ma60: "above", ma120: "above" },
      contributors: [
        { fundCode: "426030", fundName: "TIME 미국나스닥100액티브", style: "active", kind: "added", realChange: null, afterWeightBps: 650 },
        { fundCode: "444200", fundName: "SOL 코리아메가테크액티브", style: "active", kind: "increased", realChange: 0.2766, afterWeightBps: 1800 },
      ],
    },
    {
      code: "402340",
      name: "SK스퀘어",
      buyingEtfCount: 1,
      addedEtfCount: 1,
      increasedEtfCount: 0,
      medianRealChange: null,
      ma: { ma20: "above", ma60: "equal", ma120: "below" },
      contributors: [
        { fundCode: "444200", fundName: "SOL 코리아메가테크액티브", style: "active", kind: "added", realChange: null, afterWeightBps: 520 },
      ],
    },
  ],
};

export const ACCUMULATION_5_ALL: EtfAccumulation = {
  window: 5,
  style: "all",
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
      medianRealChange: 0.2133,
      ma: { ma20: "above", ma60: "above", ma120: "above" },
      contributors: [
        { fundCode: "426030", fundName: "TIME 미국나스닥100액티브", style: "active", kind: "added", realChange: null, afterWeightBps: 650 },
        { fundCode: "444200", fundName: "SOL 코리아메가테크액티브", style: "active", kind: "increased", realChange: 0.2766, afterWeightBps: 1800 },
        { fundCode: "091160", fundName: "KODEX 반도체", style: "passive", kind: "increased", realChange: 0.15, afterWeightBps: 2600 },
      ],
    },
    {
      code: "005930",
      name: "삼성전자",
      buyingEtfCount: 1,
      addedEtfCount: 0,
      increasedEtfCount: 1,
      medianRealChange: 0.085,
      ma: { ma20: "above", ma60: "below", ma120: "equal" },
      contributors: [
        { fundCode: "091160", fundName: "KODEX 반도체", style: "passive", kind: "increased", realChange: 0.085, afterWeightBps: 3100 },
      ],
    },
  ],
};

export const ACCUMULATION_20_ACTIVE: EtfAccumulation = {
  window: 20,
  style: "active",
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
      medianRealChange: 0.315,
      ma: { ma20: "above", ma60: "above", ma120: "above" },
      contributors: [
        { fundCode: "444200", fundName: "SOL 코리아메가테크액티브", style: "active", kind: "increased", realChange: 0.42, afterWeightBps: 1100 },
        { fundCode: "426030", fundName: "TIME 미국나스닥100액티브", style: "active", kind: "increased", realChange: 0.21, afterWeightBps: 1500 },
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

export function etfBaseline(path: string, method: string, query: URLSearchParams = new URLSearchParams()): FixtureReply | null {
  if (method !== "GET") return null;
  if (path === "/api/etf/accumulation") {
    const window = query.get("window") ?? "5";
    const style = query.get("style") ?? "active";
    if (window === "20") return { body: style === "all" ? ACCUMULATION_20_ALL : ACCUMULATION_20_ACTIVE };
    return { body: style === "all" ? ACCUMULATION_5_ALL : ACCUMULATION_5_ACTIVE };
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
