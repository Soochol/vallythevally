import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { path, pathDefaults } from "./path";

const ctx: ToolContext = {
  toScreen: (p) => (p.t < 0 ? null : { x: p.t / 10, y: 500 - p.price }),
  fromScreen: (s) => ({ t: s.x * 10, price: 500 - s.y }),
  xOf: (t) => (t < 0 ? null : t / 10),
  yOf: (price) => 500 - price,
  timeAt: (x) => x * 10,
  priceAt: (y) => 500 - y,
  shiftBars: (t, n) => t + n * 60,
  barsBetween: () => null,
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: String,
  formatTime: String,
  logScale: false,
};
const style = pathDefaults();
const points = [
  { t: 1000, price: 100 },
  { t: 2000, price: 200 },
  { t: 3000, price: 100 },
];

describe("꺾은선", () => {
  test("클릭마다 점을 더하는 2~100점 배치", () => {
    expect(path.placement).toEqual({ kind: "polyline", min: 2, max: 100 });
  });

  test("열린 꺾은선은 채우지 않는다", () => {
    expect(path.shapes({ points, style, text: null, selected: false }, ctx)).toEqual([
      { kind: "polyline", points: [{ x: 100, y: 400 }, { x: 200, y: 300 }, { x: 300, y: 400 }], closed: false, stroke: style.line },
    ]);
  });

  test("닫으면 끝점과 첫 점을 잇고 채운다", () => {
    const closed = path.parseStyle({ ...style, closed: true });
    expect(path.shapes({ points, style: closed, text: null, selected: false }, ctx)).toMatchObject([{ kind: "polyline", closed: true, fill: style.fill }]);
    expect(path.shapes({ points: points.slice(0, 2), style: closed, text: null, selected: false }, ctx)).toMatchObject([{ closed: false }]);
  });

  test("화면에 못 놓는 점은 건너뛰고, 그릴 점이 둘보다 적으면 비운다", () => {
    const partial = [{ t: -1, price: 5 }, ...points];
    expect(path.shapes({ points: partial, style, text: null, selected: true }, ctx)).toMatchObject([{ points: [{ x: 100 }, { x: 200 }, { x: 300 }] }]);
    expect(path.shapes({ points: points.slice(0, 1), style, text: null, selected: true }, ctx)).toEqual([]);
  });

  test("꼭짓점마다 핸들이 있고 자기 점만 바꾼다", () => {
    const partial = [{ t: -1, price: 5 }, ...points];
    const handles = path.handles({ points: partial, style, text: null, selected: true }, ctx);
    expect(handles.map((h) => h.at)).toEqual([{ x: 100, y: 400 }, { x: 200, y: 300 }, { x: 300, y: 400 }]);
    const to = { t: 9000, price: 9 };
    expect(handles[1]?.move(partial, to, ctx)).toEqual([partial[0], points[0], to, points[2]]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    expect(path.parseStyle({ v: 1, future: 1, closed: "yes", line: { width: 4 } })).toMatchObject({ future: 1, closed: false, line: { width: 4, dash: "solid" } });
    expect(path.parseStyle([])).toEqual(style);
  });

  test("막대는 선과 채움을 고친다", () => {
    expect(path.bar.width?.set(style, 5)).toMatchObject({ line: { width: 5 } });
    expect(path.bar.fill?.get(style)).toEqual(style.fill);
  });
});
