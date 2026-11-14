import { compose, defaultStroke, defaultText, prop, readRecord, readStroke, readTextStyle, strokeFields, type StyleRecord } from "../styleKit";
import { defineTool, type HandleSpec, type Lens, type Shape, type StyleField, type Tool, type ToolContext } from "../toolSpec";
import type { Color, DrawingPoint, DrawingTool, Fill, ScreenPoint, Stroke, TextStyle } from "../types";

export interface PatternStyle {
  v: 1;
  line: Stroke;
  labels: TextStyle;
}

export const patternDefaults = (): PatternStyle => ({ v: 1, line: defaultStroke(), labels: defaultText() });

export function readPatternStyle(o: StyleRecord): PatternStyle {
  const d = patternDefaults();
  return { ...o, v: 1, line: readStroke(o.line, d.line), labels: readTextStyle(o.labels, d.labels) };
}

export type Screens = readonly (ScreenPoint | null)[];

export const LABEL_GAP = 6;

export const screensOf = (points: readonly DrawingPoint[], ctx: ToolContext): Screens => points.map((p) => ctx.toScreen(p));

export function segmentsBetween(screens: Screens, pairs: readonly (readonly [number, number])[], stroke: Stroke): Shape[] {
  return pairs.flatMap(([i, j]): Shape[] => {
    const a = screens[i];
    const b = screens[j];
    return a == null || b == null ? [] : [{ kind: "segment", a, b, stroke }];
  });
}

export const chainPairs = (count: number): [number, number][] => Array.from({ length: Math.max(0, count - 1) }, (_, i) => [i, i + 1]);

export function filledAreas(screens: Screens, areas: readonly (readonly number[])[], fill: Fill): Shape[] {
  if (!fill.on) return [];
  return areas.flatMap((area): Shape[] => {
    const corners = area.map((i) => screens[i]);
    return corners.every((c): c is ScreenPoint => c != null) ? [{ kind: "polyline", points: corners, closed: true, fill }] : [];
  });
}

export function isAboveNeighbors(screens: Screens, index: number): boolean {
  const own = screens[index];
  if (own == null) return false;
  const neighbors = [screens[index - 1], screens[index + 1]].filter((s): s is ScreenPoint => s != null);
  return neighbors.length > 0 && neighbors.every((n) => own.y < n.y);
}

export function pointLabels(screens: Screens, texts: readonly (string | null)[], style: TextStyle): Shape[] {
  return screens.flatMap((at, i): Shape[] => {
    const text = texts[i];
    if (at === null || text == null) return [];
    const above = isAboveNeighbors(screens, i);
    return [{ kind: "text", at: { x: at.x, y: at.y + (above ? -LABEL_GAP : LABEL_GAP) }, text, style, align: "center", baseline: above ? "bottom" : "top" }];
  });
}

function pointHandles(points: readonly DrawingPoint[], ctx: ToolContext): HandleSpec[] {
  return points.flatMap((p, index): HandleSpec[] => {
    const at = ctx.toScreen(p);
    return at === null ? [] : [{ at, move: (pts, to) => pts.map((q, j) => (j === index ? to : q)) }];
  });
}

function lineOf<S extends PatternStyle>(): Lens<S, Stroke> {
  return { get: (s) => s.line, set: (s, line) => ({ ...s, line }) };
}

function labelsOf<S extends PatternStyle>(): Lens<S, TextStyle> {
  return { get: (s) => s.labels, set: (s, labels) => ({ ...s, labels }) };
}

export interface PatternToolSpec<S extends PatternStyle> {
  tool: DrawingTool;
  label: string;
  icon: string;
  count: 4 | 5 | 6 | 7;
  roles: readonly string[];
  defaultStyle(): S;
  parseStyle(o: StyleRecord): S;
  styleFields?: readonly StyleField<S>[];
  textFields?: readonly StyleField<S>[];
  labels(style: S): readonly (string | null)[];
  areas?(style: S, screens: Screens): Shape[];
  guides?(style: S, screens: Screens, points: readonly DrawingPoint[], ctx: ToolContext): Shape[];
}

export function definePatternTool<S extends PatternStyle>(spec: PatternToolSpec<S>): Tool {
  const line = lineOf<S>();
  const labels = labelsOf<S>();
  const textColor: Lens<S, Color> = compose(labels, prop<TextStyle, "color">("color"));
  return defineTool<S>({
    tool: spec.tool,
    group: "pattern",
    label: spec.label,
    icon: spec.icon,
    placement: { kind: "points", count: spec.count },
    pointRoles: spec.roles.map((label) => ({ label, uses: "both" })),
    defaultStyle: spec.defaultStyle,
    parseStyle: (raw) => spec.parseStyle(readRecord(raw)),
    bar: {
      lineColor: compose(line, prop<Stroke, "color">("color")),
      width: compose(line, prop<Stroke, "width">("width")),
      dash: compose(line, prop<Stroke, "dash">("dash")),
      textColor,
    },
    settings: {
      style: [...strokeFields("선", line), ...(spec.styleFields ?? [])],
      text: [...(spec.textFields ?? []), { kind: "textStyle", label: "꼬리표 글자 모양", lens: labels }],
    },
    shapes({ points, style }, ctx) {
      const screens = screensOf(points, ctx);
      return [
        ...(spec.areas?.(style, screens) ?? []),
        ...segmentsBetween(screens, chainPairs(screens.length), style.line),
        ...(spec.guides?.(style, screens, points, ctx) ?? []),
        ...pointLabels(screens, spec.labels(style), style.labels),
      ];
    },
    handles: ({ points }, ctx) => pointHandles(points, ctx),
    axisLabels: () => [],
  });
}
