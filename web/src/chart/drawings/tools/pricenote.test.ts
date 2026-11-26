import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { pricenote, priceNoteDefaults } from "./pricenote";

const ctx: ToolContext = {
  toScreen: (p) => ({ x: p.t, y: 500 - p.price }),
  fromScreen: (s) => ({ t: s.x, price: 500 - s.y }),
  xOf: (t) => t,
  yOf: (p) => 500 - p,
  timeAt: (x) => x,
  priceAt: (y) => 500 - y,
  shiftBars: (t, n) => t + n,
  barsBetween: () => null,
  barsIn: () => [],
  period: "D",
  fineBarsIn: () => ({ kind: "loading" }),
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: (p) => `${p.toLocaleString()}원`,
  formatTime: String,
  logScale: false,
  lastPrice: 1000,
};

describe("가격 노트", () => {
  test("가격, 현재가 괴리율, 사용자 메모를 한 카드에 표시한다", () => {
    const style = priceNoteDefaults();
    const shapes = pricenote.shapes(
      { points: [{ t: 100, price: 1100 }, { t: 220, price: 1200 }], style, text: "돌파 매수", selected: true },
      ctx,
    );
    const textShape = shapes.find((s) => s.kind === "text");
    expect(textShape?.kind === "text" && textShape.text).toBe("1,100원 (+10.0%)\n돌파 매수");
    expect(pricenote.axisLabels({ points: [{ t: 100, price: 1100 }, { t: 220, price: 1200 }], style, text: null, selected: true }, ctx)).toHaveLength(1);
  });

  test("괴리율 옵션을 끄면 가격과 메모만 표시한다", () => {
    const style = pricenote.parseStyle({ ...priceNoteDefaults(), showGap: false });
    const shapes = pricenote.shapes(
      { points: [{ t: 100, price: 1100 }, { t: 220, price: 1200 }], style, text: null, selected: false },
      ctx,
    );
    const textShape = shapes.find((s) => s.kind === "text");
    expect(textShape?.kind === "text" && textShape.text).toBe("1,100원");
  });
});
