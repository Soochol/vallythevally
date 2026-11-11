import { expect, test } from "vitest";
import { TickMarkType } from "lightweight-charts";
import { formatBarTime, formatKstClock, formatTickMark, fromChartTime, toChartTime } from "./time";

// 2026-11-06 00:00 KST = 2026-11-05 15:00 UTC
const nov6Kst = Date.UTC(2026, 10, 6) / 1000 - 32400;

test("차트 시각은 KST 벽시계를 UTC로 읽게 9시간을 더한다", () => {
  expect(toChartTime(nov6Kst)).toBe(Date.UTC(2026, 10, 6) / 1000);
  expect(fromChartTime(toChartTime(nov6Kst))).toBe(nov6Kst);
});

test("일·주·월봉은 KST 날짜만 쓴다", () => {
  expect(formatBarTime(nov6Kst, "D")).toBe("2026-11-06");
  expect(formatBarTime(nov6Kst, "W")).toBe("2026-11-06");
  expect(formatBarTime(nov6Kst, "M")).toBe("2026-11-06");
});

test("분봉은 KST 날짜와 시각을 쓴다", () => {
  expect(formatBarTime(nov6Kst + 19 * 3600 + 55 * 60, "5m")).toBe("2026-11-06 19:55");
});

test("KST 자정 직전 UTC 시각도 한국 날짜로 읽는다", () => {
  // 2026-11-06 23:59 UTC = 2026-11-07 08:59 KST
  const t = Date.UTC(2026, 10, 6, 23, 59) / 1000;
  expect(formatBarTime(t, "D")).toBe("2026-11-07");
  expect(formatKstClock(t)).toBe("08:59");
});

test("분봉 눈금은 하루 안에서 HH:mm, 날짜가 바뀌면 날짜다", () => {
  const at = (h: number, m: number) => toChartTime(nov6Kst + h * 3600 + m * 60);
  expect(formatTickMark(at(9, 5), TickMarkType.Time, "5m")).toBe("09:05");
  expect(formatTickMark(at(19, 55), TickMarkType.TimeWithSeconds, "1m")).toBe("19:55");
  expect(formatTickMark(at(8, 0), TickMarkType.DayOfMonth, "5m")).toBe("11-06");
  expect(formatTickMark(at(8, 0), TickMarkType.Month, "60m")).toBe("2026-11");
  expect(formatTickMark(at(8, 0), TickMarkType.Year, "60m")).toBe("2026");
});

test("KST 이른 아침 분봉(UTC로는 전날)도 한국 시각으로 쓴다", () => {
  // 2026-11-06 08:00 KST = 2026-11-05 23:00 UTC
  expect(formatTickMark(toChartTime(nov6Kst + 8 * 3600), TickMarkType.DayOfMonth, "1m")).toBe("11-06");
  expect(formatTickMark(toChartTime(nov6Kst + 8 * 3600), TickMarkType.Time, "1m")).toBe("08:00");
});

test("일·주·월봉 눈금은 라이브러리 기본을 쓴다", () => {
  expect(formatTickMark(toChartTime(nov6Kst), TickMarkType.DayOfMonth, "D")).toBeNull();
  expect(formatTickMark(toChartTime(nov6Kst), TickMarkType.Month, "M")).toBeNull();
});


test("분기봉·연봉은 분봉 날짜 표시와 눈금을 쓰지 않는다", () => {
  for (const period of ["Q", "Y"] as const) {
    expect(formatBarTime(nov6Kst, period)).toBe("2026-11-06");
    expect(formatTickMark(toChartTime(nov6Kst), TickMarkType.Month, period)).toBeNull();
  }
});
