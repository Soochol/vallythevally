import { describe, expect, test } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { Period } from "../../api/generated/Period";
import {
  type Axes,
  type Frame,
  barLength,
  fromScreen,
  logicalToT,
  logicalToX,
  nextBarStart,
  shiftBars,
  startAt,
  type TimeAxis,
  type Timeline,
  timelineOf,
  toScreen,
  toolContext,
  tToLogical,
  xToLogical,
} from "./anchor";

const kst = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) / 1000 - 9 * 3600;
const HOUR = 3600;
const DAY = 86_400;

const tl = (period: Period, starts: number[]): Timeline => ({ period, starts });
const days = (...ds: [number, number, number][]) => ds.map(([y, m, d]) => kst(y, m, d));
const hourly = (y: number, m: number, d: number) => Array.from({ length: 12 }, (_, i) => kst(y, m, d, 8 + i));

const weekNov2 = tl("D", days([2026, 11, 2], [2026, 11, 3], [2026, 11, 4], [2026, 11, 5], [2026, 11, 6]));

describe("규칙 1: 봉 구간 안", () => {
  test("일봉 안의 14:00은 k + 14/24", () => {
    expect(tToLogical(weekNov2, kst(2026, 11, 3, 14))).toBeCloseTo(1 + 14 / 24, 12);
  });

  test("월봉 길이는 그달 일수(KST)다", () => {
    const months = tl("M", days([2026, 1, 1], [2026, 2, 1], [2026, 3, 1]));
    expect(barLength("M", kst(2026, 2, 1))).toBe(28 * DAY);
    expect(barLength("M", kst(2026, 1, 1))).toBe(31 * DAY);
    expect(tToLogical(months, kst(2026, 2, 15))).toBeCloseTo(1 + 14 / 28, 12);
  });

  test("주봉은 7일이다", () => {
    const weeks = tl("W", days([2026, 10, 26], [2026, 11, 2]));
    expect(tToLogical(weeks, kst(2026, 11, 4))).toBeCloseTo(1 + 2 / 7, 12);
  });

  test("분봉은 n분이다", () => {
    expect(barLength("5m", 0)).toBe(300);
    expect(tToLogical(tl("5m", [kst(2026, 11, 6, 9), kst(2026, 11, 6, 9, 5)]), kst(2026, 11, 6, 9, 1))).toBeCloseTo(0.2, 12);
  });
});

describe("규칙 2: 체결이 없는 틈", () => {
  const twoDays60 = tl("60m", [...hourly(2026, 11, 5), ...hourly(2026, 11, 6)]);

  test("밤의 틈은 다음 봉 시작 k + 1", () => {
    expect(tToLogical(twoDays60, kst(2026, 11, 5, 20, 30))).toBe(12);
    expect(tToLogical(twoDays60, kst(2026, 11, 6, 7, 59))).toBe(12);
  });

  test("마지막 분 구간 안은 비율이다", () => {
    expect(tToLogical(twoDays60, kst(2026, 11, 5, 19, 30))).toBeCloseTo(11.5, 12);
  });

  test("주말은 월요일 봉 자리에 놓인다", () => {
    const withMonday = tl("D", [...weekNov2.starts, kst(2026, 11, 9)]);
    expect(tToLogical(withMonday, kst(2026, 11, 7, 10))).toBe(5);
    expect(tToLogical(withMonday, kst(2026, 11, 8, 23))).toBe(5);
  });
});

describe("규칙 3: 마지막 봉 뒤는 실제 봉 경계", () => {
  test("일봉은 주말을 건너뛴다", () => {
    expect(nextBarStart("D", kst(2026, 11, 6))).toBe(kst(2026, 11, 9));
    expect(nextBarStart("D", kst(2026, 11, 4))).toBe(kst(2026, 11, 5));
    expect(startAt(weekNov2, 5)).toBe(kst(2026, 11, 9));
    expect(startAt(weekNov2, 6)).toBe(kst(2026, 11, 10));
    expect(tToLogical(weekNov2, kst(2026, 11, 7, 12))).toBe(5);
    expect(tToLogical(weekNov2, kst(2026, 11, 9, 12))).toBeCloseTo(5.5, 12);
  });

  test("주봉은 다음 월요일", () => {
    expect(nextBarStart("W", kst(2026, 11, 2))).toBe(kst(2026, 11, 9));
    expect(nextBarStart("W", kst(2026, 10, 6))).toBe(kst(2026, 10, 12));
  });

  test("월봉은 다음 달 1일, 해를 넘긴다", () => {
    const months = tl("M", days([2026, 10, 1], [2026, 11, 1]));
    expect(startAt(months, 2)).toBe(kst(2026, 12, 1));
    expect(startAt(months, 3)).toBe(kst(2027, 1, 1));
    expect(tToLogical(months, kst(2026, 12, 16))).toBeCloseTo(2 + 15 / 31, 12);
    expect(nextBarStart("M", kst(2026, 2, 1))).toBe(kst(2026, 3, 1));
  });

  test("분봉은 n분을 더한다(장 사이 틈을 건너뛰지 않는다)", () => {
    const last = tl("5m", [kst(2026, 11, 6, 19, 50), kst(2026, 11, 6, 19, 55)]);
    expect(startAt(last, 2)).toBe(kst(2026, 11, 6, 20));
    expect(tToLogical(last, kst(2026, 11, 6, 20, 2))).toBeCloseTo(2.4, 12);
  });
});

describe("규칙 4: 첫 봉 앞", () => {
  test("시각과 index 모두 null", () => {
    expect(tToLogical(weekNov2, kst(2026, 11, 1))).toBeNull();
    expect(logicalToT(weekNov2, -0.25)).toBeNull();
    expect(startAt(weekNov2, -1)).toBeNull();
    expect(tToLogical(tl("D", []), kst(2026, 11, 1))).toBeNull();
  });
});

describe("거꾸로: logical → t", () => {
  test("정수 초로 반올림한다", () => {
    const t = logicalToT(tl("1m", [0, 60]), 0.3333);
    expect(t).toBe(20);
    expect(Number.isInteger(logicalToT(weekNov2, 1.123456789))).toBe(true);
  });

  test("봉 안의 t는 그대로 돌아온다", () => {
    for (const t of [kst(2026, 11, 2), kst(2026, 11, 3, 14), kst(2026, 11, 6, 23, 59), kst(2026, 11, 10, 9)]) {
      const logical = tToLogical(weekNov2, t);
      expect(logical).not.toBeNull();
      if (logical !== null) expect(logicalToT(weekNov2, logical)).toBe(t);
    }
  });

  test("틈 안의 t는 다음 봉 시작으로 돌아온다", () => {
    const logical = tToLogical(weekNov2, kst(2026, 11, 7, 12));
    expect(logical === null ? null : logicalToT(weekNov2, logical)).toBe(kst(2026, 11, 9));
  });

  test("logical은 반올림 안에서 그대로 돌아온다", () => {
    for (const logical of [0, 0.25, 3.7, 4.999, 7.5]) {
      const t = logicalToT(weekNov2, logical);
      expect(t === null ? null : tToLogical(weekNov2, t)).toBeCloseTo(logical, 4);
    }
  });
});

test("shiftBars는 n봉 뒤의 봉 시작이다", () => {
  expect(shiftBars(weekNov2, kst(2026, 11, 3, 14), 1)).toBe(kst(2026, 11, 4));
  expect(shiftBars(weekNov2, kst(2026, 11, 6), 1)).toBe(kst(2026, 11, 9));
  expect(shiftBars(weekNov2, kst(2026, 11, 3), -1)).toBe(kst(2026, 11, 2));
  expect(shiftBars(weekNov2, kst(2026, 11, 2), -1)).toBeNull();
});

describe("§6.3 소수 index ↔ x", () => {
  const SPACING = 8;
  const axis: TimeAxis = {
    coordinateOf: (k) => (Number.isInteger(k) ? 100 + k * SPACING : 0),
    indexAt: (x) => Math.ceil((x - 100) / SPACING),
    barSpacing: SPACING,
  };

  test("정수에서는 라이브러리 값과 같다", () => {
    expect(logicalToX(axis, 250)).toBe(axis.coordinateOf(250));
  });

  test("k + 0.25는 봉 간격의 1/4만큼 오른쪽이다", () => {
    expect(logicalToX(axis, 250.25)).toBe(100 + 250 * SPACING + SPACING / 4);
  });

  test("x → logical은 소수까지 되돌린다", () => {
    expect(xToLogical(axis, 100 + 250 * SPACING + 2)).toBeCloseTo(250.25, 12);
    expect(xToLogical(axis, 100 + 3 * SPACING)).toBe(3);
  });
});

function frameOf(bars: Bar[], period: Period): Frame {
  const axes: Axes = {
    time: {
      coordinateOf: (k) => (Number.isInteger(k) ? 10 + k * 6 : 0),
      indexAt: (x) => Math.ceil((x - 10) / 6),
      barSpacing: 6,
    },
    price: { toY: (p) => 1000 - p / 10, toPrice: (y) => (1000 - y) * 10 },
  };
  return { timeline: timelineOf(bars, period), axes, bars, pane: { width: 800, height: 400 }, logScale: false };
}

const barAt = (t: number, v = 100): Bar => ({ t, o: 1, h: 2, l: 0.5, c: 1.5, v });

describe("화면 좌표", () => {
  const frame = frameOf(weekNov2.starts.map((t) => barAt(t)), "D");

  test("toScreen과 fromScreen은 서로 거꾸로다", () => {
    const p = { t: kst(2026, 11, 3, 12), price: 2500 };
    const s = toScreen(frame, p);
    expect(s).toEqual({ x: 10 + 1.5 * 6, y: 750 });
    expect(s === null ? null : fromScreen(frame, s)).toEqual(p);
  });

  test("첫 봉 앞의 점은 그리지 않는다", () => {
    expect(toScreen(frame, { t: kst(2026, 10, 30), price: 2500 })).toBeNull();
    expect(fromScreen(frame, { x: 0, y: 10 })).toBeNull();
  });

  test("ToolContext의 barsBetween은 봉 수와 거래량 합이다", () => {
    const ctx = toolContext(frame, { price: String, time: String });
    expect(ctx.barsBetween(kst(2026, 11, 2), kst(2026, 11, 4, 12))).toEqual({ count: 2, volume: 300 });
    expect(ctx.barsBetween(kst(2026, 10, 30), kst(2026, 11, 4))).toBeNull();
  });
});

describe("frontend.md §3.5 보이는 모습", () => {
  const daily = tl("D", days([2026, 11, 3], [2026, 11, 4], [2026, 11, 5], [2026, 11, 6]));
  const h60 = tl("60m", [...hourly(2026, 11, 3), ...hourly(2026, 11, 4), ...hourly(2026, 11, 5), ...hourly(2026, 11, 6)]);

  test("일봉 자석 점(00:00)은 60분봉에서 그날 첫 봉(08:00)의 왼쪽 끝이다", () => {
    expect(tToLogical(h60, kst(2026, 11, 6))).toBe(36);
    expect(startAt(h60, 36)).toBe(kst(2026, 11, 6, 8));
  });

  test("60분봉 14:00 점은 일봉에서 그날 봉의 14/24 자리다", () => {
    expect(tToLogical(daily, kst(2026, 11, 6, 14))).toBeCloseTo(3 + 14 / 24, 12);
  });

  test("일봉에서 그은 추세선은 60분봉에서 같은 날의 첫 봉을 잇는다", () => {
    const a = tToLogical(h60, kst(2026, 11, 4));
    const b = tToLogical(h60, kst(2026, 11, 6));
    expect([a, b]).toEqual([12, 36]);
    expect(a === null ? null : startAt(h60, a)).toBe(kst(2026, 11, 4, 8));
  });

  test("받은 첫 날의 00:00은 첫 60분봉(08:00) 앞이라 규칙 4로 그리지 않는다", () => {
    expect(tToLogical(h60, kst(2026, 11, 3))).toBeNull();
  });

  test("저장값을 고치지 않는다: 일봉 점을 60분봉 화면에서 읽어도 t는 그대로다", () => {
    const t = kst(2026, 11, 4, 14);
    const logical = tToLogical(h60, t);
    expect(logical === null ? null : logicalToT(h60, logical)).toBe(t);
  });
});

test("timelineOf는 봉 시작을 그대로 쓴다", () => {
  expect(timelineOf([barAt(5), barAt(10)], "1m")).toEqual({ period: "1m", starts: [5, 10] });
  expect(nextBarStart("60m", kst(2026, 11, 6, 19))).toBe(kst(2026, 11, 6, 19) + HOUR);
});
