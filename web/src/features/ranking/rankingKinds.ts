import type { Ranking } from "../../api/generated/Ranking";

export type RankingKind = Ranking["kind"];

export const RANKING_NAME: Readonly<Record<RankingKind, string>> = Object.freeze({
  tradeAmount: "거래대금",
  tradeVolume: "거래량",
  turnover: "회전율",
  volumeSurge: "거래량 급증",
  gainers: "상승률",
  losers: "하락률",
  expected: "예상체결",
  investorNetBuy: "투자자별 순매수",
  foreignStreak: "외국인 연속",
  program: "프로그램",
  bidAskBalance: "호가잔량",
  creditRatio: "신용비율",
  mostViewed: "많이 본 종목",
});

export const RANKING_KINDS: readonly RankingKind[] = Object.freeze(Object.keys(RANKING_NAME) as RankingKind[]);

export const isRankingKind = (kind: unknown): kind is RankingKind => typeof kind === "string" && Object.hasOwn(RANKING_NAME, kind);
