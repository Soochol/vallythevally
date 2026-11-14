import { at, DRAW, EXTEND_OPTIONS, EXTENDS, readBool, readNumber, readOneOf, readRecord, readString, readStroke, select } from "../styleKit";
import { type AxisLabel, defineTool, type HandleSpec, type Lens, type Level, type PointRole, type Shape, type Tool, type ToolContext } from "../toolSpec";
import type { Color, Dash, DrawingPoint, Extend, Fill, ScreenPoint, Stroke, Width } from "../types";

export const MAX_LEVELS = 24;

export interface LineLook {
  width: Width;
  dash: Dash;
}

export interface Band {
  on: boolean;
  opacity: number;
}

export interface FibStyle {
  v: 1;
  levels: readonly Level[];
  line: LineLook;
  extend: Extend;
  labels: { ratio: boolean; price: boolean };
  fill: Band;
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

export const fibDefaults = (levels: readonly Level[]): FibStyle => ({
  v: 1,
  levels: levels.map((l) => ({ ...l })),
  line: { width: 1, dash: "solid" },
  extend: "none",
  labels: { ratio: true, price: true },
  fill: { on: true, opacity: 0.12 },
  trendLine: true,
  reverse: false,
});

export function readLevels(raw: unknown, fallback: readonly Level[]): Level[] {
  if (!Array.isArray(raw)) return fallback.map((l) => ({ ...l }));
  const levels = raw.flatMap((item): Level[] => {
    const o = readRecord(item);
    if (typeof o.value !== "number" || !Number.isFinite(o.value)) return [];
    return [{ ...o, value: o.value, color: readString(o.color, DRAW), on: readBool(o.on, true) }];
  });
  return levels.slice(0, MAX_LEVELS);
}

export function readLineLook(raw: unknown, d: LineLook): LineLook {
  const line = readRecord(raw);
  const { width, dash } = readStroke(line, { color: DRAW, ...d });
  return { ...line, width, dash };
}

export function readBand(raw: unknown, d: Band): Band {
  const fill = readRecord(raw);
  return { ...fill, on: readBool(fill.on, d.on), opacity: Math.min(1, Math.max(0, readNumber(fill.opacity, d.opacity))) };
}

export function parseFibStyle(raw: unknown, d: FibStyle): FibStyle {
  const o = readRecord(raw);
  const labels = readRecord(o.labels);
  return {
    ...o,
    v: 1,
    levels: readLevels(o.levels, d.levels),
    line: readLineLook(o.line, d.line),
    extend: readOneOf(o.extend, EXTENDS, d.extend),
    labels: { ...labels, ratio: readBool(labels.ratio, d.labels.ratio), price: readBool(labels.price, d.labels.price) },
    fill: readBand(o.fill, d.fill),
    trendLine: readBool(o.trendLine, d.trendLine),
    reverse: readBool(o.reverse, d.reverse),
  };
}

const TREND_STROKE: Stroke = { color: "#868993", width: 1, dash: "dashed" };
const LABEL_GAP = 4;

export interface Leveled {
  levels: readonly Level[];
}

export const mainColor = (style: Leveled): Color => (style.levels.find((l) => l.on) ?? style.levels[0])?.color ?? DRAW;

export function recolor<S extends Leveled>(style: S, color: Color): S {
  const anyOn = style.levels.some((l) => l.on);
  return { ...style, levels: style.levels.map((l) => (l.on || !anyOn ? { ...l, color } : l)) };
}

export const levelColor = <S extends Leveled>(): Lens<S, Color> => ({ get: mainColor, set: recolor });

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
    ? drawn.flatMap(({ y }, i): Shape[] => {
        const upper = drawn[i + 1];
        return upper === undefined ? [] : [{ kind: "hband", y1: y, y2: upper.y, x1, x2, fill: { on: true, color: upper.level.color, opacity: style.fill.opacity } }];
      })
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

type FibPlacement =
  | { count: 2; anchor(points: readonly [DrawingPoint, DrawingPoint]): FibAnchor }
  | { count: 3; anchor(points: readonly [DrawingPoint, DrawingPoint, DrawingPoint]): FibAnchor };

export type FibToolSpec = FibPlacement & {
  tool: "fib" | "fibext";
  label: string;
  icon: string;
  pointRoles: readonly PointRole[];
  levels: readonly Level[];
};

function anchorOf(spec: FibPlacement, points: readonly DrawingPoint[]): FibAnchor | null {
  const [a, b, c] = points;
  if (a === undefined || b === undefined) return null;
  if (spec.count === 2) return spec.anchor([a, b]);
  return c === undefined ? null : spec.anchor([a, b, c]);
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
      lineColor: { get: mainColor, set: recolor },
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
      const anchor = anchorOf(spec, points);
      if (anchor === null) return trendSegments(screens);
      const trend = style.trendLine ? trendSegments(screens) : [];
      const xs = screens.flatMap((s) => (s === null ? [] : [s.x]));
      if (xs.length < screens.length && style.extend !== "both") return trend;
      return [...levelShapes(style, anchor, xs, ctx), ...trend];
    },
    handles({ points }, ctx) {
      return pointHandles(points, ctx);
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

export function pointHandles(points: readonly DrawingPoint[], ctx: ToolContext): HandleSpec[] {
  return points.flatMap((p, i) => {
    const screen = ctx.toScreen(p);
    return screen === null ? [] : [{ at: screen, move: (pts: readonly DrawingPoint[], to: DrawingPoint) => pts.map((q, j) => (j === i ? to : q)) }];
  });
}

export type FanSide = "left" | "right";

export function fanSide(origin: ScreenPoint, toward: ScreenPoint): FanSide | null {
  if (origin.x === toward.x) return null;
  return origin.x < toward.x ? "right" : "left";
}

export const fanRay = (origin: ScreenPoint, through: ScreenPoint, side: FanSide, stroke: Stroke): Shape => ({ kind: "segment", a: origin, b: through, stroke, extend: side });

function rayAtX(origin: ScreenPoint, through: ScreenPoint, x: number): ScreenPoint {
  return { x, y: origin.y + ((through.y - origin.y) * (x - origin.x)) / (through.x - origin.x) };
}

export function fanWedge(origin: ScreenPoint, p: ScreenPoint, q: ScreenPoint, side: FanSide, fill: Fill, ctx: ToolContext): Shape {
  const x = side === "right" ? Math.max(ctx.paneWidth, origin.x) + 1 : Math.min(0, origin.x) - 1;
  return { kind: "polyline", points: [origin, rayAtX(origin, p, x), rayAtX(origin, q, x)], closed: true, fill };
}
