import { extendedSegment, type Pane } from "../geometry";
import { at, defaultFill, defaultStroke, readBool, readFill, readRecord, readStroke, strokeFields } from "../styleKit";
import { type AxisLabel, defineTool, type HandleSpec, type Shape } from "../toolSpec";
import type { DrawingPoint, Fill, ScreenPoint, Stroke } from "../types";

export interface PitchforkStyle {
  v: 1;
  line: Stroke;
  fill: Fill;
  inner: boolean;
}

export const pitchforkDefaults = (): PitchforkStyle => ({
  v: 1,
  line: defaultStroke(),
  fill: defaultFill(),
  inner: false,
});

export function parsePitchforkStyle(raw: unknown): PitchforkStyle {
  const d = pitchforkDefaults();
  const o = readRecord(raw);
  return {
    ...o,
    v: 1,
    line: readStroke(o.line, d.line),
    fill: readFill(o.fill, d.fill),
    inner: readBool(o.inner, d.inner),
  };
}

const mid = (a: ScreenPoint, b: ScreenPoint): ScreenPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function rayFrom(from: ScreenPoint, d: ScreenPoint, pane: Pane): { a: ScreenPoint; b: ScreenPoint } {
  const through = { x: from.x + d.x, y: from.y + d.y };
  return extendedSegment(from, through, from.x <= through.x ? "right" : "left", pane);
}

const L = at<PitchforkStyle>();
const replace = (i: number) => (pts: readonly DrawingPoint[], to: DrawingPoint) => pts.map((q, j) => (j === i ? to : q));

export const pitchfork = defineTool<PitchforkStyle>({
  tool: "pitchfork",
  group: "line",
  label: "피치포크",
  icon: "M3 12 H21 M8 5 V19 M8 5 H21 M8 19 H21",
  placement: { kind: "points", count: 3 },
  pointRoles: [
    { label: "기준점", uses: "both" },
    { label: "둘째 점", uses: "both" },
    { label: "셋째 점", uses: "both" },
  ],
  defaultStyle: pitchforkDefaults,
  parseStyle: parsePitchforkStyle,
  bar: { lineColor: L("line", "color"), width: L("line", "width"), dash: L("line", "dash"), fill: L("fill") },
  settings: {
    style: [
      ...strokeFields("선", L("line")),
      { kind: "fill", label: "채움", lens: L("fill") },
      { kind: "toggle", label: "안쪽 선", lens: L("inner") },
    ],
  },
  shapes({ points, style }, ctx) {
    const [base, second, third] = points.map((p) => ctx.toScreen(p));
    if (second == null) return [];
    if (third == null) return base == null ? [] : [{ kind: "segment", a: base, b: second, stroke: style.line }];
    const handle: Shape = { kind: "segment", a: second, b: third, stroke: style.line };
    if (base == null) return [handle];
    const m = mid(second, third);
    const d = { x: m.x - base.x, y: m.y - base.y };
    if (d.x === 0 && d.y === 0) return [handle];
    const pane = { width: ctx.paneWidth, height: ctx.paneHeight };
    const upper = rayFrom(second, d, pane);
    const lower = rayFrom(third, d, pane);
    const shapes: Shape[] = [];
    if (style.fill.on) shapes.push({ kind: "polyline", points: [upper.a, upper.b, lower.b, lower.a], closed: true, fill: style.fill });
    shapes.push({ kind: "segment", ...rayFrom(base, d, pane), stroke: style.line });
    shapes.push({ kind: "segment", ...upper, stroke: style.line }, { kind: "segment", ...lower, stroke: style.line }, handle);
    if (style.inner)
      for (const from of [mid(second, m), mid(third, m)]) shapes.push({ kind: "segment", ...rayFrom(from, d, pane), stroke: style.line });
    return shapes;
  },
  handles({ points }, ctx) {
    const handles: HandleSpec[] = [];
    points.forEach((p, i) => {
      const s = ctx.toScreen(p);
      if (s !== null) handles.push({ at: s, move: replace(i) });
    });
    return handles;
  },
  axisLabels({ points, style, selected }, ctx) {
    if (!selected) return [];
    return points.flatMap((p): AxisLabel[] => [
      { axis: "price", value: p.price, text: ctx.formatPrice(p.price), color: style.line.color },
      { axis: "time", value: p.t, text: ctx.formatTime(p.t), color: style.line.color },
    ]);
  },
});
