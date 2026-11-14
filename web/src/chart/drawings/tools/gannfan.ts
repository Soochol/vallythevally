import { at, DRAW, readBool, readRecord, readStroke, strokeFields } from "../styleKit";
import { defineTool, type Shape } from "../toolSpec";
import type { Stroke } from "../types";
import { type Band, fanRay, fanSide, fanWedge, pointHandles, readBand } from "./fibKit";
import { cornerLabels, cornersOf } from "./rect";

export interface GannFanStyle {
  v: 1;
  line: Stroke;
  labels: boolean;
  fill: Band;
}

export const gannFanDefaults = (): GannFanStyle => ({
  v: 1,
  line: { color: DRAW, width: 1, dash: "solid" },
  labels: true,
  fill: { on: true, opacity: 0.08 },
});

export function parseGannFanStyle(raw: unknown): GannFanStyle {
  const d = gannFanDefaults();
  const o = readRecord(raw);
  return { ...o, v: 1, line: readStroke(o.line, d.line), labels: readBool(o.labels, d.labels), fill: readBand(o.fill, d.fill) };
}

export interface GannRatio {
  price: number;
  time: number;
}

export const GANN_RATIOS: readonly GannRatio[] = [
  { price: 1, time: 8 },
  { price: 1, time: 4 },
  { price: 1, time: 3 },
  { price: 1, time: 2 },
  { price: 1, time: 1 },
  { price: 2, time: 1 },
  { price: 3, time: 1 },
  { price: 4, time: 1 },
  { price: 8, time: 1 },
];

const LABEL_GAP = 4;

const L = at<GannFanStyle>();

export const gannfan = defineTool<GannFanStyle>({
  tool: "gannfan",
  group: "fib",
  label: "갠 팬",
  icon: "M4 20 L8 4 M4 20 L12 4 M4 20 L20 4 M4 20 L20 12 M4 20 L20 16",
  placement: { kind: "points", count: 2 },
  pointRoles: [
    { label: "원점", uses: "both" },
    { label: "1×1", uses: "both" },
  ],
  defaultStyle: gannFanDefaults,
  parseStyle: parseGannFanStyle,
  bar: { lineColor: L("line", "color"), width: L("line", "width"), dash: L("line", "dash") },
  settings: {
    style: [
      ...strokeFields("선", L("line")),
      { kind: "toggle", label: "이름 꼬리표", lens: L("labels") },
      { kind: "toggle", label: "부채꼴 채움", lens: L("fill", "on") },
      { kind: "number", label: "채움 불투명도", min: 0, max: 1, step: 0.05, lens: L("fill", "opacity") },
    ],
  },
  shapes({ points, style }, ctx) {
    const corners = cornersOf(points, ctx);
    if (corners === null) return [];
    const { a, b } = corners;
    const side = fanSide(a, b);
    if (side === null) return [{ kind: "segment", a, b, stroke: style.line }];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lines = GANN_RATIOS.map((ratio) => ({ ratio, through: { x: a.x + dx * ratio.time, y: a.y + dy * ratio.price } }));
    const fill = { on: true, color: style.line.color, opacity: style.fill.opacity };
    const wedges: Shape[] = style.fill.on
      ? lines.flatMap(({ through }, i): Shape[] => {
          const next = lines[i + 1];
          return next === undefined ? [] : [fanWedge(a, through, next.through, side, fill, ctx)];
        })
      : [];
    const rays = lines.map(({ through }) => fanRay(a, through, side, style.line));
    const labels: Shape[] = style.labels
      ? lines.map(({ ratio, through }) => ({
          kind: "text",
          at: { x: through.x + (side === "right" ? LABEL_GAP : -LABEL_GAP), y: through.y },
          text: `${ratio.price}×${ratio.time}`,
          align: side === "right" ? "left" : "right",
          baseline: "middle",
          style: { color: style.line.color, size: 12, bold: false, italic: false },
        }))
      : [];
    return [...wedges, ...rays, ...labels];
  },
  handles: ({ points }, ctx) => pointHandles(points, ctx),
  axisLabels: ({ points, style, selected }, ctx) => cornerLabels(points, selected, style.line.color, ctx),
});
