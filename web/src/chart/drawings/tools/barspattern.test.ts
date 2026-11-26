import { describe, expect, test } from "vitest";
import type { Bar } from "../../../api/generated/Bar";
import type { ToolContext } from "../toolSpec";
import { barspattern, barsPatternDefaults, projectPrice } from "./barspattern";

const sampleBars: Bar[] = [
  { t: 100, o: 100, h: 115, l: 95, c: 110, v: 1000 },
  { t: 160, o: 110, h: 125, l: 105, c: 120, v: 1200 },
  { t: 220, o: 120, h: 122, l: 108, c: 112, v: 900 },
];

const makeCtx = (bars: readonly Bar[]): ToolContext => ({
  toScreen: (p) => ({ x: p.t, y: 500 - p.price }),
  fromScreen: (s) => ({ t: s.x, price: 500 - s.y }),
  xOf: (t) => t,
  yOf: (p) => 500 - p,
  timeAt: (x) => x,
  priceAt: (y) => 500 - y,
  shiftBars: (t, n) => t + n * 60,
  barsBetween: () => null,
  barsIn: () => bars,
  period: "D",
  fineBarsIn: () => ({ kind: "loading" }),
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: String,
  formatTime: String,
  logScale: false,
});

describe("봉 패턴", () => {
  test("비율 유지 및 상하 반전 투영 가격을 정확히 계산한다", () => {
    expect(projectPrice(120, 100, 200, "percent", false)).toBeCloseTo(240, 5);
    expect(projectPrice(120, 100, 200, "percent", true)).toBeCloseTo(160, 5);
    expect(projectPrice(120, 100, 200, "price", false)).toBeCloseTo(220, 5);
    expect(projectPrice(120, 100, 200, "price", true)).toBeCloseTo(180, 5);
  });

  test("원본 구간 봉을 복제 위치에 심지와 몸통으로 투영한다", () => {
    const style = barsPatternDefaults();
    const shapes = barspattern.shapes(
      { points: [{ t: 100, price: 100 }, { t: 220, price: 112 }, { t: 400, price: 200 }], style, text: null, selected: false },
      makeCtx(sampleBars),
    );
    const rects = shapes.filter((s) => s.kind === "rect");
    expect(rects).toHaveLength(3);
    expect(rects[0]).toMatchObject({ fill: { on: true, color: "$up", opacity: 0.45 } });
    expect(rects[2]).toMatchObject({ fill: { on: true, color: "$down", opacity: 0.45 } });
  });

  test("원본 봉이 비어 있어도 선택·삭제 가능한 연결선 도형을 반환한다", () => {
    const style = barsPatternDefaults();
    const shapes = barspattern.shapes(
      { points: [{ t: 100, price: 100 }, { t: 220, price: 112 }, { t: 400, price: 200 }], style, text: null, selected: false },
      makeCtx([]),
    );
    expect(shapes.some((s) => s.kind === "segment")).toBe(true);
  });
});
