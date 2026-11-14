import type { Bar } from "../../../api/generated/Bar";
import { at, defaultFill, defaultStroke, defaultText, readBool, readFill, readOneOf, readRecord, readStroke, select, strokeFields } from "../styleKit";
import { type AxisLabel, defineTool, type Lens, type Shape, type ToolContext } from "../toolSpec";
import type { DrawingPoint, Fill, ScreenPoint, Stroke } from "../types";

type Source = "close" | "high" | "low" | "hl2";

export interface RegressionStyle {
  v: 1;
  source: Source;
  deviation: number;
  line: Stroke;
  fill: Fill;
  extendRight: boolean;
  correlation: boolean;
}

const SOURCES: readonly Source[] = ["close", "high", "low", "hl2"];
const DEVIATIONS: readonly number[] = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];

export const regressionDefaults = (): RegressionStyle => ({
  v: 1,
  source: "close",
  deviation: 2,
  line: defaultStroke(),
  fill: defaultFill(),
  extendRight: false,
  correlation: false,
});

export function parseRegressionStyle(raw: unknown): RegressionStyle {
  const d = regressionDefaults();
  const o = readRecord(raw);
  return {
    ...o,
    v: 1,
    source: readOneOf(o.source, SOURCES, d.source),
    deviation: readOneOf(o.deviation, DEVIATIONS, d.deviation),
    line: readStroke(o.line, d.line),
    fill: readFill(o.fill, d.fill),
    extendRight: readBool(o.extendRight, d.extendRight),
    correlation: readBool(o.correlation, d.correlation),
  };
}

const SOURCE_OF: Record<Source, (b: Bar) => number> = {
  close: (b) => b.c,
  high: (b) => b.h,
  low: (b) => b.l,
  hl2: (b) => (b.h + b.l) / 2,
};

interface Fit {
  first: number;
  last: number;
  band: number;
  correlation: number | null;
}

export function fitRegression(values: readonly number[]): Fit {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, y) => sum + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  values.forEach((y, x) => {
    sxy += (x - meanX) * (y - meanY);
    sxx += (x - meanX) ** 2;
    syy += (y - meanY) ** 2;
  });
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const squares = values.reduce((sum, y, x) => sum + (y - intercept - slope * x) ** 2, 0);
  return {
    first: intercept,
    last: intercept + slope * (n - 1),
    band: Math.sqrt(squares / n),
    correlation: sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy),
  };
}

interface Line {
  a: ScreenPoint;
  b: ScreenPoint;
}

interface Channel {
  center: Line;
  upper: Line;
  lower: Line;
  correlation: number | null;
}

function lineAt(x0: number, x1: number, p0: number, p1: number, ctx: ToolContext): Line | null {
  const y0 = ctx.yOf(p0);
  const y1 = ctx.yOf(p1);
  return y0 === null || y1 === null ? null : { a: { x: x0, y: y0 }, b: { x: x1, y: y1 } };
}

function extendRightTo(line: Line, width: number): Line {
  const { a, b } = line;
  if (b.x >= width || b.x === a.x) return line;
  return { a, b: { x: width, y: a.y + ((b.y - a.y) * (width - a.x)) / (b.x - a.x) } };
}

function channelOf(points: readonly DrawingPoint[], style: RegressionStyle, ctx: ToolContext): Channel | null {
  const [p0, p1] = points;
  if (p0 === undefined || p1 === undefined) return null;
  const bars = ctx.barsIn(p0.t, p1.t);
  const firstBar = bars[0];
  const lastBar = bars[bars.length - 1];
  if (bars.length < 2 || firstBar === undefined || lastBar === undefined) return null;
  const x0 = ctx.xOf(firstBar.t);
  const x1 = ctx.xOf(lastBar.t);
  if (x0 === null || x1 === null) return null;
  const fit = fitRegression(bars.map(SOURCE_OF[style.source]));
  const offset = fit.band * style.deviation;
  const center = lineAt(x0, x1, fit.first, fit.last, ctx);
  const upper = lineAt(x0, x1, fit.first + offset, fit.last + offset, ctx);
  const lower = lineAt(x0, x1, fit.first - offset, fit.last - offset, ctx);
  if (center === null || upper === null || lower === null) return null;
  return { center, upper, lower, correlation: fit.correlation };
}

const CORRELATION_GAP = 8;

function correlationText(channel: Channel, style: RegressionStyle): Shape[] {
  if (!style.correlation || channel.correlation === null) return [];
  const { b } = channel.center;
  return [
    {
      kind: "text",
      at: { x: b.x + CORRELATION_GAP, y: b.y },
      text: `상관계수 ${channel.correlation.toFixed(2)}`,
      style: { ...defaultText(), color: style.line.color, size: 12 },
      align: "left",
      baseline: "middle",
    },
  ];
}

function screenEnds(points: readonly DrawingPoint[], ctx: ToolContext) {
  const [p0, p1] = points;
  const a = p0 === undefined ? null : ctx.toScreen(p0);
  const b = p1 === undefined ? null : ctx.toScreen(p1);
  return a === null || b === null ? null : { a, b };
}

const L = at<RegressionStyle>();
const nearestDeviation: Lens<RegressionStyle, number> = {
  get: (s) => s.deviation,
  set: (s, v) => ({ ...s, deviation: Math.min(4, Math.max(0.5, Math.round(v * 2) / 2)) }),
};
const retime = (i: number) => (pts: readonly DrawingPoint[], to: DrawingPoint) => pts.map((q, j) => (j === i ? { ...q, t: to.t } : q));

export const regression = defineTool<RegressionStyle>({
  tool: "regression",
  group: "line",
  label: "회귀 채널",
  icon: "M3 17 L21 9 M3 21 L21 13 M3 13 L21 5",
  placement: { kind: "points", count: 2 },
  pointRoles: [
    { label: "시작", uses: "time" },
    { label: "끝", uses: "time" },
  ],
  defaultStyle: regressionDefaults,
  parseStyle: parseRegressionStyle,
  bar: { lineColor: L("line", "color"), width: L("line", "width"), dash: L("line", "dash"), fill: L("fill") },
  settings: {
    inputs: [
      select(
        "기준 값",
        [
          { value: "close", label: "종가" },
          { value: "high", label: "고가" },
          { value: "low", label: "저가" },
          { value: "hl2", label: "고가·저가 가운데" },
        ],
        L("source"),
      ),
      { kind: "number", label: "편차 배수", min: 0.5, max: 4, step: 0.5, lens: nearestDeviation },
    ],
    style: [
      ...strokeFields("선", L("line")),
      { kind: "fill", label: "채움", lens: L("fill") },
      { kind: "toggle", label: "오른쪽 연장", lens: L("extendRight") },
      { kind: "toggle", label: "상관계수", lens: L("correlation") },
    ],
  },
  shapes({ points, style }, ctx) {
    const channel = channelOf(points, style, ctx);
    if (channel === null) {
      const ends = screenEnds(points, ctx);
      return ends === null ? [] : [{ kind: "segment", ...ends, stroke: { ...style.line, dash: "dashed" } }];
    }
    const extend = (line: Line) => (style.extendRight ? extendRightTo(line, ctx.paneWidth) : line);
    const [upper, center, lower] = [extend(channel.upper), extend(channel.center), extend(channel.lower)];
    const shapes: Shape[] = [];
    if (style.fill.on) shapes.push({ kind: "polyline", points: [upper.a, upper.b, lower.b, lower.a], closed: true, fill: style.fill });
    for (const line of [upper, center, lower]) shapes.push({ kind: "segment", ...line, stroke: style.line });
    return [...shapes, ...correlationText(channel, style)];
  },
  handles({ points, style }, ctx) {
    const [p0, p1] = points;
    if (p0 === undefined || p1 === undefined) return [];
    const channel = channelOf(points, style, ctx);
    if (channel === null) {
      const ends = screenEnds(points, ctx);
      return ends === null ? [] : [{ at: ends.a, move: retime(0) }, { at: ends.b, move: retime(1) }];
    }
    const { a, b } = channel.center;
    return p0.t <= p1.t ? [{ at: a, move: retime(0) }, { at: b, move: retime(1) }] : [{ at: b, move: retime(0) }, { at: a, move: retime(1) }];
  },
  axisLabels({ points, style, selected }, ctx) {
    if (!selected) return [];
    return points.map((p): AxisLabel => ({ axis: "time", value: p.t, text: ctx.formatTime(p.t), color: style.line.color }));
  },
});

