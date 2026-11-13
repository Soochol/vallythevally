import { at, defaultFill, defaultText, readFill, readRecord, readTextStyle } from "../styleKit";
import { defineTool } from "../toolSpec";
import type { DrawingPoint, Fill, TextStyle } from "../types";

export interface PriceLabelStyle {
  v: 1;
  label: TextStyle;
  background: Fill;
}

export const priceLabelDefaults = (): PriceLabelStyle => ({
  v: 1,
  label: { ...defaultText(), size: 12 },
  background: defaultFill(),
});

export function parsePriceLabelStyle(raw: unknown): PriceLabelStyle {
  const d = priceLabelDefaults();
  const o = readRecord(raw);
  return { ...o, v: 1, label: readTextStyle(o.label, d.label), background: readFill(o.background, d.background) };
}

const TAG_OFFSET = 12;
const TAG_PADDING = 4;

const L = at<PriceLabelStyle>();

export const pricelabel = defineTool<PriceLabelStyle>({
  tool: "pricelabel",
  group: "note",
  label: "가격 라벨",
  icon: "M4 12 L9 7 H20 V17 H9 Z",
  placement: { kind: "points", count: 1 },
  pointRoles: [{ label: "가격", uses: "both" }],
  text: { editOnPlace: false },
  defaultStyle: priceLabelDefaults,
  parseStyle: parsePriceLabelStyle,
  bar: { textColor: L("label", "color"), fill: L("background") },
  settings: {
    style: [{ kind: "fill", label: "배경", lens: L("background") }],
    text: [{ kind: "textStyle", label: "글자 모양", lens: L("label") }],
  },
  shapes({ points, style }, ctx) {
    const p = points[0];
    const a = p === undefined ? null : ctx.toScreen(p);
    if (p === undefined || a === null) return [];
    const tag = { x: a.x + TAG_OFFSET, y: a.y - TAG_OFFSET };
    return [
      { kind: "segment", a, b: { x: tag.x - TAG_PADDING, y: tag.y + TAG_PADDING }, stroke: { color: style.label.color, width: 1, dash: "solid" } },
      {
        kind: "text",
        at: tag,
        text: ctx.formatPrice(p.price),
        style: style.label,
        align: "left",
        baseline: "bottom",
        box: { background: style.background, padding: TAG_PADDING, wrapWidth: null },
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
