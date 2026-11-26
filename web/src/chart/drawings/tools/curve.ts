import { at, defaultFill, defaultStroke, LINE_ENDS, readFill, readOneOf, readRecord, readStroke, select, strokeFields, strokeOpacity } from "../styleKit";
import { defineTool, type Shape } from "../toolSpec";
import type { DrawingPoint, Fill, LineEnd, ScreenPoint, Stroke } from "../types";

export interface CurveStyle {
  v: 1;
  line: Stroke;
  fill: Fill;
  leftEnd: LineEnd;
  rightEnd: LineEnd;
}

const END_OPTIONS: readonly { value: LineEnd; label: string }[] = [
  { value: "plain", label: "없음" },
  { value: "arrow", label: "화살표" },
];

const CURVE_STEPS = 32;

export const curveDefaults = (): CurveStyle => ({
  v: 1,
  line: defaultStroke(),
  fill: { ...defaultFill(), on: false },
  leftEnd: "plain",
  rightEnd: "plain",
});

export function parseCurveStyle(raw: unknown): CurveStyle {
  const d = curveDefaults();
  const o = readRecord(raw);
  return {
    ...o,
    v: 1,
    line: readStroke(o.line, d.line),
    fill: readFill(o.fill, d.fill),
    leftEnd: readOneOf(o.leftEnd, LINE_ENDS, d.leftEnd),
    rightEnd: readOneOf(o.rightEnd, LINE_ENDS, d.rightEnd),
  };
}

export function sampleQuadraticThrough(a: ScreenPoint, b: ScreenPoint, mid: ScreenPoint, steps = CURVE_STEPS): ScreenPoint[] {
  const control = {
    x: 2 * mid.x - 0.5 * (a.x + b.x),
    y: 2 * mid.y - 0.5 * (a.y + b.y),
  };
  const out: ScreenPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const inv = 1 - t;
    out.push({
      x: inv * inv * a.x + 2 * inv * t * control.x + t * t * b.x,
      y: inv * inv * a.y + 2 * inv * t * control.y + t * t * b.y,
    });
  }
  return out;
}

const L = at<CurveStyle>();
const replace = (i: number) => (pts: readonly DrawingPoint[], to: DrawingPoint) => pts.map((q, j) => (j === i ? to : q));

export const curve = defineTool<CurveStyle>({
  tool: "curve",
  group: "shape",
  label: "곡선",
  icon: "M3 18 Q12 3 21 18",
  placement: { kind: "points", count: 3 },
  pointRoles: [
    { label: "시작", uses: "both" },
    { label: "끝", uses: "both" },
    { label: "곡률", uses: "both" },
  ],
  defaultStyle: curveDefaults,
  parseStyle: parseCurveStyle,
  bar: {
    lineColor: L("line", "color"),
    lineOpacity: strokeOpacity(L("line")),
    width: L("line", "width"),
    dash: L("line", "dash"),
    fill: L("fill"),
  },
  settings: {
    style: [
      ...strokeFields("선", L("line")),
      select("왼쪽 끝", END_OPTIONS, L("leftEnd")),
      select("오른쪽 끝", END_OPTIONS, L("rightEnd")),
      { kind: "fill", label: "채움", lens: L("fill") },
    ],
  },
  shapes({ points, style }, ctx) {
    const [p0, p1, p2] = points;
    const a = p0 === undefined ? null : ctx.toScreen(p0);
    const b = p1 === undefined ? null : ctx.toScreen(p1);
    if (a === null || b === null) return [];
    const m = p2 === undefined ? null : ctx.toScreen(p2);
    if (m === null) return [{ kind: "segment", a, b, stroke: style.line }];
    const sampled = sampleQuadraticThrough(a, b, m);
    const shapes: Shape[] = [];
    if (style.fill.on) shapes.push({ kind: "polyline", points: sampled, closed: true, fill: style.fill });
    shapes.push({ kind: "polyline", points: sampled, closed: false, stroke: style.line });
    if (style.leftEnd === "arrow" && sampled.length >= 2) {
      shapes.push({ kind: "segment", a: sampled[1]!, b: sampled[0]!, stroke: style.line, ends: { left: "plain", right: "arrow" } });
    }
    if (style.rightEnd === "arrow" && sampled.length >= 2) {
      shapes.push({ kind: "segment", a: sampled[sampled.length - 2]!, b: sampled[sampled.length - 1]!, stroke: style.line, ends: { left: "plain", right: "arrow" } });
    }
    return shapes;
  },
  handles({ points }, ctx) {
    const [p0, p1, p2] = points;
    const a = p0 === undefined ? null : ctx.toScreen(p0);
    const b = p1 === undefined ? null : ctx.toScreen(p1);
    if (a === null || b === null) return [];
    const m = p2 === undefined ? null : ctx.toScreen(p2);
    return [
      { at: a, move: replace(0) },
      { at: b, move: replace(1) },
      ...(m === null ? [] : [{ at: m, move: replace(2) }]),
    ];
  },
  axisLabels: () => [],
});
