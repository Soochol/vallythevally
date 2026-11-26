import { extendedSegment } from "../geometry";
import { at, defaultFill, defaultStroke, EXTEND_OPTIONS, EXTENDS, readBool, readFill, readOneOf, readRecord, readStroke, select, strokeFields, strokeOpacity } from "../styleKit";
import { type AxisLabel, defineTool, type Shape, type ToolContext } from "../toolSpec";
import type { DrawingPoint, Extend, Fill, ScreenPoint, Stroke } from "../types";

export type DisjointMode = "flat" | "mirror";
const DISJOINT_MODES: readonly DisjointMode[] = ["flat", "mirror"];

const MODE_OPTIONS: readonly { value: DisjointMode; label: string }[] = [
  { value: "flat", label: "평평하게 (상단·하단)" },
  { value: "mirror", label: "반대 기울기 (쐐기·확산)" },
];

export interface DisjointChannelStyle {
  v: 1;
  mode: DisjointMode;
  line: Stroke;
  middle: { on: boolean; line: Stroke };
  fill: Fill;
  extend: Extend;
}

export const disjointChannelDefaults = (): DisjointChannelStyle => ({
  v: 1,
  mode: "flat",
  line: defaultStroke(),
  middle: { on: true, line: { ...defaultStroke(), width: 1, dash: "dashed" } },
  fill: defaultFill(),
  extend: "none",
});

export function parseDisjointChannelStyle(raw: unknown): DisjointChannelStyle {
  const d = disjointChannelDefaults();
  const o = readRecord(raw);
  const middle = readRecord(o.middle);
  return {
    ...o,
    v: 1,
    mode: readOneOf(o.mode, DISJOINT_MODES, d.mode),
    line: readStroke(o.line, d.line),
    middle: { ...middle, on: readBool(middle.on, d.middle.on), line: readStroke(middle.line, d.middle.line) },
    fill: readFill(o.fill, d.fill),
    extend: readOneOf(o.extend, EXTENDS, d.extend),
  };
}

function oppositeEndpoints(a: ScreenPoint, b: ScreenPoint, c: ScreenPoint, mode: DisjointMode): { c1: ScreenPoint; c2: ScreenPoint } {
  if (mode === "flat") return { c1: { x: a.x, y: c.y }, c2: { x: b.x, y: c.y } };
  const halfDy = (b.y - a.y) / 2;
  return { c1: { x: a.x, y: c.y + halfDy }, c2: { x: b.x, y: c.y - halfDy } };
}

function screenPoints(points: readonly DrawingPoint[], ctx: ToolContext) {
  const [p0, p1, p2] = points;
  const a = p0 === undefined ? null : ctx.toScreen(p0);
  const b = p1 === undefined ? null : ctx.toScreen(p1);
  if (a === null || b === null) return null;
  const c = p2 === undefined ? null : ctx.toScreen(p2);
  return { a, b, c };
}

const mid = (p: ScreenPoint, q: ScreenPoint): ScreenPoint => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
const L = at<DisjointChannelStyle>();
const replace = (i: number) => (pts: readonly DrawingPoint[], to: DrawingPoint) => pts.map((q, j) => (j === i ? to : q));

export const disjointchannel = defineTool<DisjointChannelStyle>({
  tool: "disjointchannel",
  group: "line",
  label: "분리 채널",
  icon: "M3 7 H21 M3 19 L21 12",
  placement: { kind: "points", count: 3 },
  pointRoles: [
    { label: "시작", uses: "both" },
    { label: "끝", uses: "both" },
    { label: "반대편 선", uses: "both" },
  ],
  defaultStyle: disjointChannelDefaults,
  parseStyle: parseDisjointChannelStyle,
  bar: {
    lineColor: L("line", "color"),
    lineOpacity: strokeOpacity(L("line")),
    width: L("line", "width"),
    dash: L("line", "dash"),
    fill: L("fill"),
    extend: L("extend"),
  },
  settings: {
    inputs: [select("반대편 선", MODE_OPTIONS, L("mode"))],
    style: [
      ...strokeFields("선", L("line")),
      { kind: "fill", label: "채움", lens: L("fill") },
      { kind: "toggle", label: "가운데 선", lens: L("middle", "on") },
      ...strokeFields("가운데 선", L("middle", "line")),
      select("연장", EXTEND_OPTIONS, L("extend")),
    ],
  },
  shapes({ points, style }, ctx) {
    const screen = screenPoints(points, ctx);
    if (screen === null) return [];
    const pane = { width: ctx.paneWidth, height: ctx.paneHeight };
    const line1 = extendedSegment(screen.a, screen.b, style.extend, pane);
    const base: Shape = { kind: "segment", a: line1.a, b: line1.b, stroke: style.line };
    if (screen.c === null) return [base];
    const { c1, c2 } = oppositeEndpoints(screen.a, screen.b, screen.c, style.mode);
    const line2 = extendedSegment(c1, c2, style.extend, pane);
    const shapes: Shape[] = [];
    if (style.fill.on) {
      shapes.push({ kind: "polyline", points: [line1.a, line1.b, line2.b, line2.a], closed: true, fill: style.fill });
    }
    shapes.push(base, { kind: "segment", a: line2.a, b: line2.b, stroke: style.line });
    if (style.middle.on) {
      const mLine = extendedSegment(mid(screen.a, c1), mid(screen.b, c2), style.extend, pane);
      shapes.push({ kind: "segment", a: mLine.a, b: mLine.b, stroke: style.middle.line });
    }
    return shapes;
  },
  handles({ points }, ctx) {
    const screen = screenPoints(points, ctx);
    if (screen === null) return [];
    const { a, b, c } = screen;
    const ends = [
      { at: a, move: replace(0) },
      { at: b, move: replace(1) },
    ];
    return c === null ? ends : [...ends, { at: { x: (a.x + b.x) / 2, y: c.y }, move: replace(2) }];
  },
  axisLabels({ points, style, selected }, ctx) {
    if (!selected) return [];
    const labels: AxisLabel[] = [];
    points.forEach((p, i) => {
      labels.push({ axis: "price", value: p.price, text: ctx.formatPrice(p.price), color: style.line.color });
      if (i < 2) labels.push({ axis: "time", value: p.t, text: ctx.formatTime(p.t), color: style.line.color });
    });
    return labels;
  },
});
