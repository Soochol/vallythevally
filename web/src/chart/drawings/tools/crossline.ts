import { at, defaultStroke, readBool, readRecord, readStroke, strokeFields } from "../styleKit";
import { type AxisLabel, defineTool, type Shape } from "../toolSpec";
import type { Stroke } from "../types";

export interface CrosslineStyle {
  v: 1;
  line: Stroke;
  allPanes: boolean;
  priceLabel: boolean;
  timeLabel: boolean;
}

export const crosslineDefaults = (): CrosslineStyle => ({
  v: 1,
  line: defaultStroke(),
  allPanes: false,
  priceLabel: true,
  timeLabel: true,
});

export function parseCrosslineStyle(raw: unknown): CrosslineStyle {
  const d = crosslineDefaults();
  const o = readRecord(raw);
  return {
    ...o,
    v: 1,
    line: readStroke(o.line, d.line),
    allPanes: readBool(o.allPanes, d.allPanes),
    priceLabel: readBool(o.priceLabel, d.priceLabel),
    timeLabel: readBool(o.timeLabel, d.timeLabel),
  };
}

const L = at<CrosslineStyle>();

export const crossline = defineTool<CrosslineStyle>({
  tool: "crossline",
  group: "line",
  label: "십자선",
  icon: "M3 12 H21 M12 3 V21",
  placement: { kind: "points", count: 1 },
  pointRoles: [{ label: "교차점", uses: "both" }],
  defaultStyle: crosslineDefaults,
  parseStyle: parseCrosslineStyle,
  bar: { lineColor: L("line", "color"), width: L("line", "width"), dash: L("line", "dash") },
  settings: {
    style: [
      ...strokeFields("선", L("line")),
      { kind: "toggle", label: "모든 패널에 긋기", lens: L("allPanes") },
      { kind: "toggle", label: "가격 라벨", lens: L("priceLabel") },
      { kind: "toggle", label: "시간 라벨", lens: L("timeLabel") },
    ],
  },
  shapes({ points, style }, ctx) {
    const p = points[0];
    if (p === undefined) return [];
    const shapes: Shape[] = [];
    const y = ctx.yOf(p.price);
    const x = ctx.xOf(p.t);
    if (y !== null) shapes.push({ kind: "segment", a: { x: 0, y }, b: { x: ctx.paneWidth, y }, stroke: style.line });
    if (x !== null) shapes.push({ kind: "vline", x, stroke: style.line, allPanes: style.allPanes });
    return shapes;
  },
  handles({ points }, ctx) {
    const p = points[0];
    const s = p === undefined ? null : ctx.toScreen(p);
    return s === null ? [] : [{ at: s, move: (_, to) => [to] }];
  },
  axisLabels({ points, style }, ctx) {
    const p = points[0];
    if (p === undefined) return [];
    const labels: AxisLabel[] = [];
    if (style.priceLabel) labels.push({ axis: "price", value: p.price, text: ctx.formatPrice(p.price), color: style.line.color });
    if (style.timeLabel) labels.push({ axis: "time", value: p.t, text: ctx.formatTime(p.t), color: style.line.color });
    return labels;
  },
});
