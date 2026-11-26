import { expect, test } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { BarsPage } from "../../api/generated/BarsPage";
import { CANDLE_STRIP_HEIGHT, CANDLE_STRIP_WIDTH, candleShapes, recentDailyBars } from "./dailyCandles";

const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ t, o, h, l, c, v: 1000 });

const page = (bars: Bar[], current: Bar | null = null): BarsPage => ({
  symbol: "005930",
  venue: "combined",
  period: "D",
  bars,
  current,
  nextBefore: null,
  seq: null,
});

test("최근 일봉은 current를 중복 없이 합치고 마지막 봉에 실시간 현재가를 반영한다", () => {
  const first = bar(1, 100, 110, 95, 105);
  const current = bar(2, 105, 112, 102, 108);
  const merged = recentDailyBars(page([first], current), 115, 5);
  expect(merged).toHaveLength(2);
  expect(merged[1]).toEqual({ ...current, c: 115, h: 115, l: 102 });

  const deduped = recentDailyBars(page([first, current], current), 99, 5);
  expect(deduped).toHaveLength(2);
  expect(deduped[1]).toEqual({ ...current, c: 99, h: 112, l: 99 });
});

test("캔들 도형은 양봉·음봉·보합을 나누고 영역 안에 오른쪽 정렬로 배치한다", () => {
  const bars = [
    bar(1, 100, 110, 90, 108),
    bar(2, 108, 112, 96, 98),
    bar(3, 100, 104, 96, 100),
  ];
  const shapes = candleShapes(bars, CANDLE_STRIP_WIDTH, CANDLE_STRIP_HEIGHT, 15);
  expect(shapes.map((shape) => shape.side)).toEqual(["up", "down", "flat"]);
  expect(shapes[0]!.x).toBeGreaterThan(CANDLE_STRIP_WIDTH / 2);
  for (const shape of shapes) {
    expect(shape.wickTop).toBeGreaterThanOrEqual(2);
    expect(shape.wickBottom).toBeLessThanOrEqual(CANDLE_STRIP_HEIGHT - 2);
    expect(shape.bodyHeight).toBeGreaterThanOrEqual(1.2);
  }
});

test("모든 봉 가격이 같아도 NaN 없이 가운데에 그린다", () => {
  const shapes = candleShapes([bar(1, 100, 100, 100, 100)], 72, 24, 10);
  expect(shapes).toHaveLength(1);
  expect(Number.isFinite(shapes[0]!.wickTop)).toBe(true);
  expect(shapes[0]!.wickTop).toBe(12);
});
