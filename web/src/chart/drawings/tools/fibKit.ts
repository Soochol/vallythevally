import { at, DRAW, EXTEND_OPTIONS, EXTENDS, readBool, readNumber, readOneOf, readRecord, readString, readStroke, select } from "../styleKit";
import { type AxisLabel, defineTool, type Level, type PointRole, type Shape, type Tool, type ToolContext } from "../toolSpec";
import type { Color, Dash, DrawingPoint, Extend, ScreenPoint, Stroke, Width } from "../types";

export const MAX_LEVELS = 24;

export interface FibStyle {
  v: 1;
  levels: readonly Level[];
  line: { width: Width; dash: Dash };
  extend: Extend;
  labels: { ratio: boolean; price: boolean };
  fill: { on: boolean; opacity: number };
  trendLine: boolean;
  reverse: boolean;
}

export interface FibAnchor {
  zero: number;
  one: number;
}

export function levelPrice(anchor: FibAnchor, ratio: number, reverse: boolean): number {
  const { zero, one } = reverse ? { zero: anchor.one, one: anchor.zero } : anchor;
  return zero + (one - zero) * ratio;
}

const fibDefaults = (levels: readonly Level[]): FibStyle => ({
  v: 1,
  levels: levels.map((l) => ({ ...l })),
  line: { width: 1, dash: "solid" },
  extend: "none",
  labels: { ratio: true, price: true },
  fill: { on: true, opacity: 0.12 },
  trendLine: true,
  reverse: false,
});

function readLevels(raw: unknown, fallback: readonly Level[]): Level[] {
  if (!Array.isArray(raw)) return fallback.map((l) => ({ ...l }));
  const levels = raw.flatMap((item): Level[] => {
    const o = readRecord(item);
    if (typeof o.value !== "number" || !Number.isFinite(o.value)) return [];
    return [{ ...o, value: o.value, color: readString(o.color, DRAW), on: readBool(o.on, true) }];
  });
  return levels.slice(0, MAX_LEVELS);
}

function parseFibStyle(raw: unknown, d: FibStyle): FibStyle {
  const o = readRecord(raw);
  const line = readRecord(o.line);
  const { width, dash } = readStroke(line, { color: DRAW, ...d.line });
  const labels = readRecord(o.labels);
  const fill = readRecord(o.fill);
  return {
    ...o,
    v: 1,
    levels: readLevels(o.levels, d.levels),
    line: { ...line, width, dash },
    extend: readOneOf(o.extend, EXTENDS, d.extend),
    labels: { ...labels, ratio: readBool(labels.ratio, d.labels.ratio), price: readBool(labels.price, d.labels.price) },
    fill: { ...fill, on: readBool(fill.on, d.fill.on), opacity: Math.min(1, Math.max(0, readNumber(fill.opacity, d.fill.opacity))) },
    trendLine: readBool(o.trendLine, d.trendLine),
    reverse: readBool(o.reverse, d.reverse),
  };
}

const TREND_STROKE: Stroke = { color: "#868993", width: 1, dash: "dashed" };
const LABEL_GAP = 4;

const mainColor = (style: FibStyle): Color => (style.levels.find((l) => l.on) ?? style.levels[0])?.color ?? DRAW;

function trendSegments(screens: readonly (ScreenPoint | null)[]): Shape[] {
  return screens.flatMap((a, i): Shape[] => {
    const b = screens[i + 1];
    return a === null || b === undefined || b === null ? [] : [{ kind: "segment", a, b, stroke: TREND_STROKE }];
  });
}

function levelLabel(level: Level, price: number, style: FibStyle, ctx: ToolContext): string | null {
  const ratio = style.labels.ratio ? String(level.value) : null;
  const value = style.labels.price ? ctx.formatPrice(price) : null;
  if (ratio !== null && value !== null) return `${ratio} (${value})`;
  return ratio ?? value;
}

interface LabelPlace {
  x: number;
  dy: number;
  align: "left" | "right";
  baseline: "middle" | "bottom";
}

function labelPlace(extend: Extend, x1: number, x2: number): LabelPlace {
  if (extend === "none" || extend === "right") return { x: x1 - LABEL_GAP, dy: 0, align: "right", baseline: "middle" };
  if (extend === "left") return { x: x2 + LABEL_GAP, dy: 0, align: "left", baseline: "middle" };
  return { x: LABEL_GAP, dy: -2, align: "left", baseline: "bottom" };
}

function levelShapes(style: FibStyle, anchor: FibAnchor, xs: readonly number[], ctx: ToolContext): Shape[] {
  const left = style.extend === "left" || style.extend === "both";
  const right = style.extend === "right" || style.extend === "both";
  const x1 = left ? Math.min(0, ...xs) : Math.min(...xs);
  const x2 = right ? Math.max(ctx.paneWidth, ...xs) : Math.max(...xs);
  const drawn = style.levels
    .filter((level) => level.on)
    .flatMap((level) => {
      const price = levelPrice(anchor, level.value, style.reverse);
      const y = ctx.yOf(price);
      return y === null ? [] : [{ level, price, y }];
    })
    .sort((a, b) => a.level.value - b.level.value);
  const bands: Shape[] = style.fill.on
    ? drawn.slice(1).map(({ level, y }, i) => ({ kind: "hband", y1: drawn[i]!.y, y2: y, x1, x2, fill: { on: true, color: level.color, opacity: style.fill.opacity } }))
    : [];
  const lines: Shape[] = drawn.map(({ level, y }) => ({ kind: "segment", a: { x: x1, y }, b: { x: x2, y }, stroke: { color: level.color, width: style.line.width, dash: style.line.dash } }));
  const place = labelPlace(style.extend, x1, x2);
  const labels: Shape[] = drawn.flatMap(({ level, price, y }): Shape[] => {
    const text = levelLabel(level, price, style, ctx);
    if (text === null) return [];
    return [{ kind: "text", at: { x: place.x, y: y + place.dy }, text, align: place.align, baseline: place.baseline, style: { color: level.color, size: 12, bold: false, italic: false } }];
  });
  return [...bands, ...lines, ...labels];
}

export interface FibToolSpec {
  tool: "fib" | "fibext";
  label: string;
  icon: string;
  count: 2 | 3;
  pointRoles: readonly PointRole[];
  levels: readonly Level[];
  anchor(points: readonly DrawingPoint[]): FibAnchor;
}

const L = at<FibStyle>();

export function defineFibTool(spec: FibToolSpec): Tool {
  const defaults = () => fibDefaults(spec.levels);
  return defineTool<FibStyle>({
    tool: spec.tool,
    group: "fib",
    label: spec.label,
    icon: spec.icon,
    placement: { kind: "points", count: spec.count },
    pointRoles: spec.pointRoles,
    defaultStyle: defaults,
    parseStyle: (raw) => parseFibStyle(raw, defaults()),
    bar: {
      lineColor: { get: mainColor, set: (s, color) => ({ ...s, levels: s.levels.map((l) => (l.on ? { ...l, color } : l)) }) },
      width: L("line", "width"),
      dash: L("line", "dash"),
    },
    settings: {
      style: [
        { kind: "levels", label: "수준", max: MAX_LEVELS, lens: L("levels") },
        { kind: "width", label: "선 굵기", lens: L("line", "width") },
        { kind: "dash", label: "선 모양", lens: L("line", "dash") },
        select("연장", EXTEND_OPTIONS, L("extend")),
        { kind: "toggle", label: "비율 꼬리표", lens: L("labels", "ratio") },
        { kind: "toggle", label: "가격 꼬리표", lens: L("labels", "price") },
        { kind: "toggle", label: "띠 채움", lens: L("fill", "on") },
        { kind: "number", label: "띠 불투명도", min: 0, max: 1, step: 0.05, lens: L("fill", "opacity") },
        { kind: "toggle", label: "기준선", lens: L("trendLine") },
        { kind: "toggle", label: "뒤집기", lens: L("reverse") },
      ],
    },
    shapes({ points, style }, ctx) {
      const screens = points.map((p) => ctx.toScreen(p));
      if (points.length < spec.count) return trendSegments(screens);
      const trend = style.trendLine ? trendSegments(screens) : [];
      const xs = screens.flatMap((s) => (s === null ? [] : [s.x]));
      if (xs.length < screens.length) return trend;
      return [...levelShapes(style, spec.anchor(points), xs, ctx), ...trend];
    },
    handles({ points }, ctx) {
      return points.flatMap((p, i) => {
        const screen = ctx.toScreen(p);
        return screen === null ? [] : [{ at: screen, move: (pts: readonly DrawingPoint[], to: DrawingPoint) => pts.map((q, j) => (j === i ? to : q)) }];
      });
    },
    axisLabels({ points, style, selected }, ctx) {
      if (!selected) return [];
      const color = mainColor(style);
      return points.flatMap((p): AxisLabel[] => [
        { axis: "price", value: p.price, text: ctx.formatPrice(p.price), color },
        { axis: "time", value: p.t, text: ctx.formatTime(p.t), color },
      ]);
    },
  });
}
