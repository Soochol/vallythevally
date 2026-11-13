import type { Time } from "lightweight-charts";
import { expect, test } from "vitest";
import { OverlayLineView } from "./overlayLine";

const time = 1_762_646_400 as Time;

test("선의 값과 주 시리즈 종가를 함께 들면 종가가 마지막 값이라 % 기준이 되고, 종가만 든 점은 빈 점이 아니다", () => {
  const view = new OverlayLineView();
  expect(view.priceValueBuilder({ time, value: 187.4, base: 209.13 })).toEqual([187.4, 209.13]);
  expect(view.priceValueBuilder({ time, base: 209.13 })).toEqual([209.13]);
  expect(view.isWhitespace({ time, base: 209.13 })).toBe(false);
  expect(view.isWhitespace({ time })).toBe(true);
});

test("아래 지표 패널의 선은 가격 패널의 기준가를 축 범위에 넣지 않는다", () => {
  const view = new OverlayLineView(false);
  expect(view.priceValueBuilder({ time, value: 45, base: 200000 })).toEqual([45]);
});

function strokes(halo: boolean) {
  const view = new OverlayLineView();
  const drawn: { width: number; alpha: number }[] = [];
  const ctx = {
    lineWidth: 0, globalAlpha: 1, strokeStyle: "", lineJoin: "", lineCap: "",
    beginPath() {}, moveTo() {}, lineTo() {}, arc() {},
    save() { saved.push(this.globalAlpha); }, restore() { this.globalAlpha = saved.pop() ?? 1; },
    stroke() { drawn.push({ width: this.lineWidth, alpha: this.globalAlpha }); },
  };
  const saved: number[] = [];
  const bars = [1, 2].map((x) => ({ x, time, originalData: { time, value: 100 + x, base: 100 }, barColor: "" }));
  view.update({ bars, barSpacing: 6, visibleRange: { from: 0, to: 2 } } as never, { ...view.defaultOptions(), color: "#B9A6FF", lineWidth: 2, halo });
  view.renderer().draw({ useMediaCoordinateSpace: (run: (scope: { context: typeof ctx }) => void) => run({ context: ctx }) } as never, ((v: number) => v) as never, false, undefined);
  return drawn;
}

test("미리보기 선은 같은 색의 옅은 후광을 먼저 그리고 원래 굵기의 선을 그 위에 그린다", () => {
  expect(strokes(false)).toEqual([{ width: 2, alpha: 1 }]);
  expect(strokes(true)).toEqual([{ width: 8, alpha: 0.18 }, { width: 2, alpha: 1 }]);
});
