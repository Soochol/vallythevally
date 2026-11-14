import { at, defaultFill, DRAW, readBool, readFill, readRecord, readStroke, strokeFields } from "../styleKit";
import { defineTool, type Lens, type Level, type Shape } from "../toolSpec";
import type { Color, Fill, Stroke } from "../types";
import { MAX_LEVELS, readLevels, recolor } from "./fibKit";
import { cornerHandles, cornerLabels, cornersOf } from "./rect";

export const GANNBOX_LEVELS: readonly Level[] = [
  { value: 0.25, color: "#f23645", on: true },
  { value: 0.382, color: "#ff9800", on: true },
  { value: 0.5, color: "#4caf50", on: true },
  { value: 0.618, color: "#089981", on: true },
  { value: 0.75, color: "#2962ff", on: true },
];

export interface GannBoxStyle {
  v: 1;
  border: Stroke;
  levels: readonly Level[];
  labels: boolean;
  fill: Fill;
}

export const gannBoxDefaults = (): GannBoxStyle => ({
  v: 1,
  border: { color: DRAW, width: 1, dash: "solid" },
  levels: GANNBOX_LEVELS.map((l) => ({ ...l })),
  labels: true,
  fill: { ...defaultFill(), opacity: 0.08 },
});

export function parseGannBoxStyle(raw: unknown): GannBoxStyle {
  const d = gannBoxDefaults();
  const o = readRecord(raw);
  return {
    ...o,
    v: 1,
    border: readStroke(o.border, d.border),
    levels: readLevels(o.levels, d.levels),
    labels: readBool(o.labels, d.labels),
    fill: readFill(o.fill, d.fill),
  };
}

const lineColor: Lens<GannBoxStyle, Color> = {
  get: (s) => s.border.color,
  set: (s, color) => recolor({ ...s, border: { ...s.border, color } }, color),
};

const LABEL_GAP = 4;

const L = at<GannBoxStyle>();

export const gannbox = defineTool<GannBoxStyle>({
  tool: "gannbox",
  group: "fib",
  label: "갠 상자",
  icon: "M4 4 H20 V20 H4 Z M4 8 H20 M4 12 H20 M8 4 V20 M12 4 V20",
  placement: { kind: "points", count: 2, shift: "square" },
  pointRoles: [
    { label: "시작", uses: "both" },
    { label: "끝", uses: "both" },
  ],
  defaultStyle: gannBoxDefaults,
  parseStyle: parseGannBoxStyle,
  bar: { lineColor, fill: L("fill"), width: L("border", "width"), dash: L("border", "dash") },
  settings: {
    style: [
      ...strokeFields("테두리", L("border")),
      { kind: "levels", label: "수준", max: MAX_LEVELS, lens: L("levels") },
      { kind: "toggle", label: "비율 꼬리표", lens: L("labels") },
      { kind: "fill", label: "채움", lens: L("fill") },
    ],
  },
  shapes({ points, style }, ctx) {
    const corners = cornersOf(points, ctx);
    if (corners === null) return [];
    const { a, b } = corners;
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y, b.y);
    const levels = style.levels.filter((l) => l.on);
    const stroke = (level: Level): Stroke => ({ color: level.color, width: style.border.width, dash: style.border.dash });
    const text = (level: Level) => ({ text: String(level.value), style: { color: level.color, size: 12, bold: false, italic: false } });
    const priceLines = levels.flatMap((level): Shape[] => {
      const y = a.y + (b.y - a.y) * level.value;
      const line: Shape = { kind: "segment", a: { x: left, y }, b: { x: right, y }, stroke: stroke(level) };
      return style.labels ? [line, { kind: "text", at: { x: left - LABEL_GAP, y }, align: "right", baseline: "middle", ...text(level) }] : [line];
    });
    const timeLines = levels.flatMap((level): Shape[] => {
      const x = a.x + (b.x - a.x) * level.value;
      const line: Shape = { kind: "segment", a: { x, y: top }, b: { x, y: bottom }, stroke: stroke(level) };
      return style.labels ? [line, { kind: "text", at: { x, y: top - LABEL_GAP }, align: "center", baseline: "bottom", ...text(level) }] : [line];
    });
    return [{ kind: "rect", a, b, stroke: style.border, fill: style.fill }, ...priceLines, ...timeLines];
  },
  handles: ({ points }, ctx) => cornerHandles(points, ctx),
  axisLabels: ({ points, style, selected }, ctx) => cornerLabels(points, selected, style.border.color, ctx),
});
