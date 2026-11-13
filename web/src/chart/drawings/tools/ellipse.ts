import { at, defaultFill, defaultStroke, readFill, readRecord, readStroke, strokeFields } from "../styleKit";
import { defineTool } from "../toolSpec";
import type { Fill, Stroke } from "../types";
import { cornerHandles, cornerLabels, cornersOf } from "./rect";

export interface EllipseStyle {
  v: 1;
  border: Stroke;
  fill: Fill;
}

export const ellipseDefaults = (): EllipseStyle => ({ v: 1, border: defaultStroke(), fill: defaultFill() });

export function parseEllipseStyle(raw: unknown): EllipseStyle {
  const d = ellipseDefaults();
  const o = readRecord(raw);
  return { ...o, v: 1, border: readStroke(o.border, d.border), fill: readFill(o.fill, d.fill) };
}

const L = at<EllipseStyle>();

export const ellipse = defineTool<EllipseStyle>({
  tool: "ellipse",
  group: "shape",
  label: "타원",
  icon: "M3 12 A9 6 0 1 0 21 12 A9 6 0 1 0 3 12 Z",
  placement: { kind: "points", count: 2, shift: "square" },
  pointRoles: [
    { label: "시작", uses: "both" },
    { label: "끝", uses: "both" },
  ],
  defaultStyle: ellipseDefaults,
  parseStyle: parseEllipseStyle,
  bar: { lineColor: L("border", "color"), fill: L("fill"), width: L("border", "width"), dash: L("border", "dash") },
  settings: { style: [...strokeFields("테두리", L("border")), { kind: "fill", label: "채움", lens: L("fill") }] },
  shapes({ points, style }, ctx) {
    const corners = cornersOf(points, ctx);
    return corners === null ? [] : [{ kind: "ellipse", a: corners.a, b: corners.b, stroke: style.border, fill: style.fill }];
  },
  handles({ points }, ctx) {
    return cornerHandles(points, ctx);
  },
  axisLabels({ points, style, selected }, ctx) {
    return cornerLabels(points, selected, style.border.color, ctx);
  },
});
