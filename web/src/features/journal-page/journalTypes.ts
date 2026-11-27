import type { Period } from "../../api/generated/Period";
import type { Venue } from "../../api/generated/Venue";

export type JournalPeriodType = "day" | "week" | "month" | "year" | "all";
export type JournalMetric = "pnl" | "ret" | "n";
export type JournalView = "flow" | "cal" | "table";
export type JournalGrain = "day" | "month" | "year" | "sym";
export type JournalDistMode = "hold" | "ret";
export type JournalSort = "time" | "pnl" | "ret";
export type JournalQuickFilter = "all" | "intraday" | "swing" | "scaled";
export type JournalTf = "1" | "5" | "D";

export interface JournalPeriod {
  readonly type: JournalPeriodType;
  readonly anchor: string;
}

export interface JournalFilters {
  readonly slot: number | null;
  readonly pair: number | null;
  readonly hold: number | null;
  readonly ret: number | null;
  readonly style: number | null;
  readonly tag: string | null;
  readonly sym: string | null;
}

export type JournalFilterKey = keyof JournalFilters;

export interface JournalFill {
  readonly side: "buy" | "sell";
  readonly day: string;
  readonly minutes: number;
  readonly timeLabel: string;
  readonly price: number;
  readonly qty: number;
  readonly orderNo: string;
  readonly fillAt: number | null;
}

export interface JournalTrade {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly venue: Venue;
  readonly entryDay: string;
  readonly exitDay: string;
  readonly entryMin: number;
  readonly exitMin: number;
  readonly entryOrd: number;
  readonly exitOrd: number;
  readonly swing: boolean;
  readonly holdDays: number;
  readonly holdMin: number;
  readonly holdBucket: number;
  readonly buys: readonly JournalFill[];
  readonly sells: readonly JournalFill[];
  readonly qty: number;
  readonly buyAmt: number;
  readonly sellAmt: number;
  readonly fee: number;
  readonly tax: number;
  readonly cost: number;
  readonly gross: number;
  readonly net: number;
  readonly avgBuy: number;
  readonly avgSell: number;
  readonly mfe: number;
  readonly mae: number;
  readonly exitRet: number;
  readonly styleIdx: 0 | 1 | 2;
  readonly entrySlot: number;
  readonly exitSlot: number;
  readonly fillSlots: readonly number[];
  readonly pairIdx: number;
  readonly defaultTags: readonly string[];
  readonly defaultMemo: string;
  readonly demoSeed: number | null;
}

export interface JournalNote {
  readonly memo: string;
  readonly tags: readonly string[];
}

export interface JournalSummary {
  readonly count: number;
  readonly buyAmt: number;
  readonly sellAmt: number;
  readonly fee: number;
  readonly tax: number;
  readonly cost: number;
  readonly net: number;
  readonly retPct: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRate: number;
  readonly avgWin: number;
  readonly avgLoss: number;
  readonly rr: number;
  readonly swingCount: number;
  readonly mdd: number;
}

export interface JournalBar {
  readonly t: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  readonly day: string;
  readonly minutes: number;
}

export interface StoredDayExecutions {
  readonly day: string;
  readonly executions: readonly StoredExecutionRecord[];
}

export interface StoredExecutionRecord {
  readonly orderNo: string;
  readonly code: string;
  readonly name: string;
  readonly side: "buy" | "sell";
  readonly quantity: number;
  readonly price: number;
  readonly time: string;
  readonly venue: Venue;
  readonly mfePct: number | null;
  readonly maePct: number | null;
  readonly fillAt: number | null;
}

export interface SessionDef {
  readonly key: string;
  readonly short: string;
  readonly label: string;
}

export interface PairDef {
  readonly key: string;
  readonly label: string;
}

export const SESSIONS: readonly SessionDef[] = [
  { key: "s0800", short: "08–09", label: "08:00–09:00 (NXT 프리)" },
  { key: "s0900", short: "09–09:30", label: "09:00–09:30 (시초)" },
  { key: "s0930", short: "09:30–10", label: "09:30–10:00" },
  { key: "s1000", short: "10–11:30", label: "10:00–11:30" },
  { key: "s1130", short: "11:30–13:30", label: "11:30–13:30 (점심)" },
  { key: "s1330", short: "13:30–15:20", label: "13:30–15:20 (오후)" },
  { key: "s1520", short: "15:20–30", label: "15:20–15:30 (마감)" },
  { key: "s1540", short: "NXT후", label: "15:40–20:00 (NXT 애프터)" },
];

export const PAIRS: readonly PairDef[] = [
  { key: "open_open", label: "시초(09:00–30) → 시초 청산" },
  { key: "open_morn", label: "시초(09:00–30) → 오전 청산" },
  { key: "swing", label: "장중 진입 → 익일+ 스윙 청산" },
  { key: "morn_day", label: "오전(09:30–11:30) → 당일 청산" },
  { key: "lunch_day", label: "점심(11:30–13:30) → 당일 청산" },
  { key: "aft_close", label: "오후(13:30–15:30) → 마감 청산" },
  { key: "nxt", label: "NXT 프리·애프터 매매" },
];

export const HOLD_LABELS = ["5분 이하", "30분 이하", "2시간 이하", "당일 2시간+", "스윙 1~3일", "스윙 4일+"] as const;
export const STYLE_LABELS = ["단발 진입", "불타기 (상승 분할)", "물타기 (하락 분할)"] as const;
export const STYLE_SHORT = ["단발", "불타기", "물타기"] as const;
export const RET_EDGES = [-5, -3, -2, -1, 0, 1, 2, 3, 5] as const;
export const RET_LABELS = ["", "−5", "−3", "−2", "−1", "0", "1", "2", "3", "5"] as const;
export const RET_FULL = [
  "−5% 미만",
  "−5 ~ −3%",
  "−3 ~ −2%",
  "−2 ~ −1%",
  "−1 ~ 0%",
  "0 ~ +1%",
  "+1 ~ +2%",
  "+2 ~ +3%",
  "+3 ~ +5%",
  "+5% 이상",
] as const;
export const DEFAULT_TAGS = ["원칙준수", "돌파매매", "눌림목", "스윙", "종가베팅", "추격매수", "손절지연"] as const;

export const EMPTY_FILTERS: JournalFilters = {
  slot: null,
  pair: null,
  hold: null,
  ret: null,
  style: null,
  tag: null,
  sym: null,
};

export const TF_TO_PERIOD: Record<JournalTf, Period> = {
  "1": "1m",
  "5": "5m",
  D: "D",
};
