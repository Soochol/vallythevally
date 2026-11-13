import { at, DOWN, DRAW, defaultText, readFill, readRecord, readTextStyle, UP } from "../styleKit";
import { type AxisLabel, defineTool, type Shape, type Tool, type ToolContext } from "../toolSpec";
import type { DrawingPoint, Fill, TextStyle } from "../types";
import { MEASURE_GAP, measureLabel, signedPercent, thinStroke } from "./pricerange";

export type PositionSide = "long" | "short";

export interface PositionStyle {
  v: 1;
  profit: Fill;
  stop: Fill;
  label: TextStyle;
}

export const positionDefaults = (): PositionStyle => ({
  v: 1,
  profit: { on: true, color: UP, opacity: 0.2 },
  stop: { on: true, color: DOWN, opacity: 0.2 },
  label: defaultText(),
});

export function parsePositionStyle(raw: unknown): PositionStyle {
  const d = positionDefaults();
  const o = readRecord(raw);
  return { ...o, v: 1, profit: readFill(o.profit, d.profit), stop: readFill(o.stop, d.stop), label: readTextStyle(o.label, d.label) };
}

export const TARGET_RATIO = 0.1;
export const STOP_RATIO = 0.05;
export const WIDTH_BARS = 20;

const DIRECTION: Record<PositionSide, 1 | -1> = { long: 1, short: -1 };

const atLeast = (direction: number, price: number, bound: number) => direction * Math.max(direction * price, direction * bound);

export function placePosition(side: PositionSide, entry: DrawingPoint, ctx: ToolContext): DrawingPoint[] {
  const direction = DIRECTION[side];
  const right = ctx.shiftBars(entry.t, WIDTH_BARS) ?? entry.t;
  const scale = Math.abs(entry.price);
  return [entry, { t: right, price: entry.price + direction * scale * TARGET_RATIO }, { t: entry.t, price: entry.price - direction * scale * STOP_RATIO }];
}

export function riskReward(entry: number, target: number, stop: number): number | null {
  const risk = Math.abs(entry - stop);
  return risk === 0 ? null : Math.abs(target - entry) / risk;
}

type Trio = readonly [DrawingPoint, DrawingPoint, DrawingPoint];
const trio = (points: readonly DrawingPoint[]): Trio | null => {
  const [entry, target, stop] = points;
  return entry === undefined || target === undefined || stop === undefined ? null : [entry, target, stop];
};

function positionMoves(side: PositionSide) {
  const direction = DIRECTION[side];
  const edit = (change: (points: Trio, to: DrawingPoint, ctx: ToolContext) => Trio) => (points: readonly DrawingPoint[], to: DrawingPoint, ctx: ToolContext) => {
    const all = trio(points);
    return all === null ? [...points] : [...change(all, to, ctx)];
  };
  return {
    target: edit(([entry, target, stop], to) => [entry, { ...target, price: atLeast(direction, to.price, entry.price) }, stop]),
    stop: edit(([entry, target, stop], to) => [entry, target, { ...stop, price: atLeast(-direction, to.price, entry.price) }]),
    right: edit(([entry, target, stop], to, ctx) => {
      const earliest = Math.min(ctx.shiftBars(entry.t, 1) ?? entry.t, Math.max(target.t, entry.t));
      return [entry, { ...target, t: Math.max(to.t, earliest) }, stop];
    }),
    entry: edit(([entry, target, stop], to, ctx) => {
      const latest = Math.max(ctx.shiftBars(target.t, -1) ?? target.t, Math.min(entry.t, target.t));
      const price = Math.min(Math.max(to.price, Math.min(target.price, stop.price)), Math.max(target.price, stop.price));
      return [{ t: Math.min(to.t, latest), price }, target, stop];
    }),
  };
}

const awayFrom = (y: number, entryY: number) => (y <= entryY ? { dy: -MEASURE_GAP, baseline: "bottom" as const } : { dy: MEASURE_GAP, baseline: "top" as const });

function levelText(name: string, entry: number, price: number, ctx: ToolContext): string {
  const percent = signedPercent(entry, price);
  return percent === null ? `${name} ${ctx.formatPrice(price)}` : `${name} ${ctx.formatPrice(price)} (${percent})`;
}

function positionTool(side: PositionSide): Tool {
  const L = at<PositionStyle>();
  const moves = positionMoves(side);
  return defineTool<PositionStyle>({
    tool: side,
    group: "measure",
    label: side === "long" ? "매수 포지션" : "매도 포지션",
    icon: side === "long" ? "M4 5 H20 V19 H4 Z M4 12 H20 M9 9 L12 6 L15 9" : "M4 5 H20 V19 H4 Z M4 12 H20 M9 15 L12 18 L15 15",
    placement: { kind: "points", count: 3, oneClick: (entry, ctx) => placePosition(side, entry, ctx) },
    pointRoles: [
      { label: "진입", uses: "both" },
      { label: "목표", uses: "both" },
      { label: "손절", uses: "price" },
    ],
    defaultStyle: positionDefaults,
    parseStyle: parsePositionStyle,
    bar: { textColor: L("label", "color") },
    settings: {
      style: [
        { kind: "fill", label: "목표 띠", lens: L("profit") },
        { kind: "fill", label: "손절 띠", lens: L("stop") },
      ],
      text: [{ kind: "textStyle", label: "글자 모양", lens: L("label") }],
    },
    shapes({ points, style }, ctx) {
      const [entry, target, stop] = points;
      const a = entry === undefined ? null : ctx.toScreen(entry);
      const right = target === undefined ? null : ctx.xOf(target.t);
      if (entry === undefined || a === null || right === null) return [];
      const shown = { left: Math.max(Math.min(a.x, right), 0), right: Math.min(Math.max(a.x, right), ctx.paneWidth) };
      const towardLeft = shown.left + shown.right > ctx.paneWidth;
      const x = towardLeft ? shown.right - MEASURE_GAP : shown.left + MEASURE_GAP;
      const align = towardLeft ? "right" : "left";
      const labelled = shown.left < shown.right;
      const shapes: Shape[] = [];
      const level = (point: DrawingPoint | undefined, name: string, fill: Fill) => {
        const y = point === undefined ? null : ctx.yOf(point.price);
        if (point === undefined || y === null) return;
        const { dy, baseline } = awayFrom(y, a.y);
        shapes.push({ kind: "rect", a, b: { x: right, y }, fill });
        if (labelled) shapes.push(measureLabel({ x, y: y + dy }, levelText(name, entry.price, point.price, ctx), style.label, fill.color, baseline, align));
      };
      level(target, "목표", style.profit);
      level(stop, "손절", style.stop);
      shapes.push({ kind: "segment", a, b: { x: right, y: a.y }, stroke: thinStroke(DRAW) });
      const ratio = target === undefined || stop === undefined ? null : riskReward(entry.price, target.price, stop.price);
      if (labelled && ratio !== null) shapes.push(measureLabel({ x, y: a.y }, `손익비 ${ratio.toFixed(2)}`, style.label, DRAW, "middle", align));
      return shapes;
    },
    handles({ points }, ctx) {
      const all = trio(points);
      if (all === null) return [];
      const [entry, target, stop] = all;
      const a = ctx.toScreen(entry);
      const right = ctx.xOf(target.t);
      const yTarget = ctx.yOf(target.price);
      const yStop = ctx.yOf(stop.price);
      if (a === null || right === null || yTarget === null || yStop === null) return [];
      return [
        { at: { x: a.x, y: yTarget }, move: moves.target },
        { at: { x: a.x, y: yStop }, move: moves.stop },
        { at: { x: right, y: a.y }, move: moves.right },
        { at: a, move: moves.entry },
      ];
    },
    axisLabels({ points, style, selected }, ctx) {
      const all = trio(points);
      if (!selected || all === null) return [];
      const [entry, target, stop] = all;
      const label = (price: number, color: string): AxisLabel => ({ axis: "price", value: price, text: ctx.formatPrice(price), color });
      return [label(entry.price, DRAW), label(target.price, style.profit.color), label(stop.price, style.stop.color)];
    },
  });
}

export const long = positionTool("long");
export const short = positionTool("short");
