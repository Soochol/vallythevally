import { at, defaultStroke, defaultText, readBool, readOneOf, readRecord, readStroke, readTextStyle, select, strokeFields } from "../styleKit";
import { defineTool, type SettingsTabs, type Shape } from "../toolSpec";
import type { Stroke, TextStyle } from "../types";

type Align = "left" | "center" | "right";
type VAlign = "top" | "middle" | "bottom";

export interface HLineStyle {
  v: 1;
  line: Stroke;
  priceLabel: boolean;
  label: TextStyle & { align: Align; vAlign: VAlign };
}

const ALIGNS: readonly Align[] = ["left", "center", "right"];
const VALIGNS: readonly VAlign[] = ["top", "middle", "bottom"];

export const hlineDefaults = (): HLineStyle => ({
  v: 1,
  line: defaultStroke(),
  priceLabel: true,
  label: { ...defaultText(), align: "right", vAlign: "top" },
});

export function parseHLineStyle(raw: unknown): HLineStyle {
  const d = hlineDefaults();
  const o = readRecord(raw);
  const label = readRecord(o.label);
  return {
    ...o,
    v: 1,
    line: readStroke(o.line, d.line),
    priceLabel: readBool(o.priceLabel, d.priceLabel),
    label: {
      ...readTextStyle(o.label, d.label),
      align: readOneOf(label.align, ALIGNS, d.label.align),
      vAlign: readOneOf(label.vAlign, VALIGNS, d.label.vAlign),
    },
  };
}

const TEXT_GAP = 4;
const BASELINE: Record<VAlign, "bottom" | "middle" | "top"> = { top: "bottom", middle: "middle", bottom: "top" };

export function lineText(style: HLineStyle, text: string | null, y: number, x1: number, x2: number): Shape[] {
  if (text === null || text === "") return [];
  const { align, vAlign } = style.label;
  const x = align === "left" ? x1 + TEXT_GAP : align === "center" ? (x1 + x2) / 2 : x2 - TEXT_GAP;
  const dy = vAlign === "top" ? -TEXT_GAP : vAlign === "bottom" ? TEXT_GAP : 0;
  return [{ kind: "text", at: { x, y: y + dy }, text, style: style.label, align, baseline: BASELINE[vAlign] }];
}

const L = at<HLineStyle>();

export const hlineSettings: SettingsTabs<HLineStyle> = {
  style: [...strokeFields("선", L("line")), { kind: "toggle", label: "가격 라벨", lens: L("priceLabel") }],
  text: [
    { kind: "text", label: "글자", multiline: false },
    {
      kind: "textStyle",
      label: "글자 모양",
      lens: { get: (s) => s.label, set: (s, v) => ({ ...s, label: { ...s.label, ...v } }) },
    },
    select(
      "가로 정렬",
      [
        { value: "left", label: "왼쪽" },
        { value: "center", label: "가운데" },
        { value: "right", label: "오른쪽" },
      ],
      L("label", "align"),
    ),
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
};

export const hline = defineTool<HLineStyle>({
  tool: "hline",
  group: "line",
  label: "수평선",
  icon: "M3 12 H21",
  placement: { kind: "points", count: 1 },
  pointRoles: [{ label: "가격", uses: "price" }],
  text: { editOnPlace: false },
  defaultStyle: hlineDefaults,
  parseStyle: parseHLineStyle,
  bar: { lineColor: L("line", "color"), width: L("line", "width"), dash: L("line", "dash") },
  settings: hlineSettings,
  shapes({ points, style, text }, ctx) {
    const p = points[0];
    const y = p === undefined ? null : ctx.yOf(p.price);
    if (y === null) return [];
    return [{ kind: "segment", a: { x: 0, y }, b: { x: ctx.paneWidth, y }, stroke: style.line }, ...lineText(style, text, y, 0, ctx.paneWidth)];
  },
  handles({ points }, ctx) {
    const p = points[0];
    const y = p === undefined ? null : ctx.yOf(p.price);
    if (p === undefined || y === null) return [];
    const x = ctx.xOf(p.t) ?? ctx.paneWidth / 2;
    return [{ at: { x, y }, move: (pts, to) => pts.map((q) => ({ ...q, price: to.price })) }];
  },
  axisLabels({ points, style }, ctx) {
    const p = points[0];
    if (p === undefined || !style.priceLabel) return [];
    return [{ axis: "price", value: p.price, text: ctx.formatPrice(p.price), color: style.line.color }];
  },
});
