import { formatPercent } from "../../../lib/format";
import { at, DOWN, defaultText, readFill, readRecord, readTextStyle, UP } from "../styleKit";
import { defineTool, type HandleSpec, type Lens, type Shape, type ToolContext } from "../toolSpec";
import type { DrawingPoint, Fill, ScreenPoint, Stroke, TextStyle } from "../types";

export interface PriceRangeStyle {
  v: 1;
  up: Fill;
  down: Fill;
  label: TextStyle;
}

export const priceRangeDefaults = (): PriceRangeStyle => ({
  v: 1,
  up: { on: true, color: UP, opacity: 0.2 },
  down: { on: true, color: DOWN, opacity: 0.2 },
  label: defaultText(),
});

export function parsePriceRangeStyle(raw: unknown): PriceRangeStyle {
  const d = priceRangeDefaults();
  const o = readRecord(raw);
  return { ...o, v: 1, up: readFill(o.up, d.up), down: readFill(o.down, d.down), label: readTextStyle(o.label, d.label) };
}

export const MEASURE_GAP = 6;

export const signedPercent = (from: number, to: number): string | null => (from === 0 ? null : formatPercent(((to - from) / Math.abs(from)) * 100));

export function screenPair(points: readonly DrawingPoint[], ctx: ToolContext) {
  const [p0, p1] = points;
  if (p0 === undefined || p1 === undefined) return null;
  const a = ctx.toScreen(p0);
  const b = ctx.toScreen(p1);
  return a === null || b === null ? null : { p0, p1, a, b };
}

export const measureLabel = (at: ScreenPoint, text: string, style: TextStyle, color: string, baseline: "top" | "middle" | "bottom", align: "left" | "center" | "right" = "center"): Shape => ({
  kind: "text",
  at,
  text,
  style,
  align,
  baseline,
  box: { background: { on: true, color, opacity: 0.15 }, padding: 4, wrapWidth: null },
});

export const thinStroke = (color: string): Stroke => ({ color, width: 1, dash: "solid" });

export function cornerHandles(points: readonly DrawingPoint[], ctx: ToolContext): HandleSpec[] {
  const pair = screenPair(points, ctx);
  if (pair === null) return [];
  const replace = (i: number) => (pts: readonly DrawingPoint[], to: DrawingPoint) => pts.map((q, j) => (j === i ? to : q));
  return [
    { at: pair.a, move: replace(0) },
    { at: pair.b, move: replace(1) },
  ];
}

export function priceRangeText(p0: DrawingPoint, p1: DrawingPoint, ctx: ToolContext): string {
  const diff = p1.price - p0.price;
  const percent = signedPercent(p0.price, p1.price);
  const change = `${diff > 0 ? "+" : ""}${ctx.formatPrice(diff)}`;
  return percent === null ? change : `${change} (${percent})`;
}

const L = at<PriceRangeStyle>();
const bandFill: Lens<PriceRangeStyle, Fill> = {
  get: (s) => s.up,
  set: (s, fill) => ({ ...s, up: fill, down: { ...s.down, color: fill.color } }),
};

export const pricerange = defineTool<PriceRangeStyle>({
  tool: "pricerange",
  group: "measure",
  label: "가격 범위",
  icon: "M5 4 H19 M5 20 H19 M12 6 V18 M9 9 L12 6 L15 9 M9 15 L12 18 L15 15",
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
    const fill = p1.price >= p0.price ? style.up : style.down;
    const x = (a.x + b.x) / 2;
    const above = b.y <= a.y;
    return [
      { kind: "rect", a, b, fill },
      { kind: "segment", a: { x, y: a.y }, b: { x, y: b.y }, stroke: thinStroke(fill.color), ends: { left: "plain", right: "arrow" } },
      measureLabel({ x, y: b.y + (above ? -MEASURE_GAP : MEASURE_GAP) }, priceRangeText(p0, p1, ctx), style.label, fill.color, above ? "bottom" : "top"),
    ];
  },
  handles: ({ points }, ctx) => cornerHandles(points, ctx),
  axisLabels({ points, style, selected }, ctx) {
    if (!selected) return [];
    const [p0, p1] = points;
    const color = p0 !== undefined && p1 !== undefined && p1.price < p0.price ? style.down.color : style.up.color;
    return points.map((p) => ({ axis: "price", value: p.price, text: ctx.formatPrice(p.price), color }));
  },
});
