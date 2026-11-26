import { expect, test } from "vitest";
import { THEME_KEYS, type ThemeKey } from "../../persist/theme";
import { contrastRatio, over, parseColor, parseThemeProperties, type Rgba } from "../../styles/colorMath";
import tokensCss from "../../styles/tokens.css?raw";
import { COLOR_RANGES, legendStops, mixPercent, needsStrongInk, rateFill, rateSide, rateStrength } from "./colors";

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
  expect(rateFill(2.4, 3)).toContain("var(--tile-up)");
  expect(rateFill(-2.4, 3)).toContain("var(--tile-down)");
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

test("진한 칸만 밝은 글자를 쓴다", () => {
  expect(needsStrongInk(8, 8)).toBe(true);
  expect(needsStrongInk(-8, 8)).toBe(true);
  expect(needsStrongInk(1, 8)).toBe(false);
  expect(needsStrongInk(0, 3)).toBe(false);
});

const mixOver = (top: Rgba, base: Rgba, share: number): Rgba => over({ ...top, a: share }, base);

function tileColorsFor(theme: ThemeKey, rate: number, range: (typeof COLOR_RANGES)[number]): { fill: Rgba; ink: Rgba } {
  const properties = parseThemeProperties(tokensCss, theme);
  const token = (name: string) => parseColor(properties.get(name) ?? (() => { throw new Error(`토큰이 없다: ${name}`); })());
  const side = rateSide(rate);
  const fill = side === "flat" ? token("--raised") : mixOver(token(`--tile-${side}`), token("--surface"), mixPercent(rate, range) / 100);
  return { fill, ink: needsStrongInk(rate, range) ? token("--tile-ink-strong") : token("--text") };
}

for (const theme of THEME_KEYS) {
  test(`[${theme}] 모든 단계에서 타일 글자 대비가 4.5:1 이상이다`, () => {
    for (const range of COLOR_RANGES) {
      for (let step = -range * 100; step <= range * 100; step += 1) {
        const { fill, ink } = tileColorsFor(theme, step / 100, range);
        expect(contrastRatio(ink, fill), `${theme} ${step / 100}% (범위 ${range})`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
}

test("±0.5% 안팎도 보합과 구분되는 색 비율이다", () => {
  expect(mixPercent(0.5, 8)).toBeGreaterThanOrEqual(24);
  expect(mixPercent(0.5, 15)).toBeGreaterThanOrEqual(24);
  expect(rateFill(0.5, 8)).not.toBe(rateFill(0, 8));
});
