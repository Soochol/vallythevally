import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { arrowdown, arrowup } from "./arrowmark";

const ctx: ToolContext = {
  toScreen: (p) => ({ x: p.t, y: p.price }),
  fromScreen: (s) => ({ t: s.x, price: s.y }),
  xOf: (t) => t,
  yOf: (p) => p,
  timeAt: (x) => x,
  priceAt: (y) => y,
  shiftBars: (t, n) => t + n,
  barsBetween: () => null,
  barsIn: () => [],
  period: "D",
  fineBarsIn: () => ({ kind: "loading" }),
  paneWidth: 800,
  paneHeight: 600,
  formatPrice: (p) => `${p}원`,
  formatTime: String,
  logScale: false,
};

describe("매수·매도 화살표", () => {
  test("매수 화살표는 1클릭이며 위를 가리키고, 가격·메모 라벨을 아래에 붙인다", () => {
    const style = arrowup.parseStyle({ ...arrowup.defaultStyle() as object, showPrice: true });
    const shapes = arrowup.shapes({ points: [{ t: 200, price: 300 }], style, text: "1차 진입", selected: true }, ctx);
    expect(shapes[0]?.kind).toBe("polyline");
    expect(shapes[1]).toMatchObject({ kind: "text", text: "300원 · 1차 진입", baseline: "top" });
  });

  test("매도 화살표는 아래를 가리키고 하락 기본색을 쓴다", () => {
    const style = arrowdown.defaultStyle() as { color: string };
    expect(style.color).toBe("$down");
    const shapes = arrowdown.shapes({ points: [{ t: 200, price: 300 }], style, text: "익절", selected: false }, ctx);
    expect(shapes[0]).toMatchObject({ kind: "polyline", closed: true, fill: { on: true, color: "$down" } });
    expect(shapes[1]).toMatchObject({ kind: "text", text: "익절", baseline: "bottom" });
  });
});
