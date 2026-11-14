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
  startAt,
  type TimeAxis,
  type Timeline,
  timelineOf,
  toScreen,
  toolContext,
  tToLogical,
  xToLogical,
} from "./anchor";
import { toolOf } from "./tools";

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
    expect(barLength("10m", 0)).toBe(600);
    const ten = tl("10m", [kst(2026, 11, 6, 9), kst(2026, 11, 6, 9, 10)]);
    expect(tToLogical(ten, kst(2026, 11, 6, 9, 5))).toBe(0.5);
    expect(logicalToT(ten, 1.5)).toBe(kst(2026, 11, 6, 9, 15));
    expect(startAt(ten, 2)).toBe(kst(2026, 11, 6, 9, 20));
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

describe("규칙 4: 첫 봉 앞은 봉 간격으로 이어 센다", () => {
  test("일봉은 주말을 건너 거꾸로 센다", () => {
    expect(startAt(weekNov2, -1)).toBe(kst(2026, 10, 30));
    expect(startAt(weekNov2, -5)).toBe(kst(2026, 10, 26));
    expect(startAt(weekNov2, -6)).toBe(kst(2026, 10, 23));
    expect(tToLogical(weekNov2, kst(2026, 10, 30, 12))).toBeCloseTo(-0.5, 12);
    expect(tToLogical(weekNov2, kst(2026, 11, 1))).toBe(0);
    expect(tToLogical(weekNov2, kst(2025, 11, 3))).toBe(-260);
    expect(logicalToT(weekNov2, -0.25)).toBe(kst(2026, 10, 30, 18));
    expect(tToLogical(tl("D", []), kst(2026, 11, 1))).toBeNull();
  });

  test("주·월·분기·연·분봉도 거꾸로 센다", () => {
    expect(startAt(tl("W", [kst(2026, 11, 2)]), -2)).toBe(kst(2026, 10, 19));
    expect(startAt(tl("M", [kst(2026, 3, 1)]), -3)).toBe(kst(2025, 12, 1));
    expect(startAt(tl("Q", [kst(2027, 1, 1)]), -1)).toBe(kst(2026, 10, 1));
    expect(startAt(tl("Y", [kst(2027, 1, 1)]), -2)).toBe(kst(2025, 1, 1));
    expect(startAt(tl("5m", [kst(2026, 11, 6, 9)]), -2)).toBe(kst(2026, 11, 6, 8, 50));
    expect(tToLogical(tl("M", [kst(2026, 3, 1)]), kst(2026, 1, 16))).toBeCloseTo(-2 + 15 / 31, 12);
  });

  test("첫 봉 앞의 시각과 logical도 서로 거꾸로다", () => {
    for (const t of [kst(2026, 10, 30, 3), kst(2026, 10, 12, 23, 59), kst(2020, 1, 2, 9)]) {
      const logical = tToLogical(weekNov2, t);
      expect(logical === null ? null : logicalToT(weekNov2, logical)).toBe(t);
    }
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
const barStarts = (bars: readonly Bar[]) => bars.map((b) => b.t);
const nov = (d: number) => kst(2026, 11, d);

describe("화면 좌표", () => {
  const frame = frameOf(weekNov2.starts.map((t) => barAt(t)), "D");

  test("toScreen과 fromScreen은 서로 거꾸로다", () => {
    const p = { t: kst(2026, 11, 3, 12), price: 2500 };
    const s = toScreen(frame, p);
    expect(s).toEqual({ x: 10 + 1.5 * 6, y: 750 });
    expect(s === null ? null : fromScreen(frame, s)).toEqual(p);
  });

  test("첫 봉 앞의 점도 봉 간격으로 이어 그린다", () => {
    const p = { t: kst(2026, 10, 30, 12), price: 2500 };
    const s = toScreen(frame, p);
    expect(s).toEqual({ x: 10 - 0.5 * 6, y: 750 });
    expect(s === null ? null : fromScreen(frame, s)).toEqual(p);
    expect(fromScreen(frame, { x: 10 - 6, y: 750 })).toEqual({ t: kst(2026, 10, 30), price: 2500 });
  });

  test("shiftBars는 점 아래 봉에서 n봉 옮긴 봉 시작이다", () => {
    const ctx = toolContext(frame, { price: String, time: String });
    expect(ctx.shiftBars(kst(2026, 11, 3, 6), 1)).toBe(kst(2026, 11, 4));
    expect(ctx.shiftBars(kst(2026, 11, 3, 14), 1)).toBe(kst(2026, 11, 5));
    expect(ctx.shiftBars(kst(2026, 11, 6), 1)).toBe(kst(2026, 11, 9));
    expect(ctx.shiftBars(kst(2026, 11, 3), -1)).toBe(kst(2026, 11, 2));
    expect(ctx.shiftBars(kst(2026, 11, 2), -1)).toBe(kst(2026, 10, 30));
  });

  test("ToolContext의 barsBetween은 봉 수와 불러온 봉의 거래량 합이다", () => {
    const ctx = toolContext(frame, { price: String, time: String });
    expect(ctx.barsBetween(kst(2026, 11, 2), kst(2026, 11, 4, 6))).toEqual({ count: 2, volume: 300 });
    expect(ctx.barsBetween(kst(2026, 10, 30), kst(2026, 11, 4))).toEqual({ count: 3, volume: 300 });
  });

  test("ToolContext의 barsIn은 두 시각이 든 봉 사이의 봉을 시간 순으로 준다", () => {
    const ctx = toolContext(frame, { price: String, time: String });
    expect(barStarts(ctx.barsIn(kst(2026, 11, 3, 12), nov(5)))).toEqual([nov(3), nov(4), nov(5)]);
    expect(barStarts(ctx.barsIn(nov(5), kst(2026, 11, 3, 12)))).toEqual([nov(3), nov(4), nov(5)]);
    expect(barStarts(ctx.barsIn(nov(4), nov(4)))).toEqual([nov(4)]);
  });

  test("barsIn은 끝 시각이 없으면 마지막 봉까지, 마지막 봉 뒤의 시각은 마지막 봉으로 본다", () => {
    const ctx = toolContext(frame, { price: String, time: String });
    expect(barStarts(ctx.barsIn(nov(5)))).toEqual([nov(5), nov(6)]);
    expect(barStarts(ctx.barsIn(nov(4), nov(20)))).toEqual([nov(4), nov(5), nov(6)]);
    expect(barStarts(ctx.barsIn(nov(20), nov(5)))).toEqual([nov(5), nov(6)]);
    expect(barStarts(ctx.barsIn(nov(20)))).toEqual([nov(6)]);
    expect(barStarts(ctx.barsIn(kst(2027, 6, 1)))).toEqual([nov(6)]);
  });

  test("barsIn은 첫 봉 앞에서 시작한 구간의 불러온 봉만 준다", () => {
    const ctx = toolContext(frame, { price: String, time: String });
    expect(barStarts(ctx.barsIn(kst(2026, 10, 30), kst(2026, 11, 4)))).toEqual([nov(2), nov(3), nov(4)]);
    expect(barStarts(ctx.barsIn(kst(2026, 11, 4), kst(2026, 10, 30)))).toEqual([nov(2), nov(3), nov(4)]);
    expect(barStarts(ctx.barsIn(kst(2026, 10, 30)))).toEqual([nov(2), nov(3), nov(4), nov(5), nov(6)]);
    expect(ctx.barsIn(kst(2026, 10, 26), kst(2026, 10, 30))).toEqual([]);
    expect(toolContext(frameOf([], "D"), { price: String, time: String }).barsIn(kst(2026, 11, 4))).toEqual([]);
  });

  test("점이 봉의 왼쪽 절반에 있으면 그 봉부터 센다", () => {
    const ctx = toolContext(frame, { price: String, time: String });
    const leftHalfOfNov4 = logicalToT(weekNov2, 1.7)!;
    expect(leftHalfOfNov4).toBeLessThan(nov(4));
    expect(barStarts(ctx.barsIn(leftHalfOfNov4))).toEqual([nov(4), nov(5), nov(6)]);
    expect(barStarts(ctx.barsIn(leftHalfOfNov4, nov(5)))).toEqual([nov(4), nov(5)]);
    expect(ctx.shiftBars(leftHalfOfNov4, 0)).toBe(nov(4));
    expect(ctx.barsBetween(leftHalfOfNov4, nov(6))).toEqual({ count: 2, volume: 300 });
  });

  test("축 역변환은 다른 축의 투영 가능 여부와 무관하다", () => {
    const ctx = toolContext(frame, { price: String, time: String });
    expect(ctx.priceAt(750)).toBe(2500);
    expect(ctx.timeAt(19)).toBe(kst(2026, 11, 3, 12));
    expect(ctx.timeAt(0)).toBeNull();
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

  test("받은 첫 날의 00:00은 첫 60분봉(08:00) 앞이라 규칙 4로 60분씩 거꾸로 센다", () => {
    expect(tToLogical(h60, kst(2026, 11, 3))).toBe(-8);
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


describe("분기봉·연봉의 KST 달력과 미래 드로잉", () => {
  test("분기마다 실제 일수를 쓰고 윤년과 연도 경계를 넘긴다", () => {
    expect(barLength("Q", kst(2027, 1, 1))).toBe(90 * DAY);
    expect(barLength("Q", kst(2028, 1, 1))).toBe(91 * DAY);
    expect(barLength("Q", kst(2028, 4, 1))).toBe(91 * DAY);
    expect(barLength("Q", kst(2028, 7, 1))).toBe(92 * DAY);
    expect(nextBarStart("Q", kst(2027, 12, 31, 23))).toBe(kst(2028, 1, 1));
    expect(nextBarStart("Q", kst(2028, 3, 31))).toBe(kst(2028, 4, 1));
    expect(barLength("Y", kst(2027, 1, 1))).toBe(365 * DAY);
    expect(barLength("Y", kst(2028, 1, 1))).toBe(366 * DAY);
    expect(nextBarStart("Y", kst(2028, 12, 31, 23))).toBe(kst(2029, 1, 1));
  });

  test.each<Period>(["Q", "Y"])("%s 미래 시각과 드로잉 화면 좌표를 왕복한다", (period) => {
    const first = period === "Q" ? kst(2027, 10, 1) : kst(2027, 1, 1);
    const timeline = tl(period, [first]);
    expect(startAt(timeline, 1)).toBe(kst(2028, 1, 1));
    expect(startAt(timeline, 2)).toBe(period === "Q" ? kst(2028, 4, 1) : kst(2029, 1, 1));
    const t = kst(2028, 2, 29, 12);
    const logical = tToLogical(timeline, t);
    expect(logical).toBeCloseTo(1 + 59.5 / (period === "Q" ? 91 : 366), 12);
    expect(logical === null ? null : logicalToT(timeline, logical)).toBe(t);
    const frame = frameOf([barAt(first)], period);
    const point = { t, price: 2500 };
    const screen = toScreen(frame, point);
    expect(Number.isFinite(screen?.x)).toBe(true);
    expect(screen === null ? null : fromScreen(frame, screen)).toEqual(point);
    expect(toolContext(frame, { price: String, time: String }).shiftBars(first, 2)).toBe(startAt(timeline, 2));
  });
});

describe("주 계열에 봉이 없는 시간축 칸", () => {
  const slots = tl("D", [nov(2), nov(3), nov(4), nov(5), nov(6)]);
  const loaded = [nov(2), nov(3), nov(5), nov(6)].map((t) => barAt(t));
  const shared: Frame = {
    ...frameOf(loaded, "D"),
    axes: { ...frameOf(loaded, "D").axes, time: { ...frameOf(loaded, "D").axes.time, projection: { toLogical: (t) => tToLogical(slots, t), toTime: (l) => logicalToT(slots, l) } } },
  };
  const ctx = toolContext(shared, { price: String, time: String });

  test("봉 이동과 봉 세기는 화면의 칸을 센다", () => {
    expect(ctx.shiftBars(nov(3), 2)).toBe(nov(5));
    expect(ctx.xOf(ctx.shiftBars(nov(3), 2)!)! - ctx.xOf(nov(3))!).toBe(2 * 6);
    expect(ctx.barsBetween(nov(3), nov(6))).toEqual({ count: 3, volume: 300 });
    expect(barStarts(ctx.barsIn(nov(3), nov(5)))).toEqual([nov(3), nov(5)]);
  });

  test("피보나치 시간대 선은 시작에서 수준만큼 칸을 건너 그린다", () => {
    const fibtime = toolOf("fibtime")!;
    const style = { ...fibtime.defaultStyle() as object, labels: false };
    const xs = fibtime.shapes({ points: [{ t: nov(2), price: 1 }, { t: nov(3), price: 1 }], style, text: null, selected: false }, ctx).flatMap((s) => s.kind === "vline" ? [s.x] : []);
    expect(xs.slice(0, 4)).toEqual([0, 1, 2, 3].map((n) => ctx.xOf(nov(2))! + n * 6));
  });
});

test("회귀 채널은 첫 점이 불러온 첫 봉 앞이어도 불러온 봉으로 그린다", () => {
  const frame = frameOf(weekNov2.starts.map((t, i) => ({ ...barAt(t), c: 100 + i })), "D");
  const regression = toolOf("regression")!;
  const shapes = regression.shapes({ points: [{ t: kst(2026, 10, 28), price: 1 }, { t: nov(6), price: 1 }], style: regression.defaultStyle(), text: null, selected: false }, toolContext(frame, { price: String, time: String }));
  expect(shapes.length).toBeGreaterThan(0);
});
