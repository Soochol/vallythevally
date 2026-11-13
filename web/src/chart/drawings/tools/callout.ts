import { at, defaultFill, defaultStroke, defaultText, readBool, readFill, readRecord, readStroke, readTextStyle, strokeFields } from "../styleKit";
import { defineTool, type Shape } from "../toolSpec";
import type { DrawingPoint, Fill, ScreenPoint, Stroke, TextStyle } from "../types";
import { NOTE_PADDING, shownOnPick, shownText } from "./text";

export interface CalloutStyle {
  v: 1;
  label: TextStyle;
  background: Fill;
  line: Stroke;
  border: boolean;
}

export const calloutDefaults = (): CalloutStyle => ({
  v: 1,
  label: defaultText(),
  background: defaultFill(),
  line: { ...defaultStroke(), width: 1 },
  border: true,
});

export function parseCalloutStyle(raw: unknown): CalloutStyle {
  const d = calloutDefaults();
  const o = readRecord(raw);
  return {
    ...o,
    v: 1,
    label: readTextStyle(o.label, d.label),
    background: readFill(o.background, d.background),
    line: readStroke(o.line, d.line),
    border: readBool(o.border, d.border),
  };
}

const L = at<CalloutStyle>();

function screenPoints(points: readonly DrawingPoint[], toScreen: (p: DrawingPoint) => ScreenPoint | null) {
  const [target, box] = points;
  return { target: target === undefined ? null : toScreen(target), box: box === undefined ? null : toScreen(box) };
}

export const callout = defineTool<CalloutStyle>({
  tool: "callout",
  group: "note",
  label: "말풍선",
  icon: "M4 5 H20 V15 H11 L6 20 V15 H4 Z",
  placement: { kind: "points", count: 2 },
  pointRoles: [
    { label: "가리킬 곳", uses: "both" },
    { label: "글자 상자", uses: "both" },
  ],
  text: { editOnPlace: true },
  defaultStyle: calloutDefaults,
  parseStyle: parseCalloutStyle,
  bar: { lineColor: L("line", "color"), width: L("line", "width"), dash: L("line", "dash"), fill: shownOnPick(L("background")), textColor: L("label", "color") },
  settings: {
    style: [
      ...strokeFields("선", L("line")),
      { kind: "toggle", label: "테두리", lens: L("border") },
      { kind: "fill", label: "배경", lens: L("background") },
    ],
    text: [
      { kind: "text", label: "글자", multiline: true },
      { kind: "textStyle", label: "글자 모양", lens: L("label") },
    ],
  },
  shapes({ points, style, text }, ctx) {
    const { target, box } = screenPoints(points, ctx.toScreen);
    if (box === null) return [];
    const shapes: Shape[] = [];
    if (target !== null) shapes.push({ kind: "segment", a: box, b: target, stroke: style.line });
    const towardTarget = target ?? box;
    shapes.push({
      kind: "text",
      at: box,
      text: shownText(text),
      style: style.label,
      align: towardTarget.x < box.x ? "left" : "right",
      baseline: towardTarget.y < box.y ? "top" : "bottom",
      box: { background: style.background, border: style.border ? style.line : undefined, padding: NOTE_PADDING, wrapWidth: null },
    });
    return shapes;
  },
  handles({ points }, ctx) {
    const { target, box } = screenPoints(points, ctx.toScreen);
    const replace = (i: number) => (pts: readonly DrawingPoint[], to: DrawingPoint) => pts.map((q, j) => (j === i ? to : q));
    return [
      ...(target === null ? [] : [{ at: target, move: replace(0) }]),
      ...(box === null ? [] : [{ at: box, move: replace(1) }]),
    ];
  },
  axisLabels: () => [],
});
