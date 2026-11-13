import { at, defaultFill, defaultStroke, readBool, readFill, readRecord, readStroke, strokeFields } from "../styleKit";
import { defineTool, type HandleSpec, type ToolContext } from "../toolSpec";
import type { DrawingPoint, Fill, ScreenPoint, Stroke } from "../types";

export interface PathStyle {
  v: 1;
  line: Stroke;
  closed: boolean;
  fill: Fill;
}

export const pathDefaults = (): PathStyle => ({ v: 1, line: defaultStroke(), closed: false, fill: defaultFill() });

export function parsePathStyle(raw: unknown): PathStyle {
  const d = pathDefaults();
  const o = readRecord(raw);
  return { ...o, v: 1, line: readStroke(o.line, d.line), closed: readBool(o.closed, d.closed), fill: readFill(o.fill, d.fill) };
}

export function visibleVertices(points: readonly DrawingPoint[], ctx: ToolContext): { index: number; at: ScreenPoint }[] {
  return points.flatMap((p, index) => {
    const screen = ctx.toScreen(p);
    return screen === null ? [] : [{ index, at: screen }];
  });
}

const L = at<PathStyle>();

export const path = defineTool<PathStyle>({
  tool: "path",
  group: "shape",
  label: "꺾은선",
  icon: "M3 18 L9 8 L14 14 L21 5",
  placement: { kind: "polyline", min: 2, max: 100 },
  defaultStyle: pathDefaults,
  parseStyle: parsePathStyle,
  bar: { lineColor: L("line", "color"), fill: L("fill"), width: L("line", "width"), dash: L("line", "dash") },
  settings: {
    style: [...strokeFields("선", L("line")), { kind: "toggle", label: "닫기", lens: L("closed") }, { kind: "fill", label: "채움", lens: L("fill") }],
  },
  shapes({ points, style }, ctx) {
    const vertices = visibleVertices(points, ctx).map((v) => v.at);
    if (vertices.length < 2) return [];
    const closed = style.closed && vertices.length >= 3;
    return [{ kind: "polyline", points: vertices, closed, stroke: style.line, ...(closed ? { fill: style.fill } : {}) }];
  },
  handles({ points }, ctx) {
    return visibleVertices(points, ctx).map(({ index, at }): HandleSpec => ({ at, move: (pts, to) => pts.map((q, j) => (j === index ? to : q)) }));
  },
  axisLabels() {
    return [];
  },
});
