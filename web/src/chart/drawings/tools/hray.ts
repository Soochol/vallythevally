import { at } from "../styleKit";
import { type AxisLabel, defineTool } from "../toolSpec";
import { type HLineStyle, hlineDefaults, hlineSettings, lineText, parseHLineStyle } from "./hline";

const L = at<HLineStyle>();

export const hray = defineTool<HLineStyle>({
  tool: "hray",
  group: "line",
  label: "수평 반직선",
  icon: "M3 12 A1.5 1.5 0 1 0 6 12 A1.5 1.5 0 1 0 3 12 M6 12 H21",
  placement: { kind: "points", count: 1 },
  pointRoles: [{ label: "시작", uses: "both" }],
  text: { editOnPlace: false },
  defaultStyle: hlineDefaults,
  parseStyle: parseHLineStyle,
  bar: { lineColor: L("line", "color"), width: L("line", "width"), dash: L("line", "dash") },
  settings: hlineSettings,
  shapes({ points, style, text }, ctx) {
    const p = points[0];
    const a = p === undefined ? null : ctx.toScreen(p);
    if (a === null) return [];
    const right = Math.max(a.x, ctx.paneWidth);
    return [{ kind: "segment", a, b: { x: right, y: a.y }, stroke: style.line }, ...lineText(style, text, a.y, Math.max(a.x, 0), right)];
  },
  handles({ points }, ctx) {
    const p = points[0];
    const a = p === undefined ? null : ctx.toScreen(p);
    return a === null ? [] : [{ at: a, move: (_, to) => [to] }];
  },
  axisLabels({ points, style, selected }, ctx) {
    const p = points[0];
    if (p === undefined) return [];
    const labels: AxisLabel[] = [];
    if (style.priceLabel) labels.push({ axis: "price", value: p.price, text: ctx.formatPrice(p.price), color: style.line.color });
    if (selected) labels.push({ axis: "time", value: p.t, text: ctx.formatTime(p.t), color: style.line.color });
    return labels;
  },
});
