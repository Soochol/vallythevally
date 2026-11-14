import { at, readBool, readRecord } from "../styleKit";
import { defineTool, type Level, type Shape, type ToolContext } from "../toolSpec";
import type { ScreenPoint } from "../types";
import { type Band, fanRay, fanSide, fanWedge, levelColor, type LineLook, mainColor, MAX_LEVELS, pointHandles, readBand, readLevels, readLineLook } from "./fibKit";
import { cornerLabels, cornersOf } from "./rect";

export const FIBFAN_LEVELS: readonly Level[] = [
  { value: 0, color: "#787b86", on: true },
  { value: 0.25, color: "#f23645", on: true },
  { value: 0.382, color: "#ff9800", on: true },
  { value: 0.5, color: "#4caf50", on: true },
  { value: 0.618, color: "#089981", on: true },
  { value: 0.75, color: "#00bcd4", on: true },
  { value: 1, color: "#787b86", on: true },
];

export interface FibFanStyle {
  v: 1;
  levels: readonly Level[];
  line: LineLook;
  labels: boolean;
  fill: Band;
}

export const fibFanDefaults = (): FibFanStyle => ({
  v: 1,
  levels: FIBFAN_LEVELS.map((l) => ({ ...l })),
  line: { width: 1, dash: "solid" },
  labels: true,
  fill: { on: true, opacity: 0.12 },
});

export function parseFibFanStyle(raw: unknown): FibFanStyle {
  const d = fibFanDefaults();
  const o = readRecord(raw);
  return {
    ...o,
    v: 1,
    levels: readLevels(o.levels, d.levels),
    line: readLineLook(o.line, d.line),
    labels: readBool(o.labels, d.labels),
    fill: readBand(o.fill, d.fill),
  };
}

const LABEL_GAP = 4;

interface FanLine {
  level: Level;
  through: ScreenPoint;
}

function fanLines(style: FibFanStyle, start: { price: number }, end: { price: number }, x: number, ctx: ToolContext): FanLine[] {
  return style.levels
    .filter((level) => level.on)
    .flatMap((level) => {
      const y = ctx.yOf(start.price + (end.price - start.price) * level.value);
      return y === null ? [] : [{ level, through: { x, y } }];
    })
    .sort((a, b) => a.level.value - b.level.value);
}

const L = at<FibFanStyle>();

export const fibfan = defineTool<FibFanStyle>({
  tool: "fibfan",
  group: "fib",
  label: "피보나치 팬",
  icon: "M4 20 L20 4 M4 20 L20 9 M4 20 L20 14 M4 20 H20",
  placement: { kind: "points", count: 2 },
  pointRoles: [
    { label: "시작", uses: "both" },
    { label: "끝", uses: "both" },
  ],
  defaultStyle: fibFanDefaults,
  parseStyle: parseFibFanStyle,
  bar: { lineColor: levelColor<FibFanStyle>(), width: L("line", "width"), dash: L("line", "dash") },
  settings: {
    style: [
      { kind: "levels", label: "수준", max: MAX_LEVELS, lens: L("levels") },
      { kind: "width", label: "선 굵기", lens: L("line", "width") },
      { kind: "dash", label: "선 모양", lens: L("line", "dash") },
      { kind: "toggle", label: "비율 꼬리표", lens: L("labels") },
      { kind: "toggle", label: "부채꼴 채움", lens: L("fill", "on") },
      { kind: "number", label: "채움 불투명도", min: 0, max: 1, step: 0.05, lens: L("fill", "opacity") },
    ],
  },
  shapes({ points, style }, ctx) {
    const corners = cornersOf(points, ctx);
    if (corners === null) return [];
    const { p0, p1, a, b } = corners;
    const stroke = (level: Level) => ({ color: level.color, width: style.line.width, dash: style.line.dash });
    const side = fanSide(a, b);
    if (side === null) return [{ kind: "segment", a, b, stroke: { color: mainColor(style), ...style.line } }];
    const lines = fanLines(style, p0, p1, b.x, ctx);
    const wedges: Shape[] = style.fill.on
      ? lines.flatMap(({ through }, i): Shape[] => {
          const upper = lines[i + 1];
          return upper === undefined ? [] : [fanWedge(a, through, upper.through, side, { on: true, color: upper.level.color, opacity: style.fill.opacity }, ctx)];
        })
      : [];
    const rays = lines.map(({ level, through }) => fanRay(a, through, side, stroke(level)));
    const labels: Shape[] = style.labels
      ? lines.map(({ level, through }) => ({
          kind: "text",
          at: { x: through.x + (side === "right" ? LABEL_GAP : -LABEL_GAP), y: through.y },
          text: String(level.value),
          align: side === "right" ? "left" : "right",
          baseline: "middle",
          style: { color: level.color, size: 12, bold: false, italic: false },
        }))
      : [];
    return [...wedges, ...rays, ...labels];
  },
  handles: ({ points }, ctx) => pointHandles(points, ctx),
  axisLabels: ({ points, style, selected }, ctx) => cornerLabels(points, selected, mainColor(style), ctx),
});
