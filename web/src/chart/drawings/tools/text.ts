import { at, defaultFill, defaultStroke, defaultText, readBool, readFill, readNumber, readRecord, readStroke, readTextStyle, strokeFields } from "../styleKit";
import { defineTool, type Lens } from "../toolSpec";
import type { DrawingPoint, Fill, Stroke, TextStyle } from "../types";

export const TEXT_PLACEHOLDER = "글자";
export const NOTE_PADDING = 6;

export const shownText = (text: string | null): string => (text === null || text === "" ? TEXT_PLACEHOLDER : text);

export interface TextNoteStyle {
  v: 1;
  label: TextStyle;
  background: Fill;
  border: Stroke & { on: boolean };
  wrap: { on: boolean; width: number };
}

const WRAP_MIN = 40;
const WRAP_MAX = 1000;

export const textDefaults = (): TextNoteStyle => ({
  v: 1,
  label: defaultText(),
  background: { ...defaultFill(), on: false },
  border: { ...defaultStroke(), width: 1, on: false },
  wrap: { on: false, width: 240 },
});

export function parseTextStyle(raw: unknown): TextNoteStyle {
  const d = textDefaults();
  const o = readRecord(raw);
  const border = readRecord(o.border);
  const wrap = readRecord(o.wrap);
  return {
    ...o,
    v: 1,
    label: readTextStyle(o.label, d.label),
    background: readFill(o.background, d.background),
    border: { ...readStroke(o.border, d.border), on: readBool(border.on, d.border.on) },
    wrap: { ...wrap, on: readBool(wrap.on, d.wrap.on), width: Math.min(WRAP_MAX, Math.max(WRAP_MIN, readNumber(wrap.width, d.wrap.width))) },
  };
}

const L = at<TextNoteStyle>();
const borderStroke: Lens<TextNoteStyle, Stroke> = {
  get: (s) => s.border,
  set: (s, v) => ({ ...s, border: { ...s.border, ...v } }),
};

export const text = defineTool<TextNoteStyle>({
  tool: "text",
  group: "note",
  label: "글자",
  icon: "M5 5 H19 M12 5 V19 M9 19 H15",
  placement: { kind: "points", count: 1 },
  pointRoles: [{ label: "자리", uses: "both" }],
  text: { editOnPlace: true },
  defaultStyle: textDefaults,
  parseStyle: parseTextStyle,
  bar: { textColor: L("label", "color"), fill: L("background") },
  settings: {
    style: [
      { kind: "fill", label: "배경", lens: L("background") },
      { kind: "toggle", label: "테두리", lens: L("border", "on") },
      ...strokeFields("테두리", borderStroke),
      { kind: "toggle", label: "줄바꿈", lens: L("wrap", "on") },
      { kind: "number", label: "줄바꿈 폭", min: WRAP_MIN, max: WRAP_MAX, step: 10, unit: "px", lens: L("wrap", "width") },
    ],
    text: [
      { kind: "text", label: "글자", multiline: true },
      { kind: "textStyle", label: "글자 모양", lens: L("label") },
    ],
  },
  shapes({ points, style, text }, ctx) {
    const p = points[0];
    const a = p === undefined ? null : ctx.toScreen(p);
    if (a === null) return [];
    const { on, ...border } = style.border;
    return [
      {
        kind: "text",
        at: a,
        text: shownText(text),
        style: style.label,
        align: "left",
        baseline: "top",
        box: { background: style.background, border: on ? border : undefined, padding: NOTE_PADDING, wrapWidth: style.wrap.on ? style.wrap.width : null },
      },
    ];
  },
  handles({ points }, ctx) {
    const p = points[0];
    const a = p === undefined ? null : ctx.toScreen(p);
    if (a === null) return [];
    return [{ at: a, move: (_pts: readonly DrawingPoint[], to: DrawingPoint) => [to] }];
  },
  axisLabels: () => [],
});
