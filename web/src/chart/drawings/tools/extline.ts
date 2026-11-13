import { parseRayStyle, rayDefaults, straightLine } from "./trendline";

export const extline = straightLine({
  tool: "extline",
  label: "연장선",
  icon: "M2 21 L22 3 M6.5 15.6 A1.5 1.5 0 1 0 9.5 15.6 A1.5 1.5 0 1 0 6.5 15.6 M14.5 8.4 A1.5 1.5 0 1 0 17.5 8.4 A1.5 1.5 0 1 0 14.5 8.4",
  defaultStyle: rayDefaults,
  parseStyle: parseRayStyle,
  extend: () => "both",
  extendFields: [],
});
