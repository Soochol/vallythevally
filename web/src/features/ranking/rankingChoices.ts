import type { Excludes } from "../../api/generated/Excludes";
import type { Ranking } from "../../api/generated/Ranking";
import type { RankingMarket } from "../../api/generated/RankingMarket";
import type { Venue } from "../../api/generated/Venue";
import { RANKING_NAME, type RankingKind } from "./rankingKinds";

export interface RankingCategory {
  id: string;
  name: string;
  kinds: readonly RankingKind[];
}

export const RANKING_CATEGORIES: readonly RankingCategory[] = Object.freeze([
  { id: "trade", name: "거래", kinds: ["tradeAmount", "tradeVolume", "turnover", "volumeSurge"] },
  { id: "move", name: "등락", kinds: ["gainers", "losers", "expected"] },
  { id: "flow", name: "수급", kinds: ["investorNetBuy", "foreignStreak", "program"] },
  { id: "quote", name: "호가", kinds: ["bidAskBalance"] },
  { id: "other", name: "기타", kinds: ["creditRatio", "mostViewed"] },
]);

export const categoryOf = (kind: RankingKind): RankingCategory => RANKING_CATEGORIES.find((c) => c.kinds.includes(kind)) ?? RANKING_CATEGORIES[0]!;

export const KIWOOM_TR: Readonly<Record<RankingKind, string>> = Object.freeze({
  tradeAmount: "ka10032",
  tradeVolume: "ka10030",
  turnover: "ka10030",
  volumeSurge: "ka10023",
  gainers: "ka10027",
  losers: "ka10027",
  expected: "ka10029",
  investorNetBuy: "ka10065",
  foreignStreak: "ka10035",
  program: "ka90003",
  bidAskBalance: "ka10020",
  creditRatio: "ka10033",
  mostViewed: "ka00198",
});

export const VENUE_LABEL: Readonly<Record<Venue, string>> = Object.freeze({ combined: "통합", krx: "KRX", nxt: "NXT" });

const MARKET_LABEL: Readonly<Record<RankingMarket, string>> = Object.freeze({ all: "전체", kospi: "코스피", kosdaq: "코스닥" });

interface Common {
  market: RankingMarket;
  venue: Venue;
  excludes: Excludes;
  excludeManaged: boolean;
}

const WITHOUT_ALL_MARKET: ReadonlySet<RankingKind> = new Set(["program", "bidAskBalance"]);

export const marketOptions = (kind: RankingKind): readonly RankingMarket[] => (WITHOUT_ALL_MARKET.has(kind) ? ["kospi", "kosdaq"] : ["all", "kospi", "kosdaq"]);

function commonOf(from: Ranking, venueWhenMissing: Venue): Common {
  return {
    market: "market" in from ? from.market : "all",
    venue: "venue" in from ? from.venue : venueWhenMissing,
    excludes: from.excludes,
    excludeManaged: "excludeManaged" in from ? from.excludeManaged : false,
  };
}

export function startRanking(kind: RankingKind, common: Common): Ranking {
  const { venue, excludes, excludeManaged } = common;
  const market = WITHOUT_ALL_MARKET.has(kind) && common.market === "all" ? "kospi" : common.market;
  switch (kind) {
    case "tradeAmount":
    case "turnover":
    case "creditRatio":
      return { kind, market, venue, excludes, excludeManaged };
    case "tradeVolume":
      return { kind, market, venue, session: "all", excludes, excludeManaged };
    case "volumeSurge":
      return { kind, market, venue, baseline: "previousDay", sort: "surgeRate", excludes, excludeManaged };
    case "gainers":
    case "losers":
      return { kind, market, venue, includeLimit: true, minTradeAmount: "any", excludes, excludeManaged };
    case "expected":
      return { kind, market, venue, sort: "gainers", excludes, excludeManaged };
    case "investorNetBuy":
      return { kind, market, investor: "foreign", direction: "netBuy", unit: "amount", excludes };
    case "foreignStreak":
      return { kind, market, venue, direction: "netBuy", excludes };
    case "program":
      return { kind, market: market === "all" ? "kospi" : market, venue, direction: "netBuy", excludes };
    case "bidAskBalance":
      return { kind, market: market === "all" ? "kospi" : market, venue, sort: "netBuyRemaining", excludes, excludeManaged };
    case "mostViewed":
      return { kind, span: "minute1", excludes };
  }
}

export function changeRankingKind(from: Ranking, kind: RankingKind, venueWhenMissing: Venue): Ranking {
  return from.kind === kind ? from : startRanking(kind, commonOf(from, venueWhenMissing));
}

type Option = { value: string; label: string };
export type Condition =
  | { id: string; label: string; type: "choice"; value: string; options: readonly Option[]; set(next: string): Ranking }
  | { id: string; label: string; type: "toggle"; on: boolean; set(on: boolean): Ranking };

const options = (labels: Readonly<Record<string, string>>): readonly Option[] => Object.entries(labels).map(([value, label]) => ({ value, label }));
const patch = (from: Ranking, key: string, value: unknown) => ({ ...from, [key]: value }) as Ranking;
const read = (from: Ranking, key: string): unknown => (from as Record<string, unknown>)[key];

const SESSION = options({ all: "전체", regular: "장중", preMarket: "장전 시간외", afterHours: "장후 시간외" });
const BASELINE = options({ previousDay: "전일", minutes1: "1분", minutes5: "5분", minutes10: "10분" });
const SURGE_SORT = options({ surgeRate: "급증률", surgeVolume: "급증량", dropRate: "급감률" });
const MIN_TRADE_AMOUNT = options({ any: "전체", atLeast100Million: "1억 이상", atLeast1Billion: "10억 이상", atLeast10Billion: "100억 이상" });
const EXPECTED_SORT = options({ gainers: "상승률", losers: "하락률" });
const INVESTOR = options({ foreign: "외국인", foreignFirm: "외국계", financialInvestment: "금융투자", investmentTrust: "투신", otherFinancial: "기타금융", bank: "은행", insurance: "보험", pensionFund: "연기금", state: "국가", otherCorporation: "기타법인", institution: "기관계" });
const UNIT = options({ amount: "금액", quantity: "수량" });
const BALANCE_SORT = options({ netBuyRemaining: "순매수잔량", netSellRemaining: "순매도잔량", buyRatio: "매수비율", sellRatio: "매도비율" });
const SPAN = options({ seconds30: "30초", minute1: "1분", minutes10: "10분", hour1: "1시간", today: "당일 누적" });

const directionOptions = (kind: RankingKind): readonly Option[] => {
  if (kind === "foreignStreak") return options({ netBuy: "연속 순매수", netSell: "연속 순매도" });
  if (kind === "program") return options({ netBuy: "순매수 상위", netSell: "순매도 상위" });
  return options({ netBuy: "순매수", netSell: "순매도" });
};

export function conditionsOf(ranking: Ranking): readonly Condition[] {
  const out: Condition[] = [];
  const choice = (key: string, label: string, choices: readonly Option[]) => {
    const value = read(ranking, key);
    if (typeof value === "string") out.push({ id: key, label, type: "choice", value, options: choices, set: (next) => patch(ranking, key, next) });
  };
  const toggle = (on: boolean, id: string, label: string, set: (on: boolean) => Ranking) => out.push({ id, label, type: "toggle", on, set });
  choice("market", "시장", marketOptions(ranking.kind).map((value) => ({ value, label: MARKET_LABEL[value] })));
  choice("venue", "거래소", options(VENUE_LABEL));
  choice("session", "장 구분", SESSION);
  choice("baseline", "견주는 때", BASELINE);
  if (ranking.kind === "volumeSurge") choice("sort", "정렬", SURGE_SORT);
  if (ranking.kind === "expected") choice("sort", "정렬", EXPECTED_SORT);
  if (ranking.kind === "bidAskBalance") choice("sort", "정렬", BALANCE_SORT);
  choice("minTradeAmount", "거래대금", MIN_TRADE_AMOUNT);
  choice("investor", "투자자", INVESTOR);
  choice("direction", "방향", directionOptions(ranking.kind));
  choice("unit", "단위", UNIT);
  choice("span", "구간", SPAN);
  if ("includeLimit" in ranking) toggle(ranking.includeLimit, "includeLimit", "상·하한가 포함", (on) => patch(ranking, "includeLimit", on));
  toggle(ranking.excludes.etfEtn, "etfEtn", "ETF·ETN 빼기", (on) => ({ ...ranking, excludes: { ...ranking.excludes, etfEtn: on } }));
  toggle(ranking.excludes.preferred, "preferred", "우선주 빼기", (on) => ({ ...ranking, excludes: { ...ranking.excludes, preferred: on } }));
  if ("excludeManaged" in ranking) toggle(ranking.excludeManaged, "excludeManaged", "관리종목 빼기", (on) => patch(ranking, "excludeManaged", on));
  return out;
}

export const rankingName = (ranking: Ranking): string => RANKING_NAME[ranking.kind];
