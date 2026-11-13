import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type {
  Color,
  Dash,
  DrawingPoint,
  DrawingTool,
  Extend,
  Fill,
  LineEnd,
  ScreenPoint,
  Stroke,
  TextStyle,
  Width,
} from "./types";

export type Placement =
  | {
      kind: "points";
      count: 1 | 2 | 3;
      shift?: "angle45" | "square";
      oneClick?: (at: DrawingPoint, ctx: ToolContext) => DrawingPoint[];
    }
  | { kind: "polyline"; min: 2; max: 100 }
  | { kind: "freehand"; min: 2; max: 1000 };

export type Shape =
  | { kind: "segment"; a: ScreenPoint; b: ScreenPoint; stroke: Stroke; extend?: Extend; ends?: { left: LineEnd; right: LineEnd } }
  | { kind: "polyline"; points: readonly ScreenPoint[]; closed: boolean; stroke?: Stroke; fill?: Fill }
  | { kind: "rect"; a: ScreenPoint; b: ScreenPoint; stroke?: Stroke; fill?: Fill; extend?: Extend }
  | { kind: "ellipse"; a: ScreenPoint; b: ScreenPoint; stroke?: Stroke; fill?: Fill }
  | { kind: "circle"; c: ScreenPoint; r: number; stroke?: Stroke; fill?: Fill }
  | {
      kind: "text";
      at: ScreenPoint;
      text: string;
      style: TextStyle;
      align: "left" | "center" | "right";
      baseline: "top" | "middle" | "bottom";
      orientation?: "horizontal" | "vertical";
      box?: { background?: Fill; border?: Stroke; padding: number; wrapWidth: number | null };
    }
  | { kind: "hband"; y1: number; y2: number; x1: number; x2: number; fill: Fill }
  | { kind: "vline"; x: number; stroke: Stroke; allPanes: boolean };

export type ShapeKind = Shape["kind"];

export interface AxisLabel {
  axis: "price" | "time";
  value: number;
  text: string;
  color: Color;
}

export interface ToolContext {
  toScreen(p: DrawingPoint): ScreenPoint | null;
  fromScreen(s: ScreenPoint): DrawingPoint | null;
  xOf(t: UnixSeconds): number | null;
  yOf(price: number): number | null;
  timeAt(x: number): UnixSeconds | null;
  priceAt(y: number): number | null;
  shiftBars(t: UnixSeconds, n: number): UnixSeconds | null;
  barsBetween(t1: UnixSeconds, t2: UnixSeconds): { count: number; volume: number } | null;
  paneWidth: number;
  paneHeight: number;
  formatPrice(p: number): string;
  formatTime(t: UnixSeconds): string;
  logScale: boolean;
}

export interface HandleSpec {
  at: ScreenPoint;
  move(points: readonly DrawingPoint[], to: DrawingPoint, ctx: ToolContext): DrawingPoint[];
  constrain?: { rule: "angle45" | "square"; pivot: ScreenPoint };
}

export interface Lens<S, V> {
  get(s: S): V;
  set(s: S, v: V): S;
}

export interface Level {
  value: number;
  color: Color;
  on: boolean;
}

export type StyleField<S> =
  | { kind: "color"; label: string; lens: Lens<S, Color> }
  | { kind: "stroke"; label: string; lens: Lens<S, Stroke> }
  | { kind: "fill"; label: string; lens: Lens<S, Fill> }
  | { kind: "width"; label: string; lens: Lens<S, Width> }
  | { kind: "dash"; label: string; lens: Lens<S, Dash> }
  | { kind: "toggle"; label: string; lens: Lens<S, boolean> }
  | { kind: "select"; label: string; options: readonly { value: string; label: string }[]; lens: Lens<S, string> }
  | { kind: "number"; label: string; min: number; max: number; step: number; unit?: string; lens: Lens<S, number> }
  | { kind: "textStyle"; label: string; lens: Lens<S, TextStyle> }
  | { kind: "text"; label: string; multiline: boolean }
  | { kind: "levels"; label: string; max: 24; lens: Lens<S, readonly Level[]> };

export type StyleFieldKind = StyleField<unknown>["kind"];

export interface BarFields<S> {
  lineColor?: Lens<S, Color>;
  fill?: Lens<S, Fill>;
  textColor?: Lens<S, Color>;
  width?: Lens<S, Width>;
  dash?: Lens<S, Dash>;
}

export interface SettingsTabs<S> {
  inputs?: readonly StyleField<S>[];
  style?: readonly StyleField<S>[];
  text?: readonly StyleField<S>[];
}

export interface PointRole {
  label: string;
  uses: "both" | "price" | "time";
}

export interface ToolDrawing<S> {
  points: readonly DrawingPoint[];
  style: S;
  text: string | null;
  selected: boolean;
}

export interface ToolSpec<S> {
  tool: DrawingTool;
  group: "line" | "fib" | "shape" | "note" | "measure";
  label: string;
  icon: string;
  placement: Placement;
  pointRoles?: readonly PointRole[];
  text?: { editOnPlace: boolean };
  defaultStyle(): S;
  parseStyle(raw: unknown): S;
  bar: BarFields<S>;
  settings: SettingsTabs<S>;
  finalize?(placed: readonly DrawingPoint[], ctx: ToolContext): DrawingPoint[];
  setPoint?(points: readonly DrawingPoint[], index: number, to: DrawingPoint, ctx: ToolContext): DrawingPoint[];
  shapes(d: ToolDrawing<S>, ctx: ToolContext): Shape[];
  handles(d: ToolDrawing<S>, ctx: ToolContext): HandleSpec[];
  axisLabels(d: ToolDrawing<S>, ctx: ToolContext): AxisLabel[];
  eraseAlong?(points: readonly DrawingPoint[], eraser: readonly ScreenPoint[], radius: number, ctx: ToolContext): DrawingPoint[][];
}

export type Tool = ToolSpec<unknown>;

function eraseLens<S, V>(lens: Lens<S, V>, parse: (raw: unknown) => S): Lens<unknown, V> {
  return { get: (raw) => lens.get(parse(raw)), set: (raw, v) => lens.set(parse(raw), v) };
}

function eraseField<S>(f: StyleField<S>, parse: (raw: unknown) => S): StyleField<unknown> {
  switch (f.kind) {
    case "color":
      return { ...f, lens: eraseLens(f.lens, parse) };
    case "stroke":
      return { ...f, lens: eraseLens(f.lens, parse) };
    case "fill":
      return { ...f, lens: eraseLens(f.lens, parse) };
    case "width":
      return { ...f, lens: eraseLens(f.lens, parse) };
    case "dash":
      return { ...f, lens: eraseLens(f.lens, parse) };
    case "toggle":
      return { ...f, lens: eraseLens(f.lens, parse) };
    case "select":
      return { ...f, lens: eraseLens(f.lens, parse) };
    case "number":
      return { ...f, lens: eraseLens(f.lens, parse) };
    case "textStyle":
      return { ...f, lens: eraseLens(f.lens, parse) };
    case "levels":
      return { ...f, lens: eraseLens(f.lens, parse) };
    case "text":
      return f;
  }
}

export function defineTool<S>(spec: ToolSpec<S>): Tool {
  const parse = (raw: unknown) => spec.parseStyle(raw);
  const typed = (d: ToolDrawing<unknown>): ToolDrawing<S> => ({ ...d, style: parse(d.style) });
  const fields = (list: readonly StyleField<S>[] | undefined) => list?.map((f) => eraseField(f, parse));
  const maybe = <V>(lens: Lens<S, V> | undefined) => (lens === undefined ? undefined : eraseLens(lens, parse));
  const { bar, settings } = spec;
  return {
    ...spec,
    defaultStyle: () => spec.defaultStyle(),
    parseStyle: parse,
    bar: {
      lineColor: maybe(bar.lineColor),
      fill: maybe(bar.fill),
      textColor: maybe(bar.textColor),
      width: maybe(bar.width),
      dash: maybe(bar.dash),
    },
    settings: { inputs: fields(settings.inputs), style: fields(settings.style), text: fields(settings.text) },
    shapes: (d, ctx) => spec.shapes(typed(d), ctx),
    handles: (d, ctx) => spec.handles(typed(d), ctx),
    axisLabels: (d, ctx) => spec.axisLabels(typed(d), ctx),
  };
}
