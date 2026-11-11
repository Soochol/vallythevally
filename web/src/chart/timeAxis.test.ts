import type { Coordinate, Logical, Time } from "lightweight-charts";
import { expect, test } from "vitest";
import { fromScreen, timelineOf, toScreen } from "./drawings/anchor";
import { chartTimeProjection, preserveTimeRange, type ChartTimeScale } from "./timeAxis";
import { toChartTime } from "./time";

const year = (n: number) => Date.UTC(n, 0, 1) / 1000 - 32400;
const logical = (value: number): value is Logical => Number.isFinite(value);
function range(from: number, to: number) {
  if (!logical(from) || !logical(to)) throw new Error("잘못된 범위");
  return { from, to };
}
function scaleOf(initial: number[]) {
  let times = initial;
  let offset = 2;
  let width = 1000;
  const spacing = 100;
  const visible = () => range(times.length - 1 + offset - width / spacing + 1, times.length - 1 + offset);
  const scale: ChartTimeScale = {
    logicalToCoordinate: (i) => {
      const x = width - 1 + (i - visible().to) * spacing;
      const valid = (n: number): n is Coordinate => Number.isFinite(n);
      return valid(x) ? x : null;
    },
    coordinateToTime: (x) => {
      const index = Math.round(visible().to + (x - width + 1) / spacing);
      const t = times[index];
      return t === undefined ? null : toChartTime(t);
    },
    timeToIndex: (time: Time, nearest) => {
      if (typeof time !== "number") return null;
      let i = times.findIndex((t) => toChartTime(t) >= time);
      if (i < 0 && nearest) i = times.length - 1;
      const valid = (n: number): n is NonNullable<ReturnType<ChartTimeScale["timeToIndex"]>> => Number.isInteger(n) && n >= 0 && n < times.length;
      return valid(i) && (nearest || toChartTime(times[i]!) === time) ? i : null;
    },
    getVisibleLogicalRange: visible,
    scrollPosition: () => offset,
    scrollToPosition: (next) => { offset = next; },
  };
  return { scale, spacing, width: () => width, change: (next: number[], nextWidth = width) => { times = next; width = nextWidth; } };
}

test("전역 금융 시각과 가격·미래 시각을 양방향으로 변환한다", () => {
  const f = scaleOf([2015, 2016, 2021, 2022, 2023, 2024, 2025, 2026].map(year));
  const projection = chartTimeProjection(f.scale, "Y");
  expect(projection.toLogical(year(2024))).toBe(5);
  expect(projection.toTime(0)).toBe(year(2015));
  expect(projection.toLogical(year(2028))).toBe(9);
  expect(projection.toTime(9)).toBe(year(2028));
  const timeline = timelineOf([2021, 2022, 2023, 2024, 2025, 2026].map((n) => ({ t: year(n), o: 1, h: 2, l: 1, c: 2, v: 100 })), "Y");
  const frame = { timeline, axes: { time: { projection, barSpacing: f.spacing, coordinateOf: (i: number) => logical(i) ? f.scale.logicalToCoordinate(i) : null, indexAt: (x: number) => Math.round(f.scale.getVisibleLogicalRange()!.to + (x - f.width() + 1) / f.spacing) }, price: { toY: (p: number) => p, toPrice: (y: number) => y } } };
  for (const t of [year(2015) + 365 * 86400 / 4, year(2024), year(2028)]) {
    const point = { t, price: 150 };
    const screen = toScreen(frame, point);
    expect(screen).not.toBeNull();
    expect(screen && fromScreen(frame, screen)).toEqual(point);
  }
  expect(projection.toTime(-0.1)).toBeNull();
  expect(projection.toLogical(year(2014))).toBeNull();
});

test("과거 봉이 기존 금융 시각을 채우거나 금융 시각이 사라져도 줌과 실제 시각의 오른쪽 위치를 보존한다", () => {
  const f = scaleOf([2015, 2016, 2021, 2022, 2023, 2024, 2025, 2026].map(year));
  const distance = () => {
    const index = chartTimeProjection(f.scale, "Y").toLogical(year(2024));
    if (index === null || !logical(index)) throw new Error("기준 시각 없음");
    return f.width() - f.scale.logicalToCoordinate(index)!;
  };
  const before = distance();
  preserveTimeRange(f.scale, "Y", () => f.change([2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map(year), 1018));
  expect(distance()).toBeCloseTo(before, 8);
  preserveTimeRange(f.scale, "Y", () => f.change([2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map(year), 1000));
  expect(distance()).toBeCloseTo(before, 8);
});
