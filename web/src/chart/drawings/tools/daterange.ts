import { formatVolume } from "../../../lib/format";
import { at, defaultFill, defaultText, readFill, readRecord, readTextStyle } from "../styleKit";
import { defineTool, type ToolContext } from "../toolSpec";
import type { DrawingPoint, Fill, TextStyle } from "../types";
import { cornerHandles, MEASURE_GAP, measureLabel, screenPair, thinStroke } from "./pricerange";
import { formatDuration } from "./trendline";

export interface DateRangeStyle {
  v: 1;
  band: Fill;
  label: TextStyle;
}

export const dateRangeDefaults = (): DateRangeStyle => ({ v: 1, band: defaultFill(), label: defaultText() });

export function parseDateRangeStyle(raw: unknown): DateRangeStyle {
  const d = dateRangeDefaults();
  const o = readRecord(raw);
  return { ...o, v: 1, band: readFill(o.band, d.band), label: readTextStyle(o.label, d.label) };
}

export function dateRangeText(p0: DrawingPoint, p1: DrawingPoint, ctx: ToolContext): string {
  const duration = formatDuration(p1.t - p0.t);
  const bars = ctx.barsBetween(p0.t, p1.t);
  return bars === null ? duration : `${bars.count}봉, ${duration}\n거래량 ${formatVolume(bars.volume)}`;
}

const L = at<DateRangeStyle>();

export const daterange = defineTool<DateRangeStyle>({
  tool: "daterange",
  group: "measure",
  label: "날짜 범위",
  icon: "M4 5 V19 M20 5 V19 M6 12 H18 M9 9 L6 12 L9 15 M15 9 L18 12 L15 15",
  placement: { kind: "points", count: 2 },
  pointRoles: [
    { label: "시작", uses: "both" },
    { label: "끝", uses: "both" },
  ],
  defaultStyle: dateRangeDefaults,
  parseStyle: parseDateRangeStyle,
  bar: { fill: L("band"), textColor: L("label", "color") },
  settings: {
    style: [{ kind: "fill", label: "띠", lens: L("band") }],
    text: [{ kind: "textStyle", label: "글자 모양", lens: L("label") }],
  },
  shapes({ points, style }, ctx) {
    const pair = screenPair(points, ctx);
    if (pair === null) return [];
    const { p0, p1, a, b } = pair;
    const y = (a.y + b.y) / 2;
    return [
      { kind: "rect", a, b, fill: style.band },
      { kind: "segment", a: { x: a.x, y }, b: { x: b.x, y }, stroke: thinStroke(style.band.color), ends: { left: "plain", right: "arrow" } },
      measureLabel({ x: (a.x + b.x) / 2, y: Math.max(a.y, b.y) + MEASURE_GAP }, dateRangeText(p0, p1, ctx), style.label, style.band.color, "top"),
    ];
  },
  handles: ({ points }, ctx) => cornerHandles(points, ctx),
  axisLabels({ points, style, selected }, ctx) {
    if (!selected) return [];
    return points.map((p) => ({ axis: "time", value: p.t, text: ctx.formatTime(p.t), color: style.band.color }));
  },
});
