import type { Market } from "../api/generated/Market";
import type { Period } from "../api/generated/Period";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { SymbolInfo } from "../api/generated/SymbolInfo";
import type { SymbolKind } from "../api/generated/SymbolKind";

export const isIndexCode = (code: SymbolCode) => code.startsWith("IDX:");

export const MARKET_LABEL: Record<Market, string> = { kospi: "코스피", kosdaq: "코스닥" };
export const KIND_LABEL: Record<SymbolKind, string> = {
  index: "지수",
  common: "주식",
  preferred: "우선주",
  etf: "ETF",
  reit: "리츠",
};

/** 이름 옆에 붙는 보조 글자: 주식은 코드, 지수는 `지수`. */
export function symbolSub(code: SymbolCode, info: SymbolInfo | undefined): string {
  return info?.kind === "index" || isIndexCode(code) ? KIND_LABEL.index : code;
}

/** #2에서 켜지는 봉 주기(일·주·월). */
export const PERIODS_ON = ["D", "W", "M"] as const satisfies readonly Period[];
export type PeriodOn = (typeof PERIODS_ON)[number];
export const isPeriodOn = (p: string): p is PeriodOn => (PERIODS_ON as readonly string[]).includes(p);

export const PERIOD_LABEL: Record<Period, string> = {
  "1m": "1분",
  "3m": "3분",
  "5m": "5분",
  "15m": "15분",
  "30m": "30분",
  "60m": "60분",
  D: "일",
  W: "주",
  M: "월",
};
