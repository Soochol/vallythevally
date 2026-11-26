import { formatVolume } from "../../../lib/format";
import type { Shape, ToolContext } from "../toolSpec";
import { UP, DOWN } from "../styleKit";
import { dateRangeText } from "../tools/daterange";
import { MEASURE_GAP, measureLabel, priceRangeText, thinStroke } from "../tools/pricerange";
import type { DrawingPoint, TextStyle } from "../types";
import type { ModeSpec } from ".";

const LABEL_STYLE: TextStyle = { color: "$text", size: 12, bold: false, italic: false };

export function measureShapes(start: DrawingPoint, end: DrawingPoint, ctx: ToolContext): Shape[] {
  const a = ctx.toScreen(start);
  const b = ctx.toScreen(end);
  if (a === null || b === null) return [];
  const rising = end.price >= start.price;
  const color = rising ? UP : DOWN;
  const fill = { on: true, color, opacity: 0.16 };
  const line = thinStroke(color);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const above = b.y <= a.y;
  const between = ctx.barsBetween(start.t, end.t);
  const dateLine = dateRangeText(start, end, ctx);
  const volLine = between && between.volume > 0 ? `거래량 ${formatVolume(between.volume)}` : null;
  const text = [priceRangeText(start, end, ctx), dateLine, volLine].filter((part): part is string => part !== null && part !== "").join("\n");
  return [
    { kind: "rect", a, b, fill, stroke: { color, width: 1, dash: "dashed" } },
    { kind: "segment", a: { x: mx, y: a.y }, b: { x: mx, y: b.y }, stroke: line, ends: { left: "plain", right: "arrow" } },
    { kind: "segment", a: { x: a.x, y: my }, b: { x: b.x, y: my }, stroke: line, ends: { left: "plain", right: "arrow" } },
    measureLabel({ x: mx, y: b.y + (above ? -MEASURE_GAP : MEASURE_GAP) }, text, LABEL_STYLE, color, above ? "bottom" : "top"),
  ];
}

export const measure: ModeSpec = {
  id: "measure",
  label: "빠른 측정",
  icon: "M3 15 L15 3 L21 9 L9 21 Z M11 7 L13 9 M8 10 L10 12 M5 13 L7 15",
  preview() {
    return [];
  },
  finish() {
    return { ops: [] };
  },
};
