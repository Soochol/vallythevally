import { at, readBool, readRecord } from "../styleKit";
import { type AxisLabel, defineTool, type Level, type Shape, type ToolContext } from "../toolSpec";
import type { DrawingPoint, Stroke } from "../types";
import { levelColor, type LineLook, mainColor, MAX_LEVELS, readLevels, readLineLook } from "./fibKit";

export const FIBTIME_LEVELS: readonly Level[] = [
  { value: 0, color: "#787b86", on: true },
  { value: 1, color: "#2962ff", on: true },
  { value: 2, color: "#2962ff", on: true },
  { value: 3, color: "#2962ff", on: true },
  { value: 5, color: "#2962ff", on: true },
  { value: 8, color: "#2962ff", on: true },
  { value: 13, color: "#2962ff", on: true },
  { value: 21, color: "#2962ff", on: true },
  { value: 34, color: "#2962ff", on: true },
  { value: 55, color: "#2962ff", on: true },
  { value: 89, color: "#2962ff", on: true },
];

export interface FibTimeStyle {
  v: 1;
  levels: readonly Level[];
  line: LineLook;
  labels: boolean;
}

export const fibTimeDefaults = (): FibTimeStyle => ({
  v: 1,
  levels: FIBTIME_LEVELS.map((l) => ({ ...l })),
  line: { width: 1, dash: "solid" },
  labels: true,
});

export function parseFibTimeStyle(raw: unknown): FibTimeStyle {
  const d = fibTimeDefaults();
  const o = readRecord(raw);
  return { ...o, v: 1, levels: readLevels(o.levels, d.levels), line: readLineLook(o.line, d.line), labels: readBool(o.labels, d.labels) };
}

const LABEL_GAP = 4;

interface TimeLine {
  level: Level | null;
  x: number;
}

function screenXs(points: readonly DrawingPoint[], ctx: ToolContext): TimeLine[] {
  return points.flatMap((p) => {
    const x = ctx.xOf(p.t);
    return x === null ? [] : [{ level: null, x }];
  });
}

function timeLines(style: FibTimeStyle, start: DrawingPoint, end: DrawingPoint, ctx: ToolContext): TimeLine[] {
  const bars = ctx.barsBetween(start.t, end.t);
  if (bars === null) return screenXs([start, end], ctx);
  const startX = ctx.xOf(start.t);
  const startBar = ctx.shiftBars(start.t, 0);
  const startBarX = startBar === null ? null : ctx.xOf(startBar);
  const intoBar = startX === null || startBarX === null ? 0 : startX - startBarX;
  const unit = Math.max(1, bars.count);
  const direction = end.t < start.t ? -1 : 1;
  return style.levels
    .filter((level) => level.on)
    .flatMap((level) => {
      const t = ctx.shiftBars(start.t, direction * Math.round(unit * level.value));
      const x = t === null ? null : ctx.xOf(t);
      return x === null ? [] : [{ level, x: x + intoBar }];
    });
}

const L = at<FibTimeStyle>();

export const fibtime = defineTool<FibTimeStyle>({
  tool: "fibtime",
  group: "fib",
  label: "피보나치 시간대",
  icon: "M4 4 V20 M7 4 V20 M10 4 V20 M14 4 V20 M20 4 V20",
  placement: { kind: "points", count: 2 },
  pointRoles: [
    { label: "시작", uses: "time" },
    { label: "끝", uses: "time" },
  ],
  defaultStyle: fibTimeDefaults,
  parseStyle: parseFibTimeStyle,
  bar: { lineColor: levelColor<FibTimeStyle>(), width: L("line", "width"), dash: L("line", "dash") },
  settings: {
    style: [
      { kind: "levels", label: "수준", max: MAX_LEVELS, lens: L("levels") },
      { kind: "width", label: "선 굵기", lens: L("line", "width") },
      { kind: "dash", label: "선 모양", lens: L("line", "dash") },
      { kind: "toggle", label: "숫자 꼬리표", lens: L("labels") },
    ],
  },
  shapes({ points, style }, ctx) {
    const [start, end] = points;
    if (start === undefined || end === undefined) return [];
    return timeLines(style, start, end, ctx).flatMap(({ level, x }): Shape[] => {
      const stroke: Stroke = { color: level?.color ?? mainColor(style), width: style.line.width, dash: style.line.dash };
      const line: Shape = { kind: "vline", x, stroke, allPanes: false };
      if (level === null || !style.labels) return [line];
      return [
        line,
        {
          kind: "text",
          at: { x: x + LABEL_GAP, y: ctx.paneHeight - LABEL_GAP },
          text: String(level.value),
          align: "left",
          baseline: "bottom",
          style: { color: level.color, size: 12, bold: false, italic: false },
        },
      ];
    });
  },
  handles({ points }, ctx) {
    return points.flatMap((p, i) => {
      const x = ctx.xOf(p.t);
      return x === null ? [] : [{ at: { x, y: ctx.paneHeight / 2 }, move: (pts: readonly DrawingPoint[], to: DrawingPoint) => pts.map((q, j) => (j === i ? { ...q, t: to.t } : q)) }];
    });
  },
  axisLabels({ points, style, selected }, ctx) {
    if (!selected) return [];
    return points.map((p): AxisLabel => ({ axis: "time", value: p.t, text: ctx.formatTime(p.t), color: mainColor(style) }));
  },
});
