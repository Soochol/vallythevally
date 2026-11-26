import { at, CHART_BACKGROUND, defaultStroke, defaultText, readBool, readFill, readRecord, readStroke, readTextStyle, strokeFields, strokeOpacity } from "../styleKit";
import { defineTool, type Shape } from "../toolSpec";
import type { DrawingPoint, Fill, ScreenPoint, Stroke, TextStyle } from "../types";
import { NOTE_PADDING, shownOnPick } from "./text";

export interface PriceNoteStyle {
  v: 1;
  label: TextStyle;
  background: Fill;
  line: Stroke;
  border: boolean;
  showGap: boolean;
}

export const priceNoteDefaults = (): PriceNoteStyle => ({
  v: 1,
  label: { ...defaultText(), size: 12 },
  background: { on: true, color: CHART_BACKGROUND, opacity: 0.9 },
  line: { ...defaultStroke(), width: 1 },
  border: true,
  showGap: true,
});

export function parsePriceNoteStyle(raw: unknown): PriceNoteStyle {
  const d = priceNoteDefaults();
  const o = readRecord(raw);
  return {
    ...o,
    v: 1,
    label: readTextStyle(o.label, d.label),
    background: readFill(o.background, d.background),
    line: readStroke(o.line, d.line),
    border: readBool(o.border, d.border),
    showGap: readBool(o.showGap, d.showGap),
  };
}

const L = at<PriceNoteStyle>();

function screenPoints(points: readonly DrawingPoint[], toScreen: (p: DrawingPoint) => ScreenPoint | null) {
  const [target, box] = points;
  return { target: target === undefined ? null : toScreen(target), box: box === undefined ? null : toScreen(box) };
}

export const pricenote = defineTool<PriceNoteStyle>({
  tool: "pricenote",
  group: "note",
  label: "가격 노트",
  icon: "M4 17 L9 12 H20 V20 H9 Z M4 17 A1.5 1.5 0 1 1 4 16.9 M11 15 H18 M11 18 H16",
  placement: { kind: "points", count: 2 },
  pointRoles: [
    { label: "가격 기준", uses: "both" },
    { label: "노트 위치", uses: "both" },
  ],
  text: { editOnPlace: true },
  defaultStyle: priceNoteDefaults,
  parseStyle: parsePriceNoteStyle,
  bar: {
    lineColor: L("line", "color"),
    lineOpacity: strokeOpacity(L("line")),
    width: L("line", "width"),
    dash: L("line", "dash"),
    fill: shownOnPick(L("background")),
    textColor: L("label", "color"),
  },
  settings: {
    style: [
      ...strokeFields("선", L("line")),
      { kind: "toggle", label: "테두리", lens: L("border") },
      { kind: "fill", label: "배경", lens: L("background") },
      { kind: "toggle", label: "현재가 괴리율", lens: L("showGap") },
    ],
    text: [
      { kind: "text", label: "메모", multiline: true },
      { kind: "textStyle", label: "글자 모양", lens: L("label") },
    ],
  },
  shapes({ points, style, text }, ctx) {
    const p0 = points[0];
    const { target, box } = screenPoints(points, ctx.toScreen);
    if (p0 === undefined || box === null) return [];
    const shapes: Shape[] = [];
    if (target !== null) {
      shapes.push(
        { kind: "segment", a: target, b: box, stroke: style.line },
        { kind: "circle", c: target, r: 3.5, stroke: style.line, fill: { on: true, color: style.line.color, opacity: 1 } },
      );
    }
    let header = ctx.formatPrice(p0.price);
    if (style.showGap && ctx.lastPrice != null && ctx.lastPrice > 0) {
      const pct = ((p0.price - ctx.lastPrice) / ctx.lastPrice) * 100;
      const sign = pct > 0 ? "+" : "";
      header = `${header} (${sign}${pct.toFixed(1)}%)`;
    }
    const memo = text?.trim() ?? "";
    const content = memo ? `${header}\n${memo}` : header;
    const towardTarget = target ?? box;
    shapes.push({
      kind: "text",
      at: box,
      text: content,
      style: style.label,
      align: towardTarget.x <= box.x ? "left" : "right",
      baseline: towardTarget.y <= box.y ? "top" : "bottom",
      box: {
        background: style.background,
        border: style.border ? style.line : undefined,
        padding: NOTE_PADDING,
        wrapWidth: null,
        band: style.line.color,
      },
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
  axisLabels({ points, style, selected }, ctx) {
    if (!selected) return [];
    const p0 = points[0];
    if (p0 === undefined) return [];
    return [{ axis: "price", value: p0.price, text: ctx.formatPrice(p0.price), color: style.line.color }];
  },
});
