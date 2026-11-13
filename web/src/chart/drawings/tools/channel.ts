import { at, defaultFill, defaultStroke, EXTEND_OPTIONS, EXTENDS, readBool, readFill, readOneOf, readRecord, readStroke, select, strokeFields } from "../styleKit";
import { type AxisLabel, defineTool, type Shape, type ToolContext } from "../toolSpec";
import type { DrawingPoint, Extend, Fill, ScreenPoint, Stroke } from "../types";

export interface ChannelStyle {
  v: 1;
  line: Stroke;
  middle: { on: boolean; line: Stroke };
  fill: Fill;
  extend: Extend;
}

export const channelDefaults = (): ChannelStyle => ({
  v: 1,
  line: defaultStroke(),
  middle: { on: true, line: { ...defaultStroke(), width: 1, dash: "dashed" } },
  fill: defaultFill(),
  extend: "none",
});

export function parseChannelStyle(raw: unknown): ChannelStyle {
  const d = channelDefaults();
  const o = readRecord(raw);
  const middle = readRecord(o.middle);
  return {
    ...o,
    v: 1,
    line: readStroke(o.line, d.line),
    middle: { ...middle, on: readBool(middle.on, d.middle.on), line: readStroke(middle.line, d.middle.line) },
    fill: readFill(o.fill, d.fill),
    extend: readOneOf(o.extend, EXTENDS, d.extend),
  };
}

const plus = (p: ScreenPoint, d: ScreenPoint, k = 1): ScreenPoint => ({ x: p.x + k * d.x, y: p.y + k * d.y });

function offsetTo(a: ScreenPoint, b: ScreenPoint, c: ScreenPoint): ScreenPoint {
  const d = { x: b.x - a.x, y: b.y - a.y };
  const length2 = d.x * d.x + d.y * d.y;
  const along = length2 === 0 ? 0 : ((c.x - a.x) * d.x + (c.y - a.y) * d.y) / length2;
  return { x: c.x - a.x - along * d.x, y: c.y - a.y - along * d.y };
}

function stretched(a: ScreenPoint, b: ScreenPoint, extend: Extend, ctx: ToolContext): [ScreenPoint, ScreenPoint] {
  const d = { x: b.x - a.x, y: b.y - a.y };
  const length = Math.hypot(d.x, d.y);
  if (extend === "none" || length === 0) return [a, b];
  const far = (Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y)) + ctx.paneWidth + ctx.paneHeight) / length;
  const left = extend === "left" || extend === "both";
  const right = extend === "right" || extend === "both";
  const before = a.x <= b.x ? left : right;
  const after = a.x <= b.x ? right : left;
  return [before ? plus(a, d, -far) : a, after ? plus(b, d, far) : b];
}

function screenPoints(points: readonly DrawingPoint[], ctx: ToolContext) {
  const [p0, p1, p2] = points;
  const a = p0 === undefined ? null : ctx.toScreen(p0);
  const b = p1 === undefined ? null : ctx.toScreen(p1);
  if (a === null || b === null) return null;
  const c = p2 === undefined ? null : ctx.toScreen(p2);
  return { a, b, offset: c === null ? null : offsetTo(a, b, c) };
}

const L = at<ChannelStyle>();
const replace = (i: number) => (pts: readonly DrawingPoint[], to: DrawingPoint) => pts.map((q, j) => (j === i ? to : q));

export const channel = defineTool<ChannelStyle>({
  tool: "channel",
  group: "line",
  label: "평행 채널",
  icon: "M3 14 L14 3 M10 21 L21 10",
  placement: { kind: "points", count: 3 },
  pointRoles: [
    { label: "시작", uses: "both" },
    { label: "끝", uses: "both" },
    { label: "폭", uses: "both" },
  ],
  defaultStyle: channelDefaults,
  parseStyle: parseChannelStyle,
  bar: { lineColor: L("line", "color"), width: L("line", "width"), dash: L("line", "dash"), fill: L("fill") },
  settings: {
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
    const [start, end] = stretched(screen.a, screen.b, style.extend, ctx);
    const base: Shape = { kind: "segment", a: start, b: end, stroke: style.line };
    const d = screen.offset;
    if (d === null) return [base];
    const shapes: Shape[] = [];
    if (style.fill.on) shapes.push({ kind: "polyline", points: [start, end, plus(end, d), plus(start, d)], closed: true, fill: style.fill });
    shapes.push(base, { kind: "segment", a: plus(start, d), b: plus(end, d), stroke: style.line });
    if (style.middle.on) shapes.push({ kind: "segment", a: plus(start, d, 0.5), b: plus(end, d, 0.5), stroke: style.middle.line });
    return shapes;
  },
  handles({ points }, ctx) {
    const screen = screenPoints(points, ctx);
    if (screen === null) return [];
    const { a, b, offset } = screen;
    const ends = [
      { at: a, move: replace(0) },
      { at: b, move: replace(1) },
    ];
    return offset === null ? ends : [...ends, { at: plus({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, offset), move: replace(2) }];
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
