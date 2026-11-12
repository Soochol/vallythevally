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

const newHigh = (period: ScreenPeriod, field: BarField, n: number, m: number) => ({ kind: "new_high", period, barRange: { start: 0, end: m - 1 }, field, n }) as const;
const screenOf = (conditions: Screen["conditions"]): Screen => ({ id: "s", name: "s", markets: [], exclude: [], conditions });
const marketCap = { kind: "market_cap", min: 300_000_000_000, max: null } as const;

test("조건 문장은 그 줄의 봉 주기 단위와 M이 1인지에 따라 바뀐다", () => {
  expect(conditionSentence(newHigh("D", "high", 200, 5))).toBe("일봉 0~4봉 전 안에 고가가 200일 신고가인 봉이 있다");
  expect(conditionSentence(newHigh("D", "volume", 60, 1))).toBe("일봉 0봉 전 거래량이 60일 신고거래량이다");
  expect(conditionSentence(newHigh("W", "close", 52, 1))).toBe("주봉 0봉 전 종가가 52주 신고가다");
  expect(conditionSentence(newHigh("M", "low", 12, 3))).toBe("월봉 0~2봉 전 안에 저가가 12개월 신고가인 봉이 있다");
  expect(conditionSentence(newHigh("W", "volume", 104, 8))).toBe("주봉 0~7봉 전 안에 거래량이 104주 신고거래량인 봉이 있다");
  expect(conditionSentence(newHigh("D", "open", 1200, 20))).toBe("일봉 0~19봉 전 안에 시가가 1,200일 신고가인 봉이 있다");
  expect(conditionSentence(newHigh("D", "traded_value", 250, 1))).toBe("일봉 0봉 전 거래대금이 250일 신고거래대금이다");
});

test("스펙의 문장 예는 그대로 나온다", () => {
  expect(conditionSentence({ kind: "value_range", period: "D", barRange: { start: 0, end: 0 }, field: "traded_value", min: 10_000_000_000, max: null })).toBe("일봉 0봉 전 거래대금이 100억 원 이상이다");
  expect(conditionSentence({ kind: "change", period: "D", barRange: { start: 0, end: 0 }, back: 20, minPct: 30, maxPct: null })).toBe("일봉 0봉 전 종가가 20일 전보다 +30% 이상이다");
  expect(conditionSentence({ kind: "near_extreme", period: "D", barRange: { start: 0, end: 0 }, extreme: "high", n: 200, withinPct: 5 })).toBe("일봉 0봉 전 종가가 200일 최고가에서 5% 안이다");
  expect(conditionSentence({ kind: "surge", period: "D", barRange: { start: 0, end: 0 }, field: "volume", n: 20, times: 3 })).toBe("일봉 0봉 전 거래량이 직전 20일 평균의 3배 이상이다");
  expect(conditionSentence({ kind: "ma_position", period: "D", barRange: { start: 0, end: 0 }, field: "close", method: "sma", length: 20, side: "above" })).toBe("일봉 0봉 전 종가가 20일 이동평균 위다");
  expect(conditionSentence({ kind: "ma_alignment", period: "D", barRange: { start: 0, end: 0 }, method: "sma", lengths: [5, 20, 60, 120], order: "bullish" })).toBe("일봉 0봉 전 5·20·60·120일 이동평균이 정배열이다");
  expect(conditionSentence({ kind: "ma_cross", period: "D", barRange: { start: 0, end: 4 }, method: "sma", fast: 5, slow: 20, direction: "up" })).toBe("일봉 0~4봉 전 안에 5일선이 20일선을 위로 교차한 봉이 있다");
  expect(conditionSentence({ kind: "rsi", period: "D", barRange: { start: 0, end: 2 }, length: 14, test: { kind: "breakout", value: 30, direction: "up" } })).toBe("일봉 0~2봉 전 안에 RSI(14)가 30을 위로 돌파한 봉이 있다");
  const ichimoku = { conversion: 9, base: 26, spanB: 52, displacement: 26 };
  expect(conditionSentence({ kind: "ichimoku", period: "D", barRange: { start: 0, end: 0 }, ...ichimoku, test: { kind: "cloud", side: "above" } })).toBe("일봉 0봉 전 종가가 일목 구름 위다");
  expect(conditionSentence({ kind: "market_cap", min: 300_000_000_000, max: null })).toBe("시가총액이 3,000억 원 이상이다");
});

test("신저가 문장은 값에 따라 신저가·신저거래량·신저거래대금이다", () => {
  expect(conditionSentence({ kind: "new_low", period: "W", barRange: { start: 0, end: 0 }, field: "close", n: 52 })).toBe("주봉 0봉 전 종가가 52주 신저가다");
  expect(conditionSentence({ kind: "new_low", period: "D", barRange: { start: 0, end: 4 }, field: "volume", n: 60 })).toBe("일봉 0~4봉 전 안에 거래량이 60일 신저거래량인 봉이 있다");
  expect(conditionSentence({ kind: "new_low", period: "M", barRange: { start: 0, end: 0 }, field: "traded_value", n: 12 })).toBe("월봉 0봉 전 거래대금이 12개월 신저거래대금이다");
});

test("값 범위 문장은 값의 단위로 한쪽이나 두 끝을 적는다", () => {
  expect(conditionSentence({ kind: "value_range", period: "M", barRange: { start: 0, end: 1 }, field: "close", min: 1000, max: 5000 })).toBe("월봉 0~1봉 전 안에 종가가 1,000원 이상 5,000원 이하인 봉이 있다");
  expect(conditionSentence({ kind: "value_range", period: "D", barRange: { start: 0, end: 0 }, field: "volume", min: null, max: 10_000 })).toBe("일봉 0봉 전 거래량이 10,000주 이하다");
  expect(conditionSentence({ kind: "value_range", period: "W", barRange: { start: 0, end: 2 }, field: "traded_value", min: 50_000_000, max: 25_000_000_000 })).toBe("주봉 0~2봉 전 안에 거래대금이 0.5억 원 이상 250억 원 이하인 봉이 있다");
});

test("등락률 문장은 부호를 붙이고 비교 봉을 그 줄의 단위로 센다", () => {
  expect(conditionSentence({ kind: "change", period: "W", barRange: { start: 0, end: 0 }, back: 1, minPct: -10, maxPct: -3 })).toBe("주봉 0봉 전 종가가 1주 전보다 −10% 이상 −3% 이하다");
  expect(conditionSentence({ kind: "change", period: "M", barRange: { start: 0, end: 3 }, back: 6, minPct: null, maxPct: 0 })).toBe("월봉 0~3봉 전 안에 종가가 6개월 전보다 0% 이하인 봉이 있다");
});

test("고점·저점 거리와 거래 급증 문장", () => {
  expect(conditionSentence({ kind: "near_extreme", period: "M", barRange: { start: 0, end: 2 }, extreme: "low", n: 12, withinPct: 2.5 })).toBe("월봉 0~2봉 전 안에 종가가 12개월 최저가에서 2.5% 안인 봉이 있다");
  expect(conditionSentence({ kind: "surge", period: "W", barRange: { start: 0, end: 1 }, field: "traded_value", n: 4, times: 1.5 })).toBe("주봉 0~1봉 전 안에 거래대금이 직전 4주 평균의 1.5배 이상인 봉이 있다");
});

test("이동평균 문장은 단순과 지수를 가르고, 종가와의 교차도 쓴다", () => {
  expect(conditionSentence({ kind: "ma_position", period: "W", barRange: { start: 0, end: 0 }, field: "low", method: "ema", length: 60, side: "below" })).toBe("주봉 0봉 전 저가가 60주 지수 이동평균 아래다");
  expect(conditionSentence({ kind: "ma_alignment", period: "M", barRange: { start: 0, end: 2 }, method: "ema", lengths: [20, 60], order: "bearish" })).toBe("월봉 0~2봉 전 안에 20·60개월 지수 이동평균이 역배열인 봉이 있다");
  expect(conditionSentence({ kind: "ma_cross", period: "D", barRange: { start: 0, end: 0 }, method: "sma", fast: null, slow: 20, direction: "down" })).toBe("일봉 0봉 전 종가가 20일선을 아래로 교차했다");
  expect(conditionSentence({ kind: "ma_cross", period: "W", barRange: { start: 0, end: 1 }, method: "ema", fast: 12, slow: 26, direction: "up" })).toBe("주봉 0~1봉 전 안에 12주 지수 이동평균이 26주 지수 이동평균을 위로 교차한 봉이 있다");
});

test("RSI 문장은 범위와 돌파를 가르고 조사를 값에 맞춘다", () => {
  expect(conditionSentence({ kind: "rsi", period: "D", barRange: { start: 0, end: 0 }, length: 14, test: { kind: "range", min: null, max: 30 } })).toBe("일봉 0봉 전 RSI(14)가 30 이하다");
  expect(conditionSentence({ kind: "rsi", period: "W", barRange: { start: 0, end: 3 }, length: 9, test: { kind: "range", min: 30, max: 70 } })).toBe("주봉 0~3봉 전 안에 RSI(9)가 30 이상 70 이하인 봉이 있다");
  expect(conditionSentence({ kind: "rsi", period: "M", barRange: { start: 0, end: 0 }, length: 14, test: { kind: "breakout", value: 25, direction: "down" } })).toBe("월봉 0봉 전 RSI(14)가 25를 아래로 돌파했다");
});

test("MACD 문장은 시그널 교차, 0선 돌파, 시그널 대비를 가른다", () => {
  const macd = { fast: 12, slow: 26, signal: 9 };
  expect(conditionSentence({ kind: "macd", period: "D", barRange: { start: 0, end: 0 }, ...macd, test: { kind: "signal_cross", direction: "up" } })).toBe("일봉 0봉 전 MACD(12·26·9)가 시그널을 위로 교차했다");
  expect(conditionSentence({ kind: "macd", period: "M", barRange: { start: 0, end: 1 }, ...macd, test: { kind: "zero_breakout", direction: "down" } })).toBe("월봉 0~1봉 전 안에 MACD(12·26·9)가 0선을 아래로 돌파한 봉이 있다");
  expect(conditionSentence({ kind: "macd", period: "W", barRange: { start: 0, end: 0 }, fast: 5, slow: 35, signal: 5, test: { kind: "vs_signal", side: "above" } })).toBe("주봉 0봉 전 MACD(5·35·5)가 시그널 위다");
});

test("스토캐스틱과 볼린저 밴드 문장", () => {
  const stochastic = { k: 5, d: 3, smooth: 3 };
  expect(conditionSentence({ kind: "stochastic", period: "D", barRange: { start: 0, end: 2 }, ...stochastic, test: { kind: "cross", direction: "up" } })).toBe("일봉 0~2봉 전 안에 스토캐스틱(5·3·3) %K가 %D를 위로 교차한 봉이 있다");
  expect(conditionSentence({ kind: "stochastic", period: "W", barRange: { start: 0, end: 0 }, ...stochastic, test: { kind: "range", min: null, max: 20 } })).toBe("주봉 0봉 전 스토캐스틱(5·3·3) %K가 20 이하다");
  expect(conditionSentence({ kind: "bollinger", period: "D", barRange: { start: 0, end: 0 }, length: 20, k: 2, test: { kind: "outside", side: "above" } })).toBe("일봉 0봉 전 종가가 볼린저 밴드(20·2) 상단 위다");
  expect(conditionSentence({ kind: "bollinger", period: "W", barRange: { start: 0, end: 1 }, length: 20, k: 2.5, test: { kind: "outside", side: "below" } })).toBe("주봉 0~1봉 전 안에 종가가 볼린저 밴드(20·2.5) 하단 아래인 봉이 있다");
  expect(conditionSentence({ kind: "bollinger", period: "M", barRange: { start: 0, end: 0 }, length: 20, k: 2, test: { kind: "cross", band: "lower", direction: "up" } })).toBe("월봉 0봉 전 종가가 볼린저 밴드(20·2) 하단을 위로 교차했다");
});

test("일목 문장은 차트 기본 설정이면 설정값을 빼고, 다르면 적는다", () => {
  const chartDefault = { conversion: 9, base: 26, spanB: 52, displacement: 26 };
  expect(conditionSentence({ kind: "ichimoku", period: "D", barRange: { start: 0, end: 4 }, ...chartDefault, test: { kind: "cross", direction: "up" } })).toBe("일봉 0~4봉 전 안에 일목 전환선이 기준선을 위로 교차한 봉이 있다");
  expect(conditionSentence({ kind: "ichimoku", period: "M", barRange: { start: 0, end: 0 }, conversion: 10, base: 30, spanB: 60, displacement: 30, test: { kind: "cloud", side: "below" } })).toBe(
    "월봉 0봉 전 종가가 일목(10·30·60·30) 구름 아래다",
  );
  expect(conditionSentence({ kind: "ichimoku", period: "W", barRange: { start: 0, end: 1 }, ...chartDefault, test: { kind: "cloud", side: "above" } })).toBe("주봉 0~1봉 전 안에 종가가 일목 구름 위인 봉이 있다");
});

test("시가총액 문장은 봉 주기와 M 없이 억 원으로 적는다", () => {
  expect(conditionSentence({ kind: "market_cap", min: null, max: 100_000_000_000 })).toBe("시가총액이 1,000억 원 이하다");
  expect(conditionSentence({ kind: "market_cap", min: 50_000_000_000, max: 3_000_000_000_000 })).toBe("시가총액이 500억 원 이상 30,000억 원 이하다");
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

  expect(matchedDateText(screenOf([]), "2026-11-10", "2026-11-10")).toEqual({ text: "당일", current: true });
});

const row = (symbol: string, name: string, close: number, changeRate: number | null, matchedDate: string): ScreenerRow => ({
  symbol,
  name,
  close,
  changeRate,
  matchedDate,
  latestBarDate: "2026-11-10",
  provisional: false,
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

test("0봉 문장은 오늘이라고 가정하지 않으며 양 끝과 각 봉 주기를 그대로 읽는다", () => {
  for (const [period, label] of [["D", "일봉"], ["W", "주봉"], ["M", "월봉"]] as const) {
    expect(conditionSentence({ ...newHigh(period, "high", 2, 1), barRange: { start: 1, end: 1 } })).toBe(`${label} 1봉 전 고가가 2${period === "D" ? "일" : period === "W" ? "주" : "개월"} 신고가다`);
    expect(conditionSentence({ ...newHigh(period, "high", 2, 1), barRange: { start: 1, end: 3 } })).toContain(`${label} 1~3봉 전 안에`);
  }
});
