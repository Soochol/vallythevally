import { at, defaultStroke, defaultText, readRecord, readStroke, readTextStyle, strokeFields } from "../styleKit";
import { defineTool, type Shape } from "../toolSpec";
import type { DrawingPoint, LineEnd, Stroke, TextStyle } from "../types";

export interface ArrowStyle {
  v: 1;
  line: Stroke;
  label: TextStyle;
}

export const arrowDefaults = (): ArrowStyle => ({ v: 1, line: defaultStroke(), label: defaultText() });

export function parseArrowStyle(raw: unknown): ArrowStyle {
  const d = arrowDefaults();
  const o = readRecord(raw);
  return { ...o, v: 1, line: readStroke(o.line, d.line), label: readTextStyle(o.label, d.label) };
}

const HEAD: { left: LineEnd; right: LineEnd } = { left: "plain", right: "arrow" };

const L = at<ArrowStyle>();

export const arrow = defineTool<ArrowStyle>({
  tool: "arrow",
  group: "note",
  label: "화살표",
  icon: "M4 20 L20 4 M11 4 H20 V13",
  placement: { kind: "points", count: 2, shift: "angle45" },
  pointRoles: [
    { label: "시작", uses: "both" },
    { label: "끝", uses: "both" },
  ],
  text: { editOnPlace: false },
  defaultStyle: arrowDefaults,
  parseStyle: parseArrowStyle,
  bar: { lineColor: L("line", "color"), width: L("line", "width"), dash: L("line", "dash"), textColor: L("label", "color") },
  settings: {
    style: strokeFields("선", L("line")),
    text: [
      { kind: "text", label: "글자", multiline: true },
      { kind: "textStyle", label: "글자 모양", lens: L("label") },
    ],
  },
  shapes({ points, style, text }, ctx) {
    const [p0, p1] = points;
    const a = p0 === undefined ? null : ctx.toScreen(p0);
    const b = p1 === undefined ? null : ctx.toScreen(p1);
    if (a === null || b === null) return [];
    const shapes: Shape[] = [{ kind: "segment", a, b, stroke: style.line, ends: HEAD }];
    if (text !== null && text !== "")
      shapes.push({ kind: "text", at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, text, style: style.label, align: "center", baseline: "bottom" });
    return shapes;
  },
  handles({ points }, ctx) {
    const [p0, p1] = points;
    const a = p0 === undefined ? null : ctx.toScreen(p0);
    const b = p1 === undefined ? null : ctx.toScreen(p1);
    const replace = (i: number) => (pts: readonly DrawingPoint[], to: DrawingPoint) => pts.map((q, j) => (j === i ? to : q));
    if (a === null || b === null) return [];
    return [
      { at: a, move: replace(0), constrain: { rule: "angle45", pivot: b } },
      { at: b, move: replace(1), constrain: { rule: "angle45", pivot: a } },
    ];
  },
  axisLabels: () => [],
});
