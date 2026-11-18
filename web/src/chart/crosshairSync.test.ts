import { expect, test } from "vitest";
import type { Period } from "../api/generated/Period";
import { barInterval, CrosshairSync, crosshairGroupKey, matchingBarTime, type PointedBar } from "./crosshairSync";

const t = (date: string) => Date.parse(`${date}+09:00`) / 1000;
const day = t("2026-11-09T00:00:00");
const open = day + 9 * 3600;
const follow = (period: Period, times: number[]) => ({ period, bars: times.map((t) => ({ t })) });

test("같은 주기는 같은 시각의 봉만 고른다", () => {
  expect(matchingBarTime(barInterval(day, "D"), follow("D", [day - 86400, day, day + 86400]))).toBe(day);
  expect(matchingBarTime(barInterval(day, "D"), follow("D", [day - 86400, day + 86400]))).toBeNull();
});

test("분봉에서 일봉은 그 시각을 포함하는 봉을 고른다", () => {
  expect(matchingBarTime(barInterval(open + 300, "5m"), follow("D", [day, day + 86400]))).toBe(day);
});

test("일봉에서 분봉은 그날 받아 둔 첫 봉을 고른다", () => {
  expect(matchingBarTime(barInterval(day, "D"), follow("5m", [open - 86400, open, open + 300]))).toBe(open);
  expect(matchingBarTime(barInterval(day, "D"), follow("5m", [open + 300, open + 600]))).toBe(open + 300);
});

test("짧은 봉은 보낸 구간 이전의 겹치는 봉을 고르지 않는다", () => {
  expect(matchingBarTime(barInterval(open + 15 * 60, "15m"), follow("10m", [open + 10 * 60, open + 20 * 60, open + 30 * 60]))).toBe(open + 20 * 60);
  expect(matchingBarTime(barInterval(open + 20 * 60, "10m"), follow("15m", [open + 15 * 60, open + 30 * 60]))).toBe(open + 15 * 60);
});

test("범위 밖과 빈 봉 열은 고르지 않고 구간 끝은 제외한다", () => {
  const source = barInterval(day, "D");
  expect(matchingBarTime(source, follow("5m", []))).toBeNull();
  expect(matchingBarTime(source, follow("5m", [day - 300, source.end]))).toBeNull();
  expect(matchingBarTime(barInterval(open, "5m"), follow("D", [day - 86400]))).toBeNull();
  expect(matchingBarTime(barInterval(open, "5m"), follow("D", [day + 86400]))).toBeNull();
});

test("빠진 거래일이나 빠진 분봉까지 봉 구간을 늘리지 않는다", () => {
  const friday = t("2026-11-06T00:00:00");
  expect(matchingBarTime(barInterval(friday + 2 * 86400, "5m"), follow("D", [friday, day]))).toBeNull();
  expect(matchingBarTime(barInterval(open + 600, "1m"), follow("5m", [open, open + 900]))).toBeNull();
});

test("주·월·분기·연의 끝은 한국 달력 경계를 따른다", () => {
  for (const [start, period, end] of [
    ["2026-11-09T00:00:00", "W", "2026-11-16T00:00:00"],
    ["2024-02-01T00:00:00", "M", "2024-03-01T00:00:00"],
    ["2026-10-01T00:00:00", "Q", "2027-01-01T00:00:00"],
    ["2026-01-01T00:00:00", "Y", "2027-01-01T00:00:00"],
  ] satisfies [string, Period, string][]) expect(barInterval(t(start), period).end).toBe(t(end));
  const month = t("2026-11-01T00:00:00");
  expect(matchingBarTime(barInterval(day, "W"), follow("M", [month]))).toBe(month);
  expect(matchingBarTime(barInterval(month, "M"), follow("W", [t("2026-10-26T00:00:00"), day]))).toBe(day);
});

function participant() {
  let listener: (bar: PointedBar) => void = () => {};
  const seen: PointedBar[] = [];
  const element = { isConnected: true, clientWidth: 300, clientHeight: 200, checkVisibility: () => true };
  return {
    element, seen,
    subscribePointedBar(next: typeof listener) { listener = next; return () => { listener = () => {}; }; },
    showSyncedCrosshair(bar: PointedBar) { seen.push(bar); },
    point(bar: PointedBar) { listener(bar); },
  };
}

test("보내는 창 교대 뒤 이전 창의 leave는 새 십자선을 지우지 않는다", () => {
  const sync = new CrosshairSync();
  const a = participant();
  const b = participant();
  const c = participant();
  sync.connect("layout", a, a.element);
  const leaveB = sync.connect("layout", b, b.element);
  sync.connect("layout", c, c.element);
  const first = barInterval(day, "D");
  const second = barInterval(day + 86400, "D");
  a.point(first);
  expect(b.seen.at(-1)).toBe(first);
  expect(a.seen.at(-1)).toBeNull();
  b.point(second);
  expect(c.seen.at(-1)).toBe(second);
  expect(b.seen.at(-1)).toBeNull();
  a.point(null);
  expect(c.seen.at(-1)).toBe(second);
  leaveB();
  expect(c.seen.at(-1)).toBeNull();
  leaveB();
});

test("숨긴 창과 다른 레이아웃 세션은 제외하고 다시 연결해도 재생하지 않는다", () => {
  const sync = new CrosshairSync();
  const a = participant();
  const b = participant();
  const c = participant();
  const leaveA = sync.connect("1:layout", a, a.element);
  const leaveB = sync.connect("1:layout", b, b.element);
  sync.connect("2:layout", c, c.element);
  a.point(barInterval(day, "D"));
  expect(c.seen).toEqual([]);
  b.element.clientWidth = 0;
  a.point(barInterval(day, "D"));
  expect(b.seen.at(-1)).toBeNull();
  b.element.clientWidth = 300;
  a.element.isConnected = false;
  a.point(barInterval(day, "D"));
  expect(b.seen.at(-1)).toBeNull();
  leaveA();
  leaveB();
  sync.connect("1:layout", a, a.element);
  sync.connect("1:layout", b, b.element);
  expect(b.seen.at(-1)).toBeNull();
});

test("모든 차트는 종목과 연동 색에 상관없이 같은 열쇠다", () => {
  const key = crosshairGroupKey("all", "7:L1", { symbol: "005930", link: "a" });
  expect(crosshairGroupKey("all", "7:L1", { symbol: "000660", link: null })).toBe(key);
  expect(crosshairGroupKey("all", "7:L2", { symbol: "005930", link: "a" })).not.toBe(key);
});

test("같은 종목은 종목코드가 같을 때만 같은 열쇠이고 연동 색은 보지 않는다", () => {
  const key = crosshairGroupKey("symbol", "7:L1", { symbol: "005930", link: "a" });
  expect(crosshairGroupKey("symbol", "7:L1", { symbol: "005930", link: null })).toBe(key);
  expect(crosshairGroupKey("symbol", "7:L1", { symbol: "000660", link: "a" })).not.toBe(key);
  expect(crosshairGroupKey("symbol", "7:L2", { symbol: "005930", link: "a" })).not.toBe(key);
  expect(key).not.toBe(crosshairGroupKey("all", "7:L1", { symbol: "005930", link: "a" }));
});

test("같은 연동 색은 색이 같을 때만 같은 열쇠이고 색이 꺼지면 연결하지 않는다", () => {
  const key = crosshairGroupKey("link", "7:L1", { symbol: "005930", link: "a" });
  expect(key).not.toBeNull();
  expect(crosshairGroupKey("link", "7:L1", { symbol: "000660", link: "a" })).toBe(key);
  expect(crosshairGroupKey("link", "7:L1", { symbol: "005930", link: "b" })).not.toBe(key);
  expect(crosshairGroupKey("link", "7:L1", { symbol: "005930", link: null })).toBeNull();
});
