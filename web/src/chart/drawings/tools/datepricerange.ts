import { at } from "../styleKit";
import { type AxisLabel, defineTool, type ToolContext } from "../toolSpec";
import type { DrawingPoint } from "../types";
import { dateRangeText } from "./daterange";
import { bandFill, cornerHandles, MEASURE_GAP, measureLabel, parsePriceRangeStyle, priceRangeDefaults, priceRangeText, type PriceRangeStyle, screenPair, thinStroke } from "./pricerange";

export const datePriceRangeText = (p0: DrawingPoint, p1: DrawingPoint, ctx: ToolContext): string => `${priceRangeText(p0, p1, ctx)}\n${dateRangeText(p0, p1, ctx)}`;

const bandOf = (style: PriceRangeStyle, p0: DrawingPoint, p1: DrawingPoint) => (p1.price >= p0.price ? style.up : style.down);

const L = at<PriceRangeStyle>();

export const datepricerange = defineTool<PriceRangeStyle>({
  tool: "datepricerange",
  group: "measure",
  label: "날짜·가격 범위",
  icon: "M5 5 H19 V19 H5 Z M12 8 V16 M8 12 H16 M10 10 L12 8 L14 10 M14 10 L16 12 L14 14",
  placement: { kind: "points", count: 2 },
  pointRoles: [
    { label: "시작", uses: "both" },
    { label: "끝", uses: "both" },
  ],
  defaultStyle: priceRangeDefaults,
  parseStyle: parsePriceRangeStyle,
  bar: { fill: bandFill, textColor: L("label", "color") },
  settings: {
    style: [
      { kind: "fill", label: "오름 띠", lens: L("up") },
      { kind: "fill", label: "내림 띠", lens: L("down") },
    ],
    text: [{ kind: "textStyle", label: "글자 모양", lens: L("label") }],
  },
  shapes({ points, style }, ctx) {
    const pair = screenPair(points, ctx);
    if (pair === null) return [];
    const { p0, p1, a, b } = pair;
    const fill = bandOf(style, p0, p1);
    const line = thinStroke(fill.color);
    const x = (a.x + b.x) / 2;
    const y = (a.y + b.y) / 2;
    const above = b.y <= a.y;
    return [
      { kind: "rect", a, b, fill },
      { kind: "segment", a: { x, y: a.y }, b: { x, y: b.y }, stroke: line, ends: { left: "plain", right: "arrow" } },
      { kind: "segment", a: { x: a.x, y }, b: { x: b.x, y }, stroke: line, ends: { left: "plain", right: "arrow" } },
      measureLabel({ x, y: b.y + (above ? -MEASURE_GAP : MEASURE_GAP) }, datePriceRangeText(p0, p1, ctx), style.label, fill.color, above ? "bottom" : "top"),
    ];
  },
  handles: ({ points }, ctx) => cornerHandles(points, ctx),
  axisLabels({ points, style, selected }, ctx) {
    const [p0, p1] = points;
    if (!selected || p0 === undefined || p1 === undefined) return [];
    const { color } = bandOf(style, p0, p1);
    return points.flatMap((p): AxisLabel[] => [
      { axis: "price", value: p.price, text: ctx.formatPrice(p.price), color },
      { axis: "time", value: p.t, text: ctx.formatTime(p.t), color },
    ]);
  },
});
