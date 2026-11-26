import { at, defaultText, DOWN, labelBox, readBool, readNumber, readRecord, readString, readTextStyle, UP } from "../styleKit";
import { defineTool, type Shape } from "../toolSpec";
import type { Color, DrawingPoint, ScreenPoint, TextStyle } from "../types";

export interface ArrowMarkStyle {
  v: 1;
  color: Color;
  size: number;
  showPrice: boolean;
  label: TextStyle;
}

const SIZE_MIN = 14;
const SIZE_MAX = 40;

const defaultsFor = (color: Color): ArrowMarkStyle => ({
  v: 1,
  color,
  size: 22,
  showPrice: false,
  label: { ...defaultText(), color, size: 12, bold: true },
});

function parseFor(color: Color) {
  return (raw: unknown): ArrowMarkStyle => {
    const d = defaultsFor(color);
    const o = readRecord(raw);
    return {
      ...o,
      v: 1,
      color: readString(o.color, d.color),
      size: Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(readNumber(o.size, d.size)))),
      showPrice: readBool(o.showPrice, d.showPrice),
      label: readTextStyle(o.label, d.label),
    };
  };
}

function arrowPolygon(tip: ScreenPoint, size: number, direction: "up" | "down"): ScreenPoint[] {
  const dir = direction === "up" ? 1 : -1;
  const hw = size * 0.44;
  const sw = size * 0.18;
  const hh = size * 0.48;
  return [
    { x: tip.x, y: tip.y },
    { x: tip.x + hw, y: tip.y + dir * hh },
    { x: tip.x + sw, y: tip.y + dir * hh },
    { x: tip.x + sw, y: tip.y + dir * size },
    { x: tip.x - sw, y: tip.y + dir * size },
    { x: tip.x - sw, y: tip.y + dir * hh },
    { x: tip.x - hw, y: tip.y + dir * hh },
  ];
}

const L = at<ArrowMarkStyle>();

function makeArrowMark(direction: "up" | "down") {
  const color = direction === "up" ? UP : DOWN;
  return defineTool<ArrowMarkStyle>({
    tool: direction === "up" ? "arrowup" : "arrowdown",
    group: "note",
    label: direction === "up" ? "매수 화살표" : "매도 화살표",
    icon: direction === "up" ? "M12 4 L19 13 H14.5 V20 H9.5 V13 H5 Z" : "M12 20 L19 11 H14.5 V4 H9.5 V11 H5 Z",
    placement: { kind: "points", count: 1 },
    pointRoles: [{ label: "타점", uses: "both" }],
    text: { editOnPlace: false },
    defaultStyle: () => defaultsFor(color),
    parseStyle: parseFor(color),
    bar: { lineColor: L("color"), textColor: L("label", "color") },
    settings: {
      style: [
        { kind: "color", label: "화살표 색", lens: L("color") },
        { kind: "number", label: "크기", min: SIZE_MIN, max: SIZE_MAX, step: 2, unit: "px", lens: L("size") },
        { kind: "toggle", label: "가격 표시", lens: L("showPrice") },
      ],
      text: [
        { kind: "text", label: "메모", multiline: false },
        { kind: "textStyle", label: "글자 모양", lens: L("label") },
      ],
    },
    shapes({ points, style, text }, ctx) {
      const p = points[0];
      const tip = p === undefined ? null : ctx.toScreen(p);
      if (p === undefined || tip === null) return [];
      const shapes: Shape[] = [
        {
          kind: "polyline",
          points: arrowPolygon(tip, style.size, direction),
          closed: true,
          fill: { on: true, color: style.color, opacity: 0.92 },
          stroke: { color: style.color, width: 1, dash: "solid" },
        },
      ];
      const parts = [style.showPrice ? ctx.formatPrice(p.price) : "", text?.trim() ?? ""].filter(Boolean);
      if (parts.length > 0) {
        const dir = direction === "up" ? 1 : -1;
        shapes.push({
          kind: "text",
          at: { x: tip.x, y: tip.y + dir * (style.size + 4) },
          text: parts.join(" · "),
          style: style.label,
          align: "center",
          baseline: direction === "up" ? "top" : "bottom",
          box: labelBox(style.color),
        });
      }
      return shapes;
    },
    handles({ points }, ctx) {
      const p = points[0];
      const tip = p === undefined ? null : ctx.toScreen(p);
      if (tip === null) return [];
      return [{ at: tip, move: (_pts: readonly DrawingPoint[], to: DrawingPoint) => [to] }];
    },
    axisLabels({ points, style, selected }, ctx) {
      if (!selected) return [];
      const p = points[0];
      if (p === undefined) return [];
      return [{ axis: "price", value: p.price, text: ctx.formatPrice(p.price), color: style.color }];
    },
  });
}

export const arrowup = makeArrowMark("up");
export const arrowdown = makeArrowMark("down");
