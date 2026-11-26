import { at, CHART_BACKGROUND, defaultStroke, defaultText, readBool, readFill, readNumber, readOneOf, readRecord, readStroke, readTextStyle, select, strokeFields } from "../styleKit";
import { defineTool, type Lens, type ToolContext } from "../toolSpec";
import type { DrawingPoint, Fill, ScreenPoint, Stroke, TextStyle } from "../types";
import { NOTE_PADDING, shownOnPick, shownText } from "./text";

const WRAP_WIDTHS = [100, 150, 200, 300, 400, 600] as const;
type WrapWidth = (typeof WRAP_WIDTHS)[number];

export interface AnchoredTextStyle {
  v: 1;
  anchorX: number;
  anchorY: number;
  label: TextStyle;
  background: Fill;
  border: Stroke & { on: boolean };
  wrap: { on: boolean; width: WrapWidth };
}

const clampFrac = (n: number) => Math.round(Math.min(0.96, Math.max(0.02, n)) * 1000) / 1000;

export const anchoredTextDefaults = (): AnchoredTextStyle => ({
  v: 1,
  anchorX: 0.12,
  anchorY: 0.14,
  label: defaultText(),
  background: { on: true, color: CHART_BACKGROUND, opacity: 0.88 },
  border: { ...defaultStroke(), width: 1, on: true },
  wrap: { on: true, width: 200 },
});

export function parseAnchoredTextStyle(raw: unknown): AnchoredTextStyle {
  const d = anchoredTextDefaults();
  const o = readRecord(raw);
  const border = readRecord(o.border);
  const wrap = readRecord(o.wrap);
  return {
    ...o,
    v: 1,
    anchorX: clampFrac(readNumber(o.anchorX, d.anchorX)),
    anchorY: clampFrac(readNumber(o.anchorY, d.anchorY)),
    label: readTextStyle(o.label, d.label),
    background: readFill(o.background, d.background),
    border: { ...readStroke(o.border, d.border), on: readBool(border.on, d.border.on) },
    wrap: { ...wrap, on: readBool(wrap.on, d.wrap.on), width: readOneOf(wrap.width, WRAP_WIDTHS, d.wrap.width) },
  };
}

function screenOf(style: AnchoredTextStyle, ctx: ToolContext): ScreenPoint {
  return {
    x: style.anchorX * Math.max(1, ctx.paneWidth),
    y: style.anchorY * Math.max(1, ctx.paneHeight),
  };
}

const L = at<AnchoredTextStyle>();
const borderStroke: Lens<AnchoredTextStyle, Stroke> = {
  get: (s) => s.border,
  set: (s, v) => ({ ...s, border: { ...s.border, ...v } }),
};
const WRAP_OPTIONS = WRAP_WIDTHS.map((w) => ({ value: String(w), label: `${w}px` }));
const wrapWidthText: Lens<AnchoredTextStyle, string> = {
  get: (s) => String(s.wrap.width),
  set: (s, v) => ({ ...s, wrap: { ...s.wrap, width: readOneOf(Number(v), WRAP_WIDTHS, s.wrap.width) } }),
};
const xPercent: Lens<AnchoredTextStyle, number> = {
  get: (s) => Math.round(s.anchorX * 100),
  set: (s, v) => ({ ...s, anchorX: clampFrac(v / 100) }),
};
const yPercent: Lens<AnchoredTextStyle, number> = {
  get: (s) => Math.round(s.anchorY * 100),
  set: (s, v) => ({ ...s, anchorY: clampFrac(v / 100) }),
};

export const anchoredtext = defineTool<AnchoredTextStyle>({
  tool: "anchoredtext",
  group: "note",
  label: "고정 글자",
  icon: "M5 5 H19 M12 5 V14 M9 14 H15 M12 14 V20 M8 18 A4 4 0 0 0 16 18",
  placement: { kind: "points", count: 1 },
  pointRoles: [{ label: "기준 자리", uses: "both" }],
  text: { editOnPlace: true },
  defaultStyle: anchoredTextDefaults,
  parseStyle: parseAnchoredTextStyle,
  initStyle(points, style, ctx) {
    const p = points[0];
    const s = p === undefined ? null : ctx.toScreen(p);
    if (s === null || ctx.paneWidth <= 0 || ctx.paneHeight <= 0) return style;
    return {
      ...style,
      anchorX: clampFrac(s.x / ctx.paneWidth),
      anchorY: clampFrac(s.y / ctx.paneHeight),
    };
  },
  moveBody({ points, style }, delta, ctx) {
    const w = Math.max(1, ctx.paneWidth);
    const h = Math.max(1, ctx.paneHeight);
    const anchorX = clampFrac(style.anchorX + delta.x / w);
    const anchorY = clampFrac(style.anchorY + delta.y / h);
    const mapped = ctx.fromScreen({ x: anchorX * w, y: anchorY * h });
    return {
      points: mapped === null ? [...points] : [mapped],
      style: { ...style, anchorX, anchorY },
    };
  },
  anchors({ style }, ctx) {
    return [screenOf(style, ctx)];
  },
  bar: { textColor: L("label", "color"), fill: shownOnPick(L("background")) },
  settings: {
    inputs: [
      { kind: "number", label: "가로 위치", min: 2, max: 96, step: 1, unit: "%", lens: xPercent },
      { kind: "number", label: "세로 위치", min: 2, max: 96, step: 1, unit: "%", lens: yPercent },
    ],
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
  shapes({ style, text }, ctx) {
    const at = screenOf(style, ctx);
    const { on, ...border } = style.border;
    return [
      {
        kind: "text",
        at,
        text: shownText(text),
        style: style.label,
        align: "left",
        baseline: "top",
        box: {
          background: style.background,
          border: on ? border : undefined,
          padding: NOTE_PADDING,
          wrapWidth: style.wrap.on ? style.wrap.width : null,
          band: on ? border.color : undefined,
        },
      },
    ];
  },
  handles({ style }, ctx) {
    const at = screenOf(style, ctx);
    return [
      {
        at,
        move: (_pts: readonly DrawingPoint[], to: DrawingPoint) => [to],
        moveStyle: (raw, toScreen, c) => ({
          ...parseAnchoredTextStyle(raw),
          anchorX: clampFrac(toScreen.x / Math.max(1, c.paneWidth)),
          anchorY: clampFrac(toScreen.y / Math.max(1, c.paneHeight)),
        }),
      },
    ];
  },
  axisLabels: () => [],
});
