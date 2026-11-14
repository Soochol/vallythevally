import { describe, expect, test } from "vitest";
import type { Shape, ToolContext } from "../toolSpec";
import { LABEL_GAP, patternDefaults, pointLabels, screensOf } from "./patternKit";
import { elliott } from "./elliott";

const ctx: ToolContext = {
  toScreen: (p) => (p.t < 0 ? null : { x: p.t / 10, y: 500 - p.price }),
  fromScreen: (s) => ({ t: s.x * 10, price: 500 - s.y }),
  xOf: (t) => (t < 0 ? null : t / 10),
  yOf: (price) => 500 - price,
  timeAt: (x) => x * 10,
  priceAt: (y) => 500 - y,
  shiftBars: (t, n) => t + n * 60,
  barsBetween: () => null,
  barsIn: () => [],
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: String,
  formatTime: String,
  logScale: false,
};
const textStyle = { color: "$draw", size: 14, bold: false, italic: false };
const zigzag = [
  { t: 1000, price: 100 },
  { t: 2000, price: 300 },
  { t: 3000, price: 200 },
  { t: 4000, price: 400 },
  { t: 5000, price: 250 },
  { t: 6000, price: 450 },
];
const style = { ...patternDefaults(), form: "number" };
const drawn = (points: typeof zigzag) => elliott.shapes({ points, style, text: null, selected: false }, ctx);
const texts = (shapes: Shape[]) => shapes.flatMap((s) => (s.kind === "text" ? [[s.text, s.baseline, s.at.y]] : []));

describe("패턴 도구의 공통 틀", () => {
  test("봉우리 점의 꼬리표는 점 위에, 골 점의 꼬리표는 점 아래에 둔다", () => {
    const labels = pointLabels(screensOf(zigzag.slice(0, 3), ctx), ["0", "1", "2"], textStyle);
    expect(labels).toEqual([
      { kind: "text", at: { x: 100, y: 400 + LABEL_GAP }, text: "0", style: textStyle, align: "center", baseline: "top" },
      { kind: "text", at: { x: 200, y: 200 - LABEL_GAP }, text: "1", style: textStyle, align: "center", baseline: "bottom" },
      { kind: "text", at: { x: 300, y: 300 + LABEL_GAP }, text: "2", style: textStyle, align: "center", baseline: "top" },
    ]);
  });

  test("끝점은 이웃 하나와만 견주고, 이웃이 없거나 같은 높이면 아래에 둔다", () => {
    const rising = screensOf([zigzag[0]!, zigzag[1]!], ctx);
    expect(pointLabels(rising, ["a", "b"], textStyle).map((s) => s.kind === "text" && s.baseline)).toEqual(["top", "bottom"]);
    expect(pointLabels(screensOf([zigzag[1]!], ctx), ["a"], textStyle)).toMatchObject([{ baseline: "top" }]);
    const flat = screensOf([{ t: 1000, price: 100 }, { t: 2000, price: 100 }], ctx);
    expect(pointLabels(flat, ["a", "b"], textStyle)).toMatchObject([{ baseline: "top" }, { baseline: "top" }]);
  });

  test("그리는 중에는 놓은 점까지만 잇고 꼬리표를 붙인다", () => {
    const shapes = drawn(zigzag.slice(0, 3));
    expect(shapes.filter((s) => s.kind === "segment")).toEqual([
      { kind: "segment", a: { x: 100, y: 400 }, b: { x: 200, y: 200 }, stroke: style.line },
      { kind: "segment", a: { x: 200, y: 200 }, b: { x: 300, y: 300 }, stroke: style.line },
    ]);
    expect(texts(shapes).map(([text]) => text)).toEqual(["0", "1", "2"]);
    expect(drawn(zigzag.slice(0, 1))).toMatchObject([{ kind: "text", text: "0" }]);
    expect(drawn([])).toEqual([]);
  });

  test("화면에 못 놓는 점은 건너뛰고 던지지 않는다", () => {
    const partial = [zigzag[0]!, { t: -1, price: 300 }, zigzag[2]!, zigzag[3]!];
    const shapes = drawn(partial);
    expect(shapes.filter((s) => s.kind === "segment")).toHaveLength(1);
    expect(texts(shapes).map(([text]) => text)).toEqual(["0", "2", "3"]);
    expect(elliott.handles({ points: partial, style, text: null, selected: true }, ctx)).toHaveLength(3);
  });

  test("점마다 핸들이 있고 자기 점만 바꾼다", () => {
    const handles = elliott.handles({ points: zigzag, style, text: null, selected: true }, ctx);
    expect(handles.map((h) => h.at)).toEqual(screensOf(zigzag, ctx));
    const to = { t: 9000, price: 9 };
    expect(handles[3]?.move(zigzag, to, ctx)).toEqual([...zigzag.slice(0, 3), to, ...zigzag.slice(4)]);
  });

  test("점 이름은 세부 설정의 좌표에 보이고, 축 라벨은 없다", () => {
    expect(elliott.pointRoles?.map((r) => r.label)).toEqual(["시작", "1파", "2파", "3파", "4파", "5파"]);
    expect(elliott.axisLabels({ points: zigzag, style, text: null, selected: true }, ctx)).toEqual([]);
  });

  test("막대는 선 색·굵기·모양과 글자 색을 고친다", () => {
    expect(elliott.bar.lineColor?.set(style, "#123456")).toMatchObject({ line: { color: "#123456" } });
    expect(elliott.bar.width?.set(style, 4)).toMatchObject({ line: { width: 4 } });
    expect(elliott.bar.dash?.set(style, "dashed")).toMatchObject({ line: { dash: "dashed" } });
    expect(elliott.bar.textColor?.set(style, "#654321")).toMatchObject({ labels: { color: "#654321" } });
    expect(elliott.bar.fill).toBeUndefined();
  });

  test("세부 설정은 선과 꼬리표 글자 모양을 고친다", () => {
    expect(elliott.settings.style?.map((f) => f.label)).toEqual(["선 색", "선 굵기", "선 모양"]);
    expect(elliott.settings.text?.map((f) => [f.kind, f.label])).toEqual([["select", "꼬리표 모양"], ["textStyle", "꼬리표 글자 모양"]]);
  });
});
