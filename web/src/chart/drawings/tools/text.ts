import { at, defaultFill, defaultStroke, defaultText, readBool, readFill, readOneOf, readRecord, readStroke, readTextStyle, select, strokeFields } from "../styleKit";
import { defineTool, type Lens } from "../toolSpec";
import type { DrawingPoint, Fill, Stroke, TextStyle } from "../types";

export const TEXT_PLACEHOLDER = "글자";
export const NOTE_PADDING = 6;

export const shownText = (text: string | null): string => (text === null || text.trim() === "" ? TEXT_PLACEHOLDER : text);

export interface TextNoteStyle {
  v: 1;
  label: TextStyle;
  background: Fill;
  border: Stroke & { on: boolean };
  wrap: { on: boolean; width: WrapWidth };
}

const WRAP_WIDTHS = [100, 150, 200, 300, 400, 600] as const;
type WrapWidth = (typeof WRAP_WIDTHS)[number];

export const textDefaults = (): TextNoteStyle => ({
  v: 1,
  label: defaultText(),
  background: { ...defaultFill(), on: false },
  border: { ...defaultStroke(), width: 1, on: false },
  wrap: { on: false, width: 200 },
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
    wrap: { ...wrap, on: readBool(wrap.on, d.wrap.on), width: readOneOf(wrap.width, WRAP_WIDTHS, d.wrap.width) },
  };
}

const L = at<TextNoteStyle>();
const borderStroke: Lens<TextNoteStyle, Stroke> = {
  get: (s) => s.border,
  set: (s, v) => ({ ...s, border: { ...s.border, ...v } }),
};
const backgroundShownOnPick: Lens<TextNoteStyle, Fill> = {
  get: (s) => s.background,
  set: (s, v) => ({ ...s, background: { ...v, on: true } }),
};
const WRAP_OPTIONS = WRAP_WIDTHS.map((w) => ({ value: String(w), label: `${w}px` }));
const wrapWidthText: Lens<TextNoteStyle, string> = {
  get: (s) => String(s.wrap.width),
  set: (s, v) => ({ ...s, wrap: { ...s.wrap, width: readOneOf(Number(v), WRAP_WIDTHS, s.wrap.width) } }),
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
  bar: { textColor: L("label", "color"), fill: backgroundShownOnPick },
  settings: {
    style: [
      { kind: "fill", label: "배경", lens: L("background") },
      { kind: "toggle", label: "테두리", lens: L("border", "on") },
      ...strokeFields("테두리", borderStroke),
      { kind: "toggle", label: "줄바꿈", lens: L("wrap", "on") },
      select("줄바꿈 폭", WRAP_OPTIONS, wrapWidthText),
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
