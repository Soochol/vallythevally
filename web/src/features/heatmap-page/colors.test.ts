import { expect, test } from "vitest";
import { COLOR_RANGES, legendStops, rateFill, rateSide, rateStrength } from "./colors";

test("색 세기는 범위에서 포화한다", () => {
  expect(rateStrength(1.5, 3)).toBeCloseTo(0.5);
  expect(rateStrength(-1.5, 3)).toBeCloseTo(0.5);
  expect(rateStrength(10, 3)).toBe(1);
  expect(rateStrength(10, 15)).toBeCloseTo(10 / 15);
});

test("같은 등락률도 색 범위가 넓으면 옅다", () => {
  const mix = (fill: string) => Number(/ (\d+)%/.exec(fill)![1]);
  const narrow = mix(rateFill(2.4, 3));
  const wide = mix(rateFill(2.4, 15));
  expect(narrow).toBeGreaterThan(wide);
  expect(rateFill(2.4, 3)).toContain("var(--up)");
  expect(rateFill(-2.4, 3)).toContain("var(--down)");
});

test("범위를 넘는 값은 같은 색이고 보합은 중립색이다", () => {
  expect(rateFill(3, 3)).toBe(rateFill(20, 3));
  expect(rateFill(-3, 3)).toBe(rateFill(-20, 3));
  expect(rateFill(0, 8)).toBe("var(--raised)");
  expect(rateSide(0.01)).toBe("up");
  expect(rateSide(-0.01)).toBe("down");
  expect(rateSide(0)).toBe("flat");
});

test("범례는 −범위에서 +범위까지 같은 간격이다", () => {
  for (const range of COLOR_RANGES) {
    const stops = legendStops(range);
    expect(stops[0]!.rate).toBe(-range);
    expect(stops.at(-1)!.rate).toBe(range);
    expect(stops[3]!.rate).toBeCloseTo(0);
    expect(stops[0]!.fill).toBe(rateFill(-range, range));
  }
});
