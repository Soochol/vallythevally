import { describe, expect, test } from "vitest";
import { chooseFinePeriod, weekdaysBetween } from "./finePeriod";

const kst = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) / 1000 - 9 * 3600;
const now = kst(2026, 11, 13, 15);
const fiveDays = kst(2026, 11, 9);
const thirteenDays = kst(2026, 10, 28);
const fourteenDays = kst(2026, 10, 27);
const sixtyDays = kst(2026, 8, 24);
const twoHundredDays = kst(2026, 2, 9);
const elevenMonths = kst(2025, 12, 13);

const period = (fine: string) => ({ kind: "period", period: fine });
const none = (reason: string) => ({ kind: "none", reason });

describe("평일 수", () => {
  test("한국 날짜로 양 끝을 넣어 센다", () => {
    expect(weekdaysBetween(fiveDays, now)).toBe(5);
    expect(weekdaysBetween(kst(2026, 11, 9, 0, 30), kst(2026, 11, 14, 23))).toBe(5);
    expect(weekdaysBetween(sixtyDays, now)).toBe(60);
    expect(weekdaysBetween(twoHundredDays, now)).toBe(200);
    expect(weekdaysBetween(now, fiveDays)).toBe(0);
  });
});

describe("세부 봉 주기", () => {
  test("일봉 차트는 구간 시작이 멀수록 긴 분봉을 쓴다", () => {
    expect(chooseFinePeriod("D", fiveDays, now)).toEqual(period("1m"));
    expect(chooseFinePeriod("D", sixtyDays, now)).toEqual(period("5m"));
    expect(chooseFinePeriod("D", twoHundredDays, now)).toEqual(period("15m"));
    expect(chooseFinePeriod("D", elevenMonths, now)).toEqual(period("30m"));
  });

  test("1분봉은 평일 13일(9,360봉)까지이고 14일이면 3분봉이다", () => {
    expect(weekdaysBetween(thirteenDays, now)).toBe(13);
    expect(chooseFinePeriod("D", thirteenDays, now)).toEqual(period("1m"));
    expect(chooseFinePeriod("D", fourteenDays, now)).toEqual(period("3m"));
  });

  test("구간 시작이 365일보다 멀면 1년 밖이다", () => {
    expect(chooseFinePeriod("D", now - 365 * 86_400, now)).toEqual(period("30m"));
    expect(chooseFinePeriod("D", kst(2025, 11, 12, 15), now)).toEqual(none("pastYear"));
    expect(chooseFinePeriod("W", kst(2025, 11, 12, 15), now)).toEqual(none("pastYear"));
  });

  test("분봉 차트는 차트의 분 수를 나누는 더 짧은 분봉만 쓴다", () => {
    expect(chooseFinePeriod("10m", fiveDays, now)).toEqual(period("1m"));
    expect(chooseFinePeriod("10m", fourteenDays, now)).toEqual(period("5m"));
    expect(chooseFinePeriod("10m", sixtyDays, now)).toEqual(period("5m"));
    expect(chooseFinePeriod("10m", twoHundredDays, now)).toEqual(none("overLimit"));
    expect(chooseFinePeriod("15m", fourteenDays, now)).toEqual(period("3m"));
    expect(chooseFinePeriod("60m", elevenMonths, now)).toEqual(period("30m"));
  });

  test("3분봉 차트는 1분봉이 아니면 한도 안에 드는 주기가 없다", () => {
    expect(chooseFinePeriod("3m", fiveDays, now)).toEqual(period("1m"));
    expect(chooseFinePeriod("3m", fourteenDays, now)).toEqual(none("overLimit"));
    expect(chooseFinePeriod("5m", fourteenDays, now)).toEqual(none("overLimit"));
  });

  test("1분봉 차트는 세부 봉이 없다", () => {
    expect(chooseFinePeriod("1m", fiveDays, now)).toEqual(none("oneMinuteChart"));
    expect(chooseFinePeriod("1m", kst(2025, 1, 1), now)).toEqual(none("oneMinuteChart"));
  });
});
