import { at, defaultFill, defaultStroke, readFill, readRecord, readStroke, strokeFields } from "../styleKit";
import { defineTool, type HandleSpec } from "../toolSpec";
import type { Fill, Stroke } from "../types";
import { visibleVertices } from "./path";

export interface TriangleStyle {
  v: 1;
  border: Stroke;
  fill: Fill;
}

export const triangleDefaults = (): TriangleStyle => ({ v: 1, border: defaultStroke(), fill: defaultFill() });

export function parseTriangleStyle(raw: unknown): TriangleStyle {
  const d = triangleDefaults();
  const o = readRecord(raw);
  return { ...o, v: 1, border: readStroke(o.border, d.border), fill: readFill(o.fill, d.fill) };
}

const L = at<TriangleStyle>();

export const triangle = defineTool<TriangleStyle>({
  tool: "triangle",
  group: "shape",
  label: "삼각형",
  icon: "M12 4 L21 19 L3 19 Z",
  placement: { kind: "points", count: 3 },
  pointRoles: [
    { label: "꼭짓점 1", uses: "both" },
    { label: "꼭짓점 2", uses: "both" },
    { label: "꼭짓점 3", uses: "both" },
  ],
  defaultStyle: triangleDefaults,
  parseStyle: parseTriangleStyle,
  bar: { lineColor: L("border", "color"), fill: L("fill"), width: L("border", "width"), dash: L("border", "dash") },
  settings: { style: [...strokeFields("테두리", L("border")), { kind: "fill", label: "채움", lens: L("fill") }] },
  shapes({ points, style }, ctx) {
    const [a, b, c] = visibleVertices(points, ctx).map((v) => v.at);
    if (a === undefined || b === undefined) return [];
    if (c === undefined) return [{ kind: "segment", a, b, stroke: style.border }];
    return [{ kind: "polyline", points: [a, b, c], closed: true, stroke: style.border, fill: style.fill }];
  },
  handles({ points }, ctx) {
    return visibleVertices(points, ctx).map(({ index, at }): HandleSpec => ({ at, move: (pts, to) => pts.map((q, j) => (j === index ? to : q)) }));
  },
  axisLabels() {
    return [];
  },
});
