import { expect, test } from "vitest";
import { formatBarTime, formatKstClock, fromChartTime, toChartTime } from "./time";

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
