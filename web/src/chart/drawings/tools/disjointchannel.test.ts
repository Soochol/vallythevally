import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { disjointchannel, disjointChannelDefaults } from "./disjointchannel";

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
  formatPrice: (p) => `${p}원`,
  formatTime: (t) => `t${t}`,
  logScale: false,
};

const pts = [
  { t: 100, price: 100 },
  { t: 300, price: 200 },
  { t: 200, price: 300 },
];

describe("분리 채널", () => {
  test("평평하게(flat) 모드에서는 반대편 선이 셋째 점 가격으로 수평을 유지한다", () => {
    const style = disjointChannelDefaults();
    const shapes = disjointchannel.shapes({ points: pts, style, text: null, selected: false }, ctx);
    expect(shapes).toHaveLength(4);
    expect(shapes[2]).toMatchObject({ kind: "segment", a: { x: 100, y: 200 }, b: { x: 300, y: 200 } });
  });

  test("반대 기울기(mirror) 모드에서는 기준선과 대칭인 기울기를 만들고 중앙 핸들이 셋째 점 높이에 놓인다", () => {
    const style = disjointchannel.parseStyle({ ...disjointChannelDefaults(), mode: "mirror" });
    const shapes = disjointchannel.shapes({ points: pts, style, text: null, selected: false }, ctx);
    const opposite = shapes[2];
    expect(opposite).toMatchObject({ kind: "segment", a: { x: 100, y: 150 }, b: { x: 300, y: 250 } });
    const handles = disjointchannel.handles({ points: pts, style, text: null, selected: true }, ctx);
    expect(handles[2]?.at).toEqual({ x: 200, y: 200 });
  });
});
