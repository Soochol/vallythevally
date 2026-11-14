import { DRAW, readFill, type StyleRecord } from "../styleKit";
import type { Lens, Shape } from "../toolSpec";
import type { Fill } from "../types";
import { definePatternTool, filledAreas, patternDefaults, type PatternStyle, readPatternStyle, type Screens } from "./patternKit";

export type HeadShouldersStyle = PatternStyle & { fill: Fill };

export const headShouldersDefaults = (): HeadShouldersStyle => ({ ...patternDefaults(), fill: { on: true, color: DRAW, opacity: 0.1 } });

const NECK = [2, 4] as const;

function neckline(style: HeadShouldersStyle, screens: Screens): Shape[] {
  const a = screens[NECK[0]];
  const b = screens[NECK[1]];
  return a == null || b == null ? [] : [{ kind: "segment", a, b, stroke: style.line, extend: "both" }];
}

const fill: Lens<HeadShouldersStyle, Fill> = { get: (s) => s.fill, set: (s, v) => ({ ...s, fill: v }) };

export const headshoulders = definePatternTool<HeadShouldersStyle>({
  tool: "headshoulders",
  label: "헤드앤숄더",
  icon: "M2 19 L5 11 L8 15 L12 4 L16 15 L19 11 L22 19 M2 15 L22 15",
  count: 7,
  roles: ["시작", "왼쪽 어깨", "목선 1", "머리", "목선 2", "오른쪽 어깨", "끝"],
  defaultStyle: headShouldersDefaults,
  parseStyle: (o: StyleRecord) => ({ ...readPatternStyle(o), fill: readFill(o.fill, headShouldersDefaults().fill) }),
  styleFields: [{ kind: "fill", label: "봉우리 채움", lens: fill }],
  labels: () => [null, "왼쪽 어깨", null, "머리", null, "오른쪽 어깨", null],
  areas: (style, screens) => filledAreas(screens, [[0, 1, 2], [2, 3, 4], [4, 5, 6]], style.fill),
  guides: neckline,
});
