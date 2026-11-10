import type { BarField } from "../api/generated/BarField";
import type { ExcludeKind } from "../api/generated/ExcludeKind";
import type { KstDate } from "../api/generated/KstDate";
import type { NewHigh } from "../api/generated/NewHigh";
import type { Screen } from "../api/generated/Screen";
import type { ScreenerExcluded } from "../api/generated/ScreenerExcluded";
import type { ScreenerRow } from "../api/generated/ScreenerRow";
import type { ScreenerStatus } from "../api/generated/ScreenerStatus";
import type { ScreenPeriod } from "../api/generated/ScreenPeriod";
import type { UpdatePhase } from "../api/generated/UpdatePhase";

export const PERIOD_NAME: Record<ScreenPeriod, string> = { D: "일봉", W: "주봉", M: "월봉" };
const UNIT: Record<ScreenPeriod, string> = { D: "일", W: "주", M: "개월" };
const CURRENT_BAR: Record<ScreenPeriod, string> = { D: "당일", W: "이번 주", M: "이번 달" };
export const FIELD_LABEL: Record<BarField, string> = { open: "시가", high: "고가", low: "저가", close: "종가", volume: "거래량" };

export const EXCLUDE_LABEL: Record<ExcludeKind, string> = {
  etf: "ETF",
  preferred: "우선주",
  reit: "리츠",
  spac: "스팩",
  managed: "관리종목",
  investment_caution_alert: "투자주의환기종목",
  investment_warning: "투자경고",
  investment_danger: "투자위험",
  investment_caution: "투자주의",
  short_term_overheated: "단기과열",
  trading_halted: "거래정지",
};
const EXCLUDE_ORDER = Object.keys(EXCLUDE_LABEL) as ExcludeKind[];
export const excludedInOrder = (exclude: readonly ExcludeKind[]): ExcludeKind[] => EXCLUDE_ORDER.filter((k) => exclude.includes(k));

export const PHASE_LABEL: Record<UpdatePhase, string> = { symbols: "종목 목록 받기", recent: "최근 관측일 채우기", backfill: "과거 이력 이어 받기" };

const count = (n: number) => n.toLocaleString("ko-KR");

export function conditionSentence(period: ScreenPeriod, { field, n, m }: NewHigh): string {
  const volume = field === "volume";
  const subject = `${FIELD_LABEL[field]}${volume ? "이" : "가"}`;
  const record = `${count(n)}${UNIT[period]} ${volume ? "신고거래량" : "신고가"}`;
  if (m === 1) return `${CURRENT_BAR[period]} ${subject} ${record}${volume ? "이다" : "다"}`;
  return `최근 ${count(m)}${UNIT[period]} 안에 ${subject} ${record}인 봉이 있다`;
}

export function excludedText(screen: Screen, { listedTooShort, historyShort }: ScreenerExcluded): string {
  const longest = Math.max(...screen.conditions.map((c) => c.n));
  return `상장 ${count(longest)}${UNIT[screen.period]} 미만 ${count(listedTooShort)} · 이력 덜 참 ${count(historyShort)}`;
}

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"] as const;
const DAY_MS = 86_400_000;
const utcOf = (day: KstDate) => new Date(`${day}T00:00:00Z`);
const isoOf = (date: Date): KstDate => date.toISOString().slice(0, 10);
const sameYear = (a: KstDate, b: KstDate) => a.slice(0, 4) === b.slice(0, 4);

export function dayLabel(day: KstDate, reference: KstDate): string {
  return `${sameYear(day, reference) ? day.slice(5) : day}(${WEEKDAY[utcOf(day).getUTCDay()]})`;
}

function bucketStart(period: ScreenPeriod, day: KstDate): KstDate {
  if (period === "D") return day;
  if (period === "M") return `${day.slice(0, 7)}-01`;
  const date = utcOf(day);
  return isoOf(new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS));
}

export interface HighDateText {
  text: string;
  current: boolean;
}

export function highDateText(period: ScreenPeriod, highDate: KstDate, asOf: KstDate): HighDateText {
  if (bucketStart(period, highDate) === bucketStart(period, asOf)) return { text: CURRENT_BAR[period], current: true };
  const shown = sameYear(highDate, asOf) ? highDate.slice(5) : highDate;
  if (period === "D") return { text: shown, current: false };
  if (period === "W") return { text: `${shown} 주`, current: false };
  const month = `${Number(highDate.slice(5, 7))}월`;
  return { text: sameYear(highDate, asOf) ? month : `${highDate.slice(0, 4)}년 ${month}`, current: false };
}

export type ResultSortKey = "name" | "close" | "changeRate" | "highDate";

export interface ResultSort {
  key: ResultSortKey;
  descending: boolean;
}

export const DEFAULT_SORT: ResultSort = { key: "highDate", descending: true };

const FIRST_DESCENDING: Record<ResultSortKey, boolean> = { name: false, close: true, changeRate: true, highDate: true };

export const nextSort = (sort: ResultSort, key: ResultSortKey): ResultSort =>
  sort.key === key ? { key, descending: !sort.descending } : { key, descending: FIRST_DESCENDING[key] };

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const COMPARE: Record<ResultSortKey, (a: ScreenerRow, b: ScreenerRow) => number> = {
  name: (a, b) => a.name.localeCompare(b.name, "ko"),
  close: (a, b) => a.close - b.close,
  changeRate: (a, b) => (a.changeRate ?? 0) - (b.changeRate ?? 0),
  highDate: (a, b) => byText(a.highDate, b.highDate),
};

export function sortRows(rows: readonly ScreenerRow[], { key, descending }: ResultSort): ScreenerRow[] {
  const sign = descending ? -1 : 1;
  const unknownLast = (a: ScreenerRow, b: ScreenerRow) => (key === "changeRate" ? Number(a.changeRate === null) - Number(b.changeRate === null) : 0);
  return [...rows].sort((a, b) => unknownLast(a, b) || sign * COMPARE[key](a, b) || byText(a.symbol, b.symbol));
}

export type RunBlock = "empty" | "missing_day" | "updating";

export const isUpdating = (status: ScreenerStatus | undefined): boolean => !!status?.update && status.update.error === null;

export function runBlock(status: ScreenerStatus): RunBlock | null {
  if (isUpdating(status) && status.update?.phase === "recent") return "updating";
  if (status.lastDay === null) return "empty";
  if (status.needDay !== null && status.lastDay < status.needDay) return "missing_day";
  return null;
}

export const showsUpdateBand = (status: ScreenerStatus): boolean => status.update !== null || runBlock(status) !== null;

const KST_OFFSET_MS = 9 * 3_600_000;
const CLOSE_MS = 20 * 3_600_000;
const SETTLE_MS = 5_000;

export function msUntilStatusTurns(now: number): number {
  const sinceMidnight = (now + KST_OFFSET_MS) % DAY_MS;
  return (sinceMidnight < CLOSE_MS ? CLOSE_MS : DAY_MS) - sinceMidnight + SETTLE_MS;
}

export const todayNotStored = (status: ScreenerStatus): boolean =>
  status.todayAvailable && (status.lastDay === null || status.needDay === null || status.lastDay <= status.needDay);
