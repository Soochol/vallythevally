import { parseRayStyle, rayDefaults, straightLine } from "./trendline";

export const ray = straightLine({
  tool: "ray",
  label: "반직선",
  icon: "M4 19 L21 6 M4 17.5 A1.5 1.5 0 1 0 4 20.5 A1.5 1.5 0 1 0 4 17.5",
  defaultStyle: rayDefaults,
  parseStyle: parseRayStyle,
  extend: (_, a, b) => (a.x <= b.x ? "right" : "left"),
  extendFields: [],
});
