import {
  at,
  defaultFill,
  defaultStroke,
  defaultText,
  EXTEND_OPTIONS,
  EXTENDS,
  readFill,
  readOneOf,
  readRecord,
  readStroke,
  readTextStyle,
  select,
  strokeFields,
} from "../styleKit";
import { type AxisLabel, defineTool, type HandleSpec, type Shape, type ToolContext } from "../toolSpec";
import type { DrawingPoint, Extend, Fill, ScreenPoint, Stroke, TextStyle } from "../types";

type VAlign = "top" | "middle" | "bottom";

export interface RectStyle {
  v: 1;
  border: Stroke;
  fill: Fill;
  extend: Extend;
  label: TextStyle & { vAlign: VAlign };
}

const VALIGNS: readonly VAlign[] = ["top", "middle", "bottom"];

export const rectDefaults = (): RectStyle => ({
  v: 1,
  border: defaultStroke(),
  fill: defaultFill(),
  extend: "none",
  label: { ...defaultText(), vAlign: "middle" },
});

export function parseRectStyle(raw: unknown): RectStyle {
  const d = rectDefaults();
  const o = readRecord(raw);
  const label = readRecord(o.label);
  return {
    ...o,
    v: 1,
    border: readStroke(o.border, d.border),
    fill: readFill(o.fill, d.fill),
    extend: readOneOf(o.extend, EXTENDS, d.extend),
    label: { ...readTextStyle(o.label, d.label), vAlign: readOneOf(label.vAlign, VALIGNS, d.label.vAlign) },
  };
}

export interface Corners {
  p0: DrawingPoint;
  p1: DrawingPoint;
  a: ScreenPoint;
  b: ScreenPoint;
}

export function cornersOf(points: readonly DrawingPoint[], ctx: ToolContext): Corners | null {
  const [p0, p1] = points;
  if (p0 === undefined || p1 === undefined) return null;
  const a = ctx.toScreen(p0);
  const b = ctx.toScreen(p1);
  return a === null || b === null ? null : { p0, p1, a, b };
}

export function cornerLabels(points: readonly DrawingPoint[], selected: boolean, color: string, ctx: ToolContext): AxisLabel[] {
  if (!selected) return [];
  return points.flatMap((p) => [
    { axis: "price" as const, value: p.price, text: ctx.formatPrice(p.price), color },
    { axis: "time" as const, value: p.t, text: ctx.formatTime(p.t), color },
  ]);
}

type PointEdit = (q: DrawingPoint, to: DrawingPoint) => DrawingPoint;
const keep: PointEdit = (q) => q;
const whole: PointEdit = (_q, to) => to;
const timeOnly: PointEdit = (q, to) => ({ ...q, t: to.t });
const priceOnly: PointEdit = (q, to) => ({ ...q, price: to.price });

const editPoints = (first: PointEdit, second: PointEdit): HandleSpec["move"] => (points, to) =>
  points.map((q, i) => (i === 0 ? first : i === 1 ? second : keep)(q, to));

export function cornerHandles(points: readonly DrawingPoint[], ctx: ToolContext): HandleSpec[] {
  const corners = cornersOf(points, ctx);
  if (corners === null) return [];
  const { a, b } = corners;
  const timeOf0Price1 = { x: a.x, y: b.y };
  const timeOf1Price0 = { x: b.x, y: a.y };
  return [
    { at: a, move: editPoints(whole, keep), constrain: { rule: "square", pivot: b } },
    { at: b, move: editPoints(keep, whole), constrain: { rule: "square", pivot: a } },
    { at: timeOf1Price0, move: editPoints(priceOnly, timeOnly), constrain: { rule: "square", pivot: timeOf0Price1 } },
    { at: timeOf0Price1, move: editPoints(timeOnly, priceOnly), constrain: { rule: "square", pivot: timeOf1Price0 } },
  ];
}

const TEXT_PAD = 4;

function innerText(a: ScreenPoint, b: ScreenPoint, text: string, label: RectStyle["label"]): Shape {
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  const y = label.vAlign === "top" ? top + TEXT_PAD : label.vAlign === "bottom" ? bottom - TEXT_PAD : (top + bottom) / 2;
  const baseline = label.vAlign === "top" ? "top" : label.vAlign === "bottom" ? "bottom" : "middle";
  return {
    kind: "text",
    at: { x: (a.x + b.x) / 2, y },
    text,
    style: label,
    align: "center",
    baseline,
    box: { padding: 0, wrapWidth: Math.max(1, Math.abs(b.x - a.x) - TEXT_PAD * 2) },
  };
}

const L = at<RectStyle>();

export const rect = defineTool<RectStyle>({
  tool: "rect",
  group: "shape",
  label: "사각형",
  icon: "M4 6 H20 V18 H4 Z",
  placement: { kind: "points", count: 2, shift: "square" },
  pointRoles: [
    { label: "시작", uses: "both" },
    { label: "끝", uses: "both" },
  ],
  text: { editOnPlace: false },
  defaultStyle: rectDefaults,
  parseStyle: parseRectStyle,
  bar: { lineColor: L("border", "color"), fill: L("fill"), width: L("border", "width"), dash: L("border", "dash") },
  settings: {
    style: [...strokeFields("테두리", L("border")), { kind: "fill", label: "채움", lens: L("fill") }, select("연장", EXTEND_OPTIONS, L("extend"))],
    text: [
      { kind: "text", label: "글자", multiline: true },
      {
        kind: "textStyle",
        label: "글자 모양",
        lens: { get: (s) => s.label, set: (s, v) => ({ ...s, label: { ...s.label, ...v } }) },
      },
      select(
        "세로 정렬",
        [
          { value: "top", label: "위" },
          { value: "middle", label: "가운데" },
          { value: "bottom", label: "아래" },
        ],
        L("label", "vAlign"),
      ),
    ],
  },
  shapes({ points, style, text }, ctx) {
    const corners = cornersOf(points, ctx);
    if (corners === null) return [];
    const { a, b } = corners;
    const shapes: Shape[] = [{ kind: "rect", a, b, stroke: style.border, fill: style.fill, extend: style.extend }];
    if (text !== null && text !== "") shapes.push(innerText(a, b, text, style.label));
    return shapes;
  },
  handles({ points }, ctx) {
    return cornerHandles(points, ctx);
  },
  axisLabels({ points, style, selected }, ctx) {
    return cornerLabels(points, selected, style.border.color, ctx);
  },
});
