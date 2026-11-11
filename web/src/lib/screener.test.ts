import { expect, test } from "vitest";
import type { BarField } from "../api/generated/BarField";
import type { Screen } from "../api/generated/Screen";
import type { ScreenPeriod } from "../api/generated/ScreenPeriod";
import type { ScreenerRow } from "../api/generated/ScreenerRow";
import type { ScreenerStatus } from "../api/generated/ScreenerStatus";
import {
  conditionSentence,
  dayLabel,
  DEFAULT_SORT,
  excludedInOrder,
  excludedText,
  marketsInOrder,
  matchedDateText,
  msUntilStatusTurns,
  nextSort,
  runBlock,
  screenPeriod,
  showsUpdateBand,
  sortRows,
  statusFooter,
  todayConfirmed,
  updateRetry,
} from "./screener";

const newHigh = (period: ScreenPeriod, field: BarField, n: number, m: number) => ({ kind: "new_high", period, m, field, n }) as const;
const screenOf = (conditions: Screen["conditions"]): Screen => ({ id: "s", name: "s", markets: [], exclude: [], conditions });
const marketCap = { kind: "market_cap", min: 300_000_000_000, max: null } as const;

test("조건 문장은 그 줄의 봉 주기 단위와 M이 1인지에 따라 바뀐다", () => {
  expect(conditionSentence(newHigh("D", "high", 200, 5))).toBe("최근 5일 안에 고가가 200일 신고가인 봉이 있다");
  expect(conditionSentence(newHigh("D", "volume", 60, 1))).toBe("당일 거래량이 60일 신고거래량이다");
  expect(conditionSentence(newHigh("W", "close", 52, 1))).toBe("이번 주 종가가 52주 신고가다");
  expect(conditionSentence(newHigh("M", "low", 12, 3))).toBe("최근 3개월 안에 저가가 12개월 신고가인 봉이 있다");
  expect(conditionSentence(newHigh("W", "volume", 104, 8))).toBe("최근 8주 안에 거래량이 104주 신고거래량인 봉이 있다");
  expect(conditionSentence(newHigh("D", "open", 1200, 20))).toBe("최근 20일 안에 시가가 1,200일 신고가인 봉이 있다");
  expect(conditionSentence(newHigh("D", "traded_value", 250, 1))).toBe("당일 거래대금이 250일 신고거래대금이다");
});

test("조건식의 봉 주기는 봉으로 따지는 첫 줄의 것이다", () => {
  expect(screenPeriod(screenOf([newHigh("W", "high", 52, 1), newHigh("D", "close", 20, 1)]))).toBe("W");
  expect(screenPeriod(screenOf([marketCap, newHigh("M", "high", 12, 1)]))).toBe("M");
  expect(screenPeriod(screenOf([{ kind: "market_cap", min: null, max: 100_000_000_000 }]))).toBe("D");
});

test("제외 목록은 저장 순서와 상관없이 종류, 상태 순으로 보인다", () => {
  expect(excludedInOrder(["trading_halted", "etf", "managed", "spac"])).toEqual(["etf", "spac", "managed", "trading_halted"]);
  expect(excludedInOrder([])).toEqual([]);
});

test("시장 칩은 저장 순서와 상관없이 코스피, 코스닥 순으로 보인다", () => {
  expect(marketsInOrder(["kosdaq", "kospi"])).toEqual(["kospi", "kosdaq"]);
  expect(marketsInOrder(["kosdaq"])).toEqual(["kosdaq"]);
  expect(marketsInOrder([])).toEqual([]);
});

test("빠진 종목 수는 상장 기간 부족, 이력 덜 참 순이고, 확인 안 됨은 있을 때만 붙는다", () => {
  expect(excludedText({ listedTooShort: 14, historyShort: 1120, unconfirmed: 0 })).toBe("상장 기간 부족 14 · 이력 덜 참 1,120");
  expect(excludedText({ listedTooShort: 0, historyShort: 0, unconfirmed: 0 })).toBe("상장 기간 부족 0 · 이력 덜 참 0");
  expect(excludedText({ listedTooShort: 14, historyShort: 1120, unconfirmed: 1203 })).toBe("상장 기간 부족 14 · 이력 덜 참 1,120 · 확인 안 됨 1,203");
});

test("날짜는 기준과 같은 해면 연도를 빼고 요일을 붙인다", () => {
  expect(dayLabel("2026-11-10", "2026-11-11")).toBe("11-10(화)");
  expect(dayLabel("2025-12-30", "2026-01-02")).toBe("2025-12-30(화)");
});

test("맞은 날짜가 기준 관측일의 봉이면 당일·이번 주·이번 달로 보인다", () => {
  const daily = screenOf([newHigh("D", "high", 200, 1)]);
  expect(matchedDateText(daily, "2026-11-10", "2026-11-10")).toEqual({ text: "당일", current: true });
  expect(matchedDateText(daily, "2026-11-06", "2026-11-10")).toEqual({ text: "11-06", current: false });
  expect(matchedDateText(daily, "2025-12-30", "2026-01-02")).toEqual({ text: "2025-12-30", current: false });

  const weekly = screenOf([newHigh("W", "close", 52, 1)]);
  expect(matchedDateText(weekly, "2026-11-09", "2026-11-11")).toEqual({ text: "이번 주", current: true });
  expect(matchedDateText(weekly, "2025-12-29", "2026-01-02")).toEqual({ text: "이번 주", current: true });
  expect(matchedDateText(weekly, "2026-11-02", "2026-11-11")).toEqual({ text: "11-02 주", current: false });

  const monthly = screenOf([newHigh("M", "low", 12, 1)]);
  expect(matchedDateText(monthly, "2026-11-02", "2026-11-10")).toEqual({ text: "이번 달", current: true });
  expect(matchedDateText(monthly, "2026-10-01", "2026-11-10")).toEqual({ text: "10월", current: false });
  expect(matchedDateText(monthly, "2025-12-01", "2026-01-05")).toEqual({ text: "2025년 12월", current: false });
});

test("맞은 날짜는 봉으로 따지는 첫 줄의 봉 주기로 보이고, 그런 줄이 없으면 일봉으로 보인다", () => {
  const weeklyFirst = screenOf([newHigh("W", "close", 52, 1), newHigh("D", "volume", 20, 1)]);
  expect(matchedDateText(weeklyFirst, "2026-11-09", "2026-11-11")).toEqual({ text: "이번 주", current: true });
  expect(matchedDateText(weeklyFirst, "2026-11-02", "2026-11-11")).toEqual({ text: "11-02 주", current: false });

  const dailyFirst = screenOf([newHigh("D", "volume", 20, 1), newHigh("W", "close", 52, 1)]);
  expect(matchedDateText(dailyFirst, "2026-11-09", "2026-11-11")).toEqual({ text: "11-09", current: false });

  const capFirst = screenOf([marketCap, newHigh("M", "high", 12, 1)]);
  expect(matchedDateText(capFirst, "2026-11-02", "2026-11-10")).toEqual({ text: "이번 달", current: true });

  const capOnly = screenOf([marketCap]);
  expect(matchedDateText(capOnly, "2026-11-10", "2026-11-10")).toEqual({ text: "당일", current: true });
  expect(matchedDateText(capOnly, "2026-11-09", "2026-11-10")).toEqual({ text: "11-09", current: false });
});

const row = (symbol: string, name: string, close: number, changeRate: number | null, matchedDate: string): ScreenerRow => ({
  symbol,
  name,
  close,
  changeRate,
  matchedDate,
});
const rows: readonly ScreenerRow[] = [
  row("000100", "나", 5000, 1.5, "2026-11-10"),
  row("000200", "가", 7000, null, "2026-11-06"),
  row("000300", "다", 3000, -2, "2026-11-10"),
  row("000050", "라", 7000, 3, "2026-11-06"),
];
const order = (sorted: readonly ScreenerRow[]) => sorted.map((r) => r.symbol);

test("결과는 기본으로 맞은 날짜 최신순이고, 같으면 종목코드 순이다", () => {
  expect(order(sortRows(rows, DEFAULT_SORT))).toEqual(["000100", "000300", "000050", "000200"]);
});

test("열을 바꿔 정렬해도 같은 값은 종목코드 순이고, 등락률이 없는 행은 늘 끝이다", () => {
  expect(order(sortRows(rows, { key: "close", descending: true }))).toEqual(["000050", "000200", "000100", "000300"]);
  expect(order(sortRows(rows, { key: "changeRate", descending: true }))).toEqual(["000050", "000100", "000300", "000200"]);
  expect(order(sortRows(rows, { key: "changeRate", descending: false }))).toEqual(["000300", "000100", "000050", "000200"]);
  expect(order(sortRows(rows, { key: "name", descending: false }))).toEqual(["000200", "000100", "000300", "000050"]);
  expect(order(rows)).toEqual(["000100", "000200", "000300", "000050"]);
});

test("같은 열 머리를 다시 누르면 방향이 뒤집히고, 새 열은 이름만 오름차순으로 시작한다", () => {
  const byClose = nextSort(DEFAULT_SORT, "close");
  expect(byClose).toEqual({ key: "close", descending: true });
  expect(nextSort(byClose, "close")).toEqual({ key: "close", descending: false });
  expect(nextSort(byClose, "name")).toEqual({ key: "name", descending: false });
  expect(nextSort(DEFAULT_SORT, "matchedDate")).toEqual({ key: "matchedDate", descending: false });
});

const ready: ScreenerStatus = {
  lastDay: "2026-11-10",
  needDay: "2026-11-10",
  todayAvailable: false,
  fullHistory: { done: 3960, total: 3960 },
  unconfirmed: 0,
  update: null,
};
const running = (phase: "symbols" | "recent" | "backfill") => ({ phase, done: 12, total: 3960, error: null, full: false });
const stopped = {
  ...running("recent"),
  error: { code: "kiwoom_unavailable" as const, message: "키움 조회가 응답하지 않습니다", reason: "kiwoom_error" as const, retryAt: null, manualActionRequired: false },
};

test("실행은 빈 저장소, 직전 관측일이 없는 저장소, 최근 채우기 중에만 막힌다", () => {
  expect(runBlock(ready)).toBeNull();
  expect(runBlock({ ...ready, lastDay: null })).toBe("empty");
  expect(runBlock({ ...ready, lastDay: "2026-11-06" })).toBe("missing_day");
  expect(runBlock({ ...ready, update: running("recent") })).toBe("updating");
  expect(runBlock({ ...ready, update: running("backfill") })).toBeNull();
  expect(runBlock({ ...ready, update: stopped })).toBeNull();
  expect(runBlock({ ...ready, lastDay: "2026-11-06", update: stopped })).toBe("missing_day");
  expect(runBlock({ ...ready, needDay: null })).toBeNull();
});

test("위쪽 띠는 업데이트가 돌거나 멈췄을 때와 실행이 막혔을 때만 보인다", () => {
  expect(showsUpdateBand(ready)).toBe(false);
  expect(showsUpdateBand({ ...ready, update: running("backfill") })).toBe(true);
  expect(showsUpdateBand({ ...ready, update: stopped })).toBe(true);
  expect(showsUpdateBand({ ...ready, lastDay: null })).toBe(true);
  expect(showsUpdateBand({ ...ready, lastDay: "2026-11-06" })).toBe(true);
});

test("멈춘 업데이트의 다시 시도는 서버가 준 시각의 그 초가 다 지나야 열린다", () => {
  const kst = (clock: string) => Date.parse(`2026-11-11T${clock}+09:00`);
  const gated = { ...stopped.error, retryAt: kst("10:42:30") / 1000 };
  const ready = { kind: "ready", note: "다시 시도하면 남은 것만 받습니다." };
  expect(updateRetry(gated, kst("10:42:00"))).toEqual({ kind: "waiting", opensAt: kst("10:42:31") / 1000, from: "10:42:31부터", note: "10:42:31부터 다시 시도할 수 있습니다." });
  expect(updateRetry(gated, kst("10:42:30.999"))).toMatchObject({ kind: "waiting" });
  expect(updateRetry(gated, kst("10:42:31"))).toEqual(ready);
  expect(updateRetry(gated, kst("10:45:00"))).toEqual(ready);
});

test("서버가 다시 시도할 시각을 주지 않았으면 바로 다시 시도할 수 있다", () => {
  expect(updateRetry(stopped.error, Date.parse("2026-11-11T10:42:00+09:00"))).toEqual({ kind: "ready", note: "다시 시도하면 남은 것만 받습니다." });
});

test("운영자가 확인해야 하는 오류는 시각과 상관없이 다시 시도를 내밀지 않는다", () => {
  const now = Date.parse("2026-11-11T10:42:00+09:00");
  const operator = { ...stopped.error, manualActionRequired: true };
  expect(updateRetry(operator, now)).toEqual({ kind: "operator" });
  expect(updateRetry({ ...operator, retryAt: now / 1000 + 30 }, now)).toEqual({ kind: "operator" });
});

test("오늘 봉은 오늘 자료를 받을 수 있거나 이미 받았을 때 확정이다", () => {
  expect(todayConfirmed({ ...ready, todayAvailable: true })).toBe(true);
  expect(todayConfirmed({ ...ready, todayAvailable: true, lastDay: null })).toBe(true);
  expect(todayConfirmed({ ...ready, lastDay: "2026-11-11" })).toBe(true);
  expect(todayConfirmed({ ...ready, lastDay: "2026-11-11", needDay: null })).toBe(false);
  expect(todayConfirmed(ready)).toBe(false);
});

test("대기 중 다음 상태 조회는 KST 20:00이나 자정에서 5초 뒤다", () => {
  const at = (kst: string) => Date.parse(`${kst}+09:00`);
  expect(msUntilStatusTurns(at("2026-11-11T19:59:00"))).toBe(65_000);
  expect(msUntilStatusTurns(at("2026-11-11T20:00:00"))).toBe(4 * 3_600_000 + 5_000);
  expect(msUntilStatusTurns(at("2026-11-11T23:59:00"))).toBe(65_000);
  expect(msUntilStatusTurns(at("2026-11-12T00:00:00"))).toBe(20 * 3_600_000 + 5_000);
});

test("아래 줄은 상태 조회가 실패하면 읽어 둔 상태가 있어도 오류를 보이고, 띠가 보이면 비운다", () => {
  const failed = new Error("서버에 연결하지 못했습니다");
  expect(statusFooter(undefined, null)).toEqual({ kind: "reading" });
  expect(statusFooter(undefined, failed)).toEqual({ kind: "unreadable", message: "서버에 연결하지 못했습니다", stale: false });
  expect(statusFooter(ready, failed)).toEqual({ kind: "unreadable", message: "서버에 연결하지 못했습니다", stale: true });
  expect(statusFooter(ready, null)).toEqual({ kind: "store", lastDay: "2026-11-10" });
  expect(statusFooter({ ...ready, update: running("backfill") }, null)).toEqual({ kind: "none" });
  expect(statusFooter({ ...ready, update: running("backfill") }, failed)).toMatchObject({ kind: "unreadable", stale: true });
});
