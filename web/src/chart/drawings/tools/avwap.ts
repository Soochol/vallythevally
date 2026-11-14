import type { Bar } from "../../../api/generated/Bar";
import type { UnixSeconds } from "../../../api/generated/UnixSeconds";
import { at, defaultStroke, readBool, readNumber, readRecord, readStroke, strokeFields } from "../styleKit";
import { type AxisLabel, defineTool, type Shape, type ToolContext } from "../toolSpec";
import type { ScreenPoint, Stroke } from "../types";

export interface AvwapStyle {
  v: 1;
  line: Stroke;
  bands: boolean;
  multiplier: number;
  priceLabel: boolean;
}

export const MULTIPLIER = { min: 0.5, max: 3, step: 0.5 } as const;

export const avwapDefaults = (): AvwapStyle => ({ v: 1, line: defaultStroke(), bands: false, multiplier: 1, priceLabel: true });

const stepped = (x: number, { min, max, step }: { min: number; max: number; step: number }) => Math.min(max, Math.max(min, Math.round(x / step) * step));

export function parseAvwapStyle(raw: unknown): AvwapStyle {
  const d = avwapDefaults();
  const o = readRecord(raw);
  return {
    ...o,
    v: 1,
    line: readStroke(o.line, d.line),
    bands: readBool(o.bands, d.bands),
    multiplier: stepped(readNumber(o.multiplier, d.multiplier), MULTIPLIER),
    priceLabel: readBool(o.priceLabel, d.priceLabel),
  };
}

export interface VwapValue {
  t: UnixSeconds;
  price: number;
  deviation: number;
}

export function anchoredVwap(bars: readonly Bar[]): VwapValue[] {
  const values: VwapValue[] = [];
  let volume = 0;
  let mean = 0;
  let spread = 0;
  for (const bar of bars) {
    if (bar.v > 0) {
      const typical = (bar.h + bar.l + bar.c) / 3;
      const before = mean;
      volume += bar.v;
      mean += (bar.v / volume) * (typical - before);
      spread += bar.v * (typical - before) * (typical - mean);
    }
    if (volume > 0) values.push({ t: bar.t, price: mean, deviation: Math.sqrt(Math.max(0, spread) / volume) });
  }
  return values;
}

const vertices = (values: readonly VwapValue[], offset: (v: VwapValue) => number, ctx: ToolContext): ScreenPoint[] =>
  values.flatMap((v) => {
    const x = ctx.xOf(v.t);
    const y = ctx.yOf(v.price + offset(v));
    return x === null || y === null ? [] : [{ x, y }];
  });

const L = at<AvwapStyle>();

export const avwap = defineTool<AvwapStyle>({
  tool: "avwap",
  group: "measure",
  label: "기준봉 VWAP",
  icon: "M5 4 V20 M5 15 C9 9 12 14 15 10 S19 8 21 7",
  placement: { kind: "points", count: 1 },
  pointRoles: [{ label: "기준봉", uses: "time" }],
  defaultStyle: avwapDefaults,
  parseStyle: parseAvwapStyle,
  bar: { lineColor: L("line", "color"), width: L("line", "width"), dash: L("line", "dash") },
  settings: {
    style: [
      ...strokeFields("선", L("line")),
      { kind: "toggle", label: "편차 띠", lens: L("bands") },
      { kind: "number", label: "편차 배수", ...MULTIPLIER, lens: L("multiplier") },
      { kind: "toggle", label: "가격 라벨", lens: L("priceLabel") },
    ],
  },
  shapes({ points, style }, ctx) {
    const p = points[0];
    if (p === undefined) return [];
    const bars = ctx.barsIn(p.t);
    const values = anchoredVwap(bars);
    const line = vertices(values, () => 0, ctx);
    const shapes: Shape[] = [];
    if (line.length > 0) shapes.push({ kind: "polyline", points: line, closed: false, stroke: style.line });
    if (style.bands && values.length > 0) {
      const band: Stroke = { color: style.line.color, width: 1, dash: "dashed" };
      for (const side of [1, -1]) shapes.push({ kind: "polyline", points: vertices(values, (v) => side * style.multiplier * v.deviation, ctx), closed: false, stroke: band });
    }
    if (line.length < 2) {
      const x = ctx.xOf(bars[0]?.t ?? p.t);
      if (x !== null) shapes.push({ kind: "vline", x, stroke: { ...style.line, dash: "dashed" }, allPanes: false });
    }
    return shapes;
  },
  handles({ points }, ctx) {
    const p = points[0];
    if (p === undefined) return [];
    const bars = ctx.barsIn(p.t);
    const x = ctx.xOf(bars[0]?.t ?? p.t);
    const first = anchoredVwap(bars)[0];
    const y = first === undefined ? null : ctx.yOf(first.price);
    return x === null ? [] : [{ at: { x, y: y ?? ctx.paneHeight / 2 }, move: (pts, to) => pts.map((q) => ({ ...q, t: to.t })) }];
  },
  axisLabels({ points, style, selected }, ctx) {
    const p = points[0];
    if (p === undefined) return [];
    const labels: AxisLabel[] = [];
    const last = style.priceLabel ? anchoredVwap(ctx.barsIn(p.t)).at(-1) : undefined;
    if (last !== undefined) labels.push({ axis: "price", value: last.price, text: ctx.formatPrice(last.price), color: style.line.color });
    if (selected) labels.push({ axis: "time", value: p.t, text: ctx.formatTime(p.t), color: style.line.color });
    return labels;
  },
});
