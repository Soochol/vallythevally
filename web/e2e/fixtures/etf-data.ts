import type { ApiError } from "../../src/api/generated/ApiError";
import type { EtfFundDetail } from "../../src/api/generated/EtfFundDetail";
import type { EtfFundList } from "../../src/api/generated/EtfFundList";
import type { EtfFundSummary } from "../../src/api/generated/EtfFundSummary";
import type { EtfHolding } from "../../src/api/generated/EtfHolding";
import type { EtfMaStates } from "../../src/api/generated/EtfMaStates";
import type { FixtureReply } from "./scenario";

export const NO_MA: EtfMaStates = { ma20: null, ma60: null, ma120: null };

const holding = (code: string, name: string, weightBps: number, ma: EtfMaStates = NO_MA): EtfHolding => ({ code, name, weightBps, ma });

const MEGA_TECH: EtfHolding[] = [
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
  holding("005930", "삼성전자", 3100),
  holding("000660", "SK하이닉스", 2600),
  holding("086520", "에코프로", 400),
];

const NASDAQ: EtfHolding[] = [
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
  { fund: summary({ code: "444200", name: "SOL 코리아메가테크액티브", issuer: "신한자산운용", style: "active", benchmark: "KRX 메가테크", status: SNAPSHOT_STATUS }, MEGA_TECH), holdings: MEGA_TECH },
  { fund: summary({ code: "091160", name: "KODEX 반도체", issuer: "삼성자산운용", style: "passive", benchmark: "KRX 반도체", status: SNAPSHOT_STATUS }, SEMICONDUCTOR), holdings: SEMICONDUCTOR },
  {
    fund: summary({ code: "426030", name: "TIME 미국나스닥100액티브", issuer: "타임폴리오자산운용", style: "active", benchmark: "나스닥100", status: { source: "collected", holdingsAsOf: "2026-11-17", lastAttemptAt: 1_795_000_000, refreshFailed: true } }, NASDAQ),
    holdings: NASDAQ,
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

export function etfBaseline(path: string, method: string): FixtureReply | null {
  if (method !== "GET") return null;
  if (path === "/api/etf/funds") return { body: ETF_FUNDS };
  const match = /^\/api\/etf\/funds\/([^/]+)$/.exec(path);
  if (!match) return null;
  const code = decodeURIComponent(match[1]!);
  const detail = ETF_DETAILS.find((entry) => entry.fund.code === code);
  return detail ? { body: detail } : notFound(code);
}
