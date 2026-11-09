import {
  at,
  defaultStroke,
  defaultText,
  EXTEND_OPTIONS,
  EXTENDS,
  LINE_ENDS,
  readBool,
  readOneOf,
  readRecord,
  readStroke,
  readTextStyle,
  select,
  strokeFields,
} from "../styleKit";
import { type AxisLabel, defineTool, type Shape, type ToolContext } from "../toolSpec";
import type { DrawingPoint, Extend, LineEnd, ScreenPoint, Stroke, TextStyle } from "../types";

export interface TrendStats {
  priceDiff: boolean;
  percent: boolean;
  bars: boolean;
  duration: boolean;
  angle: boolean;
  always: boolean;
}

export interface TrendStyle {
  v: 1;
  line: Stroke;
  extend: Extend;
  ends: { left: LineEnd; right: LineEnd };
  middlePoint: boolean;
  priceLabels: boolean;
  stats: TrendStats;
  label: TextStyle;
}

export const trendDefaults = (): TrendStyle => ({
  v: 1,
  line: defaultStroke(),
  extend: "none",
  ends: { left: "plain", right: "plain" },
  middlePoint: false,
  priceLabels: false,
  stats: { priceDiff: false, percent: false, bars: false, duration: false, angle: false, always: false },
  label: defaultText(),
});

export function parseTrendStyle(raw: unknown): TrendStyle {
  const d = trendDefaults();
  const o = readRecord(raw);
  const ends = readRecord(o.ends);
  const stats = readRecord(o.stats);
  return {
    ...o,
    v: 1,
    line: readStroke(o.line, d.line),
    extend: readOneOf(o.extend, EXTENDS, d.extend),
    ends: { ...ends, left: readOneOf(ends.left, LINE_ENDS, d.ends.left), right: readOneOf(ends.right, LINE_ENDS, d.ends.right) },
    middlePoint: readBool(o.middlePoint, d.middlePoint),
    priceLabels: readBool(o.priceLabels, d.priceLabels),
    stats: {
      ...stats,
      priceDiff: readBool(stats.priceDiff, d.stats.priceDiff),
      percent: readBool(stats.percent, d.stats.percent),
      bars: readBool(stats.bars, d.stats.bars),
      duration: readBool(stats.duration, d.stats.duration),
      angle: readBool(stats.angle, d.stats.angle),
      always: readBool(stats.always, d.stats.always),
    },
    label: readTextStyle(o.label, d.label),
  };
}

export function formatDuration(seconds: number): string {
  const s = Math.abs(seconds);
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const parts = [days > 0 ? `${days}일` : "", hours > 0 ? `${hours}시간` : "", minutes > 0 ? `${minutes}분` : ""].filter((p) => p !== "");
  return parts.length === 0 ? "0분" : parts.join(" ");
}

const joined = (parts: readonly (string | null)[], sep: string) => parts.filter((x) => x !== null).join(sep);

function statsLines(p0: DrawingPoint, p1: DrawingPoint, a: ScreenPoint, b: ScreenPoint, stats: TrendStats, ctx: ToolContext): string[] {
  const diff = p1.price - p0.price;
  const sign = diff > 0 ? "+" : "";
  const count = stats.bars ? ctx.barsBetween(p0.t, p1.t)?.count : undefined;
  const percent = stats.percent && p0.price !== 0 ? `${sign}${((diff / p0.price) * 100).toFixed(2)}%` : null;
  const lines = [
    joined([stats.priceDiff ? `${sign}${ctx.formatPrice(diff)}` : null, percent !== null && stats.priceDiff ? `(${percent})` : percent], " "),
    joined([count === undefined ? null : `${count}봉`, stats.duration ? formatDuration(p1.t - p0.t) : null], ", "),
    stats.angle ? `${Math.round((Math.atan2(a.y - b.y, b.x - a.x) * 180) / Math.PI)}°` : "",
  ];
  return lines.filter((l) => l !== "");
}

function endpoints(points: readonly DrawingPoint[], ctx: ToolContext) {
  const [p0, p1] = points;
  if (p0 === undefined || p1 === undefined) return null;
  const a = ctx.toScreen(p0);
  const b = ctx.toScreen(p1);
  return a === null || b === null ? null : { p0, p1, a, b };
}

const L = at<TrendStyle>();

export const trendline = defineTool<TrendStyle>({
  tool: "trendline",
  group: "line",
  label: "추세선",
  icon: "M4 20 L20 4",
  placement: { kind: "points", count: 2, shift: "angle45" },
  pointRoles: [
    { label: "시작", uses: "both" },
    { label: "끝", uses: "both" },
  ],
  text: { editOnPlace: false },
  defaultStyle: trendDefaults,
  parseStyle: parseTrendStyle,
  bar: { lineColor: L("line", "color"), width: L("line", "width"), dash: L("line", "dash") },
  settings: {
    style: [
      ...strokeFields("선", L("line")),
      select("연장", EXTEND_OPTIONS, L("extend")),
      { kind: "toggle", label: "가운데 점", lens: L("middlePoint") },
      { kind: "toggle", label: "가격 라벨", lens: L("priceLabels") },
      { kind: "toggle", label: "통계 늘 보이기", lens: L("stats", "always") },
    ],
    text: [
      { kind: "text", label: "글자", multiline: true },
      { kind: "textStyle", label: "글자 모양", lens: L("label") },
    ],
  },
  shapes({ points, style, text, selected }, ctx) {
    const ends = endpoints(points, ctx);
    if (ends === null) return [];
    const { p0, p1, a, b } = ends;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const shapes: Shape[] = [{ kind: "segment", a, b, stroke: style.line, extend: style.extend, ends: style.ends }];
    if (style.middlePoint) shapes.push({ kind: "circle", c: mid, r: 3, stroke: style.line, fill: { on: true, color: style.line.color, opacity: 1 } });
    if (text !== null && text !== "") shapes.push({ kind: "text", at: mid, text, style: style.label, align: "center", baseline: "bottom" });
    const lines = selected || style.stats.always ? statsLines(p0, p1, a, b, style.stats, ctx) : [];
    if (lines.length > 0)
      shapes.push({
        kind: "text",
        at: { x: b.x + 8, y: b.y },
        text: lines.join("\n"),
        style: { ...style.label, size: 12 },
        align: "left",
        baseline: "middle",
        box: { background: { on: true, color: style.line.color, opacity: 0.15 }, padding: 4, wrapWidth: null },
      });
    return shapes;
  },
  handles({ points }, ctx) {
    const ends = endpoints(points, ctx);
    if (ends === null) return [];
    const { a, b } = ends;
    const replace = (i: number) => (pts: readonly DrawingPoint[], to: DrawingPoint) => pts.map((q, j) => (j === i ? to : q));
    return [
      { at: a, move: replace(0), constrain: { rule: "angle45", pivot: b } },
      { at: b, move: replace(1), constrain: { rule: "angle45", pivot: a } },
    ];
  },
  axisLabels({ points, style, selected }, ctx) {
    const labels: AxisLabel[] = [];
    for (const p of points) {
      if (selected || style.priceLabels) labels.push({ axis: "price", value: p.price, text: ctx.formatPrice(p.price), color: style.line.color });
      if (selected) labels.push({ axis: "time", value: p.t, text: ctx.formatTime(p.t), color: style.line.color });
    }
    return labels;
  },
});
