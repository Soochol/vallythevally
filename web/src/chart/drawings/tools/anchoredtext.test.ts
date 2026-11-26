import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { anchoredtext, anchoredTextDefaults, type AnchoredTextStyle } from "./anchoredtext";

const makeCtx = (offsetX = 0): ToolContext => ({
  toScreen: (p) => ({ x: p.t - offsetX, y: p.price }),
  fromScreen: (s) => ({ t: s.x + offsetX, price: s.y }),
  xOf: (t) => t - offsetX,
  yOf: (p) => p,
  timeAt: (x) => x + offsetX,
  priceAt: (y) => y,
  shiftBars: (t, n) => t + n,
  barsBetween: () => null,
  barsIn: () => [],
  period: "D",
  fineBarsIn: () => ({ kind: "loading" }),
  paneWidth: 1000,
  paneHeight: 500,
  formatPrice: String,
  formatTime: String,
  logScale: false,
});

describe("고정 글자", () => {
  test("배치한 화면 좌표를 비율로 저장하고 차트를 스크롤해도 같은 화면 위치에 남는다", () => {
    const ctx0 = makeCtx(0);
    const point = { t: 300, price: 125 };
    const placed = anchoredtext.initStyle!([point], anchoredTextDefaults(), ctx0) as AnchoredTextStyle;
    expect(placed.anchorX).toBeCloseTo(0.3, 3);
    expect(placed.anchorY).toBeCloseTo(0.25, 3);

    const scrolledCtx = makeCtx(5000);
    const shapes = anchoredtext.shapes({ points: [point], style: placed, text: "핵심 투자 아이디어", selected: false }, scrolledCtx);
    expect(shapes[0]).toMatchObject({ kind: "text", at: { x: 300, y: 125 }, text: "핵심 투자 아이디어" });
  });

  test("몸통 이동은 뷰포트 비율을 갱신하고 화면 밖으로 벗어나지 않는다", () => {
    const ctx = makeCtx(0);
    const base = { ...anchoredTextDefaults(), anchorX: 0.5, anchorY: 0.5 };
    const moved = anchoredtext.moveBody!({ points: [{ t: 500, price: 250 }], style: base, text: "메모", selected: true }, { x: 100, y: -50 }, ctx);
    const nextStyle = moved.style as AnchoredTextStyle;
    expect(nextStyle.anchorX).toBeCloseTo(0.6, 3);
    expect(nextStyle.anchorY).toBeCloseTo(0.4, 3);
    const clamped = anchoredtext.moveBody!({ points: [{ t: 500, price: 250 }], style: base, text: "메모", selected: true }, { x: 9999, y: -9999 }, ctx);
    expect((clamped.style as AnchoredTextStyle).anchorX).toBe(0.96);
    expect((clamped.style as AnchoredTextStyle).anchorY).toBe(0.02);
  });
});
