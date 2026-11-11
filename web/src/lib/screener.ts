import type { ApiErrorBody } from "../api/generated/ApiErrorBody";
import type { BarField } from "../api/generated/BarField";
import type { BollingerBand } from "../api/generated/BollingerBand";
import type { Bound } from "../api/generated/Bound";
import type { Condition } from "../api/generated/Condition";
import type { Direction } from "../api/generated/Direction";
import type { ExcludeKind } from "../api/generated/ExcludeKind";
import type { Extreme } from "../api/generated/Extreme";
import type { KstDate } from "../api/generated/KstDate";
import type { MaMethod } from "../api/generated/MaMethod";
import type { MaOrder } from "../api/generated/MaOrder";
import type { Market } from "../api/generated/Market";
import type { Screen } from "../api/generated/Screen";
import type { ScreenerExcluded } from "../api/generated/ScreenerExcluded";
import type { ScreenerRow } from "../api/generated/ScreenerRow";
import type { ScreenerStatus } from "../api/generated/ScreenerStatus";
import type { ScreenPeriod } from "../api/generated/ScreenPeriod";
import type { Side } from "../api/generated/Side";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import type { UpdatePhase } from "../api/generated/UpdatePhase";
import { KINDS } from "../chart/indicators/kinds";
import { formatKstClockSeconds } from "../chart/time";
import { MINUS } from "./format";

export const PERIOD_NAME: Record<ScreenPeriod, string> = { D: "일봉", W: "주봉", M: "월봉" };
export const UNIT: Record<ScreenPeriod, string> = { D: "일", W: "주", M: "개월" };
const CURRENT_BAR: Record<ScreenPeriod, string> = { D: "당일", W: "이번 주", M: "이번 달" };
export const FIELD_LABEL: Record<BarField, string> = { open: "시가", high: "고가", low: "저가", close: "종가", volume: "거래량", traded_value: "거래대금" };
export const NEW_HIGH_NAME: Record<BarField, string> = { open: "신고가", high: "신고가", low: "신고가", close: "신고가", volume: "신고거래량", traded_value: "신고거래대금" };
export const NEW_LOW_NAME: Record<BarField, string> = { open: "신저가", high: "신저가", low: "신저가", close: "신저가", volume: "신저거래량", traded_value: "신저거래대금" };
export const VALUE_UNIT: Record<BarField, string> = { open: "원", high: "원", low: "원", close: "원", volume: "주", traded_value: "억 원" };

export type ConditionKind = Condition["kind"];

export const NO_CONDITIONS_SENTENCE = "조건 없음 · 대상 종목 전체";

export const KIND_LABEL: Record<ConditionKind, string> = {
  new_high: "신고가",
  new_low: "신저가",
  value_range: "값 범위",
  change: "등락률",
  near_extreme: "고점·저점 거리",
  surge: "거래 급증",
  ma_position: "이평 위치",
  ma_alignment: "이평 배열",
  ma_cross: "이평 교차",
  rsi: "RSI",
  macd: "MACD",
  stochastic: "스토캐스틱",
  bollinger: "볼린저 밴드",
  ichimoku: "일목균형표",
  market_cap: "시가총액",
};
export const MARKET_LABEL: Record<Market, string> = { kospi: "코스피", kosdaq: "코스닥" };
export const MA_METHOD_LABEL: Record<MaMethod, string> = { sma: "단순", ema: "지수" };
export const MA_ORDER_LABEL: Record<MaOrder, string> = { bullish: "정배열", bearish: "역배열" };
export const SIDE_LABEL: Record<Side, string> = { above: "위", below: "아래" };
export const DIRECTION_LABEL: Record<Direction, string> = { up: "위로", down: "아래로" };
export const EXTREME_LABEL: Record<Extreme, string> = { high: "최고가", low: "최저가" };
export const BAND_LABEL: Record<BollingerBand, string> = { upper: "상단", lower: "하단" };
export const EOK = 100_000_000;

export type NewHighCondition = Extract<Condition, { kind: "new_high" }>;

export const newHighLines = (screen: Screen): NewHighCondition[] => screen.conditions.filter((c): c is NewHighCondition => c.kind === "new_high");

type BarCondition = Exclude<Condition, { kind: "market_cap" }>;

export const screenPeriod = (screen: Screen): ScreenPeriod => screen.conditions.find((c): c is BarCondition => c.kind !== "market_cap")?.period ?? "D";

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

const MARKET_ORDER = Object.keys(MARKET_LABEL) as Market[];
export const marketsInOrder = (markets: readonly Market[]): Market[] => MARKET_ORDER.filter((m) => markets.includes(m));

export const PHASE_LABEL: Record<UpdatePhase, string> = { symbols: "종목 목록 받기", recent: "최근 관측일 채우기", backfill: "과거 이력 이어 받기" };

const count = (n: number) => n.toLocaleString("ko-KR");
const decimal = (n: number) => n.toLocaleString("ko-KR", { maximumFractionDigits: 8 });
const signedPercent = (n: number) => `${n > 0 ? "+" : n < 0 ? MINUS : ""}${decimal(Math.abs(n))}%`;
const won = (n: number) => `${decimal(n)}원`;
const eokWon = (n: number) => `${decimal(n / EOK)}억 원`;
const VALUE_TEXT: Record<BarField, (n: number) => string> = {
  open: won,
  high: won,
  low: won,
  close: won,
  volume: (n) => `${decimal(n)}주`,
  traded_value: eokWon,
};

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
const DIGIT_HAS_FINAL = "1011001110";
const LETTERS_WITH_FINAL = "LMNR";

function endsWithFinalConsonant(word: string): boolean {
  const bare = word.endsWith(")") ? word.slice(0, word.lastIndexOf("(")) : word;
  const last = bare.at(-1) ?? "";
  const code = last.charCodeAt(0);
  if (code >= HANGUL_FIRST && code <= HANGUL_LAST) return (code - HANGUL_FIRST) % 28 !== 0;
  if (last >= "0" && last <= "9") return DIGIT_HAS_FINAL[Number(last)] === "1";
  return LETTERS_WITH_FINAL.includes(last.toUpperCase());
}

const subject = (word: string) => `${word}${endsWithFinalConsonant(word) ? "이" : "가"}`;
const object = (word: string) => `${word}${endsWithFinalConsonant(word) ? "을" : "를"}`;
const copula = (word: string) => `${word}${endsWithFinalConsonant(word) ? "이다" : "다"}`;

function range(min: Bound, max: Bound, text: (n: number) => string): string {
  const ends = [min === null ? null : `${text(min)} 이상`, max === null ? null : `${text(max)} 이하`];
  return ends.filter((end) => end !== null).join(" ");
}

type Claim = { state: string } | { event: string };

const maName = (method: MaMethod) => (method === "sma" ? "이동평균" : "지수 이동평균");
const settings = (...values: number[]) => `(${values.map(decimal).join("·")})`;
const ICHIMOKU_DEFAULT = KINDS.ichimoku.defaults;

function claimOf(condition: BarCondition): Claim {
  const bars = (n: number) => `${count(n)}${UNIT[condition.period]}`;
  switch (condition.kind) {
    case "new_high":
      return { state: `${subject(FIELD_LABEL[condition.field])} ${bars(condition.n)} ${NEW_HIGH_NAME[condition.field]}` };
    case "new_low":
      return { state: `${subject(FIELD_LABEL[condition.field])} ${bars(condition.n)} ${NEW_LOW_NAME[condition.field]}` };
    case "value_range":
      return { state: `${subject(FIELD_LABEL[condition.field])} ${range(condition.min, condition.max, VALUE_TEXT[condition.field])}` };
    case "change":
      return { state: `${subject("종가")} ${bars(condition.back)} 전보다 ${range(condition.minPct, condition.maxPct, signedPercent)}` };
    case "near_extreme":
      return { state: `${subject("종가")} ${bars(condition.n)} ${EXTREME_LABEL[condition.extreme]}에서 ${decimal(condition.withinPct)}% 안` };
    case "surge":
      return { state: `${subject(FIELD_LABEL[condition.field])} 직전 ${bars(condition.n)} 평균의 ${decimal(condition.times)}배 이상` };
    case "ma_position":
      return { state: `${subject(FIELD_LABEL[condition.field])} ${bars(condition.length)} ${maName(condition.method)} ${SIDE_LABEL[condition.side]}` };
    case "ma_alignment": {
      const lines = `${condition.lengths.map(count).join("·")}${UNIT[condition.period]} ${maName(condition.method)}`;
      return { state: `${subject(lines)} ${MA_ORDER_LABEL[condition.order]}` };
    }
    case "ma_cross": {
      const line = (length: number) => (condition.method === "sma" ? `${bars(length)}선` : `${bars(length)} ${maName(condition.method)}`);
      const fast = condition.fast === null ? "종가" : line(condition.fast);
      return { event: `${subject(fast)} ${object(line(condition.slow))} ${DIRECTION_LABEL[condition.direction]} 교차` };
    }
    case "rsi": {
      const rsi = `RSI${settings(condition.length)}`;
      const { test } = condition;
      if (test.kind === "range") return { state: `${subject(rsi)} ${range(test.min, test.max, decimal)}` };
      return { event: `${subject(rsi)} ${object(decimal(test.value))} ${DIRECTION_LABEL[test.direction]} 돌파` };
    }
    case "macd": {
      const macd = subject(`MACD${settings(condition.fast, condition.slow, condition.signal)}`);
      const { test } = condition;
      if (test.kind === "signal_cross") return { event: `${macd} 시그널을 ${DIRECTION_LABEL[test.direction]} 교차` };
      if (test.kind === "zero_breakout") return { event: `${macd} 0선을 ${DIRECTION_LABEL[test.direction]} 돌파` };
      return { state: `${macd} 시그널 ${SIDE_LABEL[test.side]}` };
    }
    case "stochastic": {
      const k = subject(`스토캐스틱${settings(condition.k, condition.d, condition.smooth)} %K`);
      const { test } = condition;
      if (test.kind === "cross") return { event: `${k} %D를 ${DIRECTION_LABEL[test.direction]} 교차` };
      return { state: `${k} ${range(test.min, test.max, decimal)}` };
    }
    case "bollinger": {
      const band = `볼린저 밴드${settings(condition.length, condition.k)}`;
      const { test } = condition;
      if (test.kind === "outside") return { state: `${subject("종가")} ${band} ${test.side === "above" ? "상단 위" : "하단 아래"}` };
      return { event: `${subject("종가")} ${object(`${band} ${BAND_LABEL[test.band]}`)} ${DIRECTION_LABEL[test.direction]} 교차` };
    }
    case "ichimoku": {
      const { conversion, base, spanB, displacement, test } = condition;
      const chartDefault =
        conversion === ICHIMOKU_DEFAULT.conversion && base === ICHIMOKU_DEFAULT.base && spanB === ICHIMOKU_DEFAULT.spanB && displacement === ICHIMOKU_DEFAULT.displacement;
      const ichimoku = chartDefault ? "일목" : `일목${settings(conversion, base, spanB, displacement)}`;
      if (test.kind === "cloud") return { state: `${subject("종가")} ${ichimoku} 구름 ${SIDE_LABEL[test.side]}` };
      return { event: `${ichimoku} ${subject("전환선")} 기준선을 ${DIRECTION_LABEL[test.direction]} 교차` };
    }
  }
}

export function conditionSentence(condition: Condition): string {
  if (condition.kind === "market_cap") return `시가총액이 ${copula(range(condition.min, condition.max, eokWon))}`;
  const claim = claimOf(condition);
  const { period, m } = condition;
  if (m === 1) return `${CURRENT_BAR[period]} ${"state" in claim ? copula(claim.state) : `${claim.event}했다`}`;
  return `최근 ${count(m)}${UNIT[period]} 안에 ${"state" in claim ? `${claim.state}인` : `${claim.event}한`} 봉이 있다`;
}

export function excludedText({ listedTooShort, historyShort, unconfirmed }: ScreenerExcluded): string {
  const counted = `상장 기간 부족 ${count(listedTooShort)} · 이력 덜 참 ${count(historyShort)}`;
  return unconfirmed > 0 ? `${counted} · 확인 안 됨 ${count(unconfirmed)}` : counted;
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

export interface MatchedDateText {
  text: string;
  current: boolean;
}

export function matchedDateText(screen: Screen, matchedDate: KstDate, asOf: KstDate): MatchedDateText {
  const period = screenPeriod(screen);
  if (bucketStart(period, matchedDate) === bucketStart(period, asOf)) return { text: CURRENT_BAR[period], current: true };
  const shown = sameYear(matchedDate, asOf) ? matchedDate.slice(5) : matchedDate;
  if (period === "D") return { text: shown, current: false };
  if (period === "W") return { text: `${shown} 주`, current: false };
  const month = `${Number(matchedDate.slice(5, 7))}월`;
  return { text: sameYear(matchedDate, asOf) ? month : `${matchedDate.slice(0, 4)}년 ${month}`, current: false };
}

export type ResultSortKey = "name" | "close" | "changeRate" | "matchedDate";

export interface ResultSort {
  key: ResultSortKey;
  descending: boolean;
}

export const DEFAULT_SORT: ResultSort = { key: "matchedDate", descending: true };

const FIRST_DESCENDING: Record<ResultSortKey, boolean> = { name: false, close: true, changeRate: true, matchedDate: true };

export const nextSort = (sort: ResultSort, key: ResultSortKey): ResultSort =>
  sort.key === key ? { key, descending: !sort.descending } : { key, descending: FIRST_DESCENDING[key] };

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const COMPARE: Record<ResultSortKey, (a: ScreenerRow, b: ScreenerRow) => number> = {
  name: (a, b) => a.name.localeCompare(b.name, "ko"),
  close: (a, b) => a.close - b.close,
  changeRate: (a, b) => (a.changeRate ?? 0) - (b.changeRate ?? 0),
  matchedDate: (a, b) => byText(a.matchedDate, b.matchedDate),
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

export type StatusFooter =
  | { kind: "reading" }
  | { kind: "unreadable"; message: string; stale: boolean }
  | { kind: "store"; lastDay: KstDate }
  | { kind: "none" };

export function statusFooter(status: ScreenerStatus | undefined, error: Error | null): StatusFooter {
  if (error) return { kind: "unreadable", message: error.message, stale: status !== undefined };
  if (!status) return { kind: "reading" };
  if (showsUpdateBand(status) || status.lastDay === null) return { kind: "none" };
  return { kind: "store", lastDay: status.lastDay };
}

export const todayConfirmed = ({ todayAvailable, lastDay, needDay }: ScreenerStatus): boolean =>
  todayAvailable || (lastDay !== null && needDay !== null && lastDay > needDay);

export type UpdateRetry = { kind: "operator" } | { kind: "ready"; note: string } | { kind: "waiting"; opensAt: UnixSeconds; from: string; note: string };

const endOfSecond = (retryAt: UnixSeconds): UnixSeconds => retryAt + 1;

export function updateRetry({ retryAt, manualActionRequired }: ApiErrorBody, serverNow: number): UpdateRetry {
  if (manualActionRequired) return { kind: "operator" };
  const opensAt = retryAt === null ? null : endOfSecond(retryAt);
  if (opensAt !== null && opensAt * 1000 > serverNow) {
    const from = `${formatKstClockSeconds(opensAt)}부터`;
    return { kind: "waiting", opensAt, from, note: `${from} 다시 시도할 수 있습니다.` };
  }
  return { kind: "ready", note: "다시 시도하면 남은 것만 받습니다." };
}
