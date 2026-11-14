import { DRAW, readFill, type StyleRecord } from "../styleKit";
import type { Lens, Shape } from "../toolSpec";
import type { DrawingPoint, Fill, Stroke } from "../types";
import { definePatternTool, filledAreas, patternDefaults, type PatternStyle, readPatternStyle, type Screens } from "./patternKit";

export type XabcdStyle = PatternStyle & { fill: Fill };

const MARKS = ["X", "A", "B", "C", "D"] as const;

export const xabcdDefaults = (): XabcdStyle => ({ ...patternDefaults(), fill: { on: true, color: DRAW, opacity: 0.1 } });

interface Retracement {
  from: number;
  to: number;
  move: readonly [number, number];
  base: readonly [number, number];
}

const RETRACEMENTS: readonly Retracement[] = [
  { from: 0, to: 2, move: [1, 2], base: [0, 1] },
  { from: 1, to: 3, move: [2, 3], base: [1, 2] },
  { from: 2, to: 4, move: [3, 4], base: [2, 3] },
  { from: 0, to: 4, move: [1, 4], base: [0, 1] },
];

const span = (points: readonly DrawingPoint[], [i, j]: readonly [number, number]): number | null => {
  const a = points[i];
  const b = points[j];
  return a === undefined || b === undefined ? null : Math.abs(b.price - a.price);
};

export function retracementRatio(points: readonly DrawingPoint[], r: Retracement): number | null {
  const move = span(points, r.move);
  const base = span(points, r.base);
  return move === null || base === null || base === 0 ? null : move / base;
}

const guideStroke = (line: Stroke): Stroke => ({ ...line, width: 1, dash: "dashed" });

function retracementShapes(style: XabcdStyle, screens: Screens, points: readonly DrawingPoint[]): Shape[] {
  return RETRACEMENTS.flatMap((r): Shape[] => {
    const a = screens[r.from];
    const b = screens[r.to];
    if (a == null || b == null) return [];
    const guide: Shape = { kind: "segment", a, b, stroke: guideStroke(style.line) };
    const ratio = retracementRatio(points, r);
    if (ratio === null) return [guide];
    const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return [guide, { kind: "text", at: middle, text: ratio.toFixed(3), style: style.labels, align: "center", baseline: "middle", box: { background: { on: true, color: style.line.color, opacity: 0.15 }, padding: 2, wrapWidth: null } }];
  });
}

const fill: Lens<XabcdStyle, Fill> = { get: (s) => s.fill, set: (s, v) => ({ ...s, fill: v }) };

export const xabcd = definePatternTool<XabcdStyle>({
  tool: "xabcd",
  label: "XABCD 패턴",
  icon: "M2 18 L7 5 L11 14 L16 8 L22 20",
  count: 5,
  roles: MARKS.map((mark) => `점 ${mark}`),
  defaultStyle: xabcdDefaults,
  parseStyle: (o: StyleRecord) => ({ ...readPatternStyle(o), fill: readFill(o.fill, xabcdDefaults().fill) }),
  styleFields: [{ kind: "fill", label: "삼각형 채움", lens: fill }],
  labels: () => MARKS,
  areas: (style, screens) => filledAreas(screens, [[0, 1, 2], [2, 3, 4]], style.fill),
  guides: retracementShapes,
});
