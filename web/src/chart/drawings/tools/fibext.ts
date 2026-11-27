import type { Level } from "../toolSpec";
import { defineFibTool } from "./fibKit";

export const FIBEXT_LEVELS: readonly Level[] = [
  { value: 0, color: "$text-3", on: true },
  { value: 0.618, color: "$accent", on: true },
  { value: 1, color: "$text-3", on: true },
  { value: 1.272, color: "$down", on: true },
  { value: 1.618, color: "$ind-3", on: true },
  { value: 2.618, color: "$ind-5", on: false },
];

export const fibext = defineFibTool({
  tool: "fibext",
  label: "피보나치 확장",
  icon: "M3 4 H21 M3 10 H21 M3 16 H21 M4 21 L9 9 L14 15",
  count: 3,
  pointRoles: [
    { label: "추세 시작", uses: "both" },
    { label: "추세 끝", uses: "both" },
    { label: "되돌림", uses: "both" },
  ],
  levels: FIBEXT_LEVELS,
  anchor: ([start, end, pullback]) => ({ zero: pullback.price, one: pullback.price + end.price - start.price }),
});
