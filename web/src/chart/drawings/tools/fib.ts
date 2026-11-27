import type { Level } from "../toolSpec";
import { defineFibTool } from "./fibKit";

export const FIB_LEVELS: readonly Level[] = [
  { value: 0, color: "$text-3", on: true },
  { value: 0.236, color: "$up", on: true },
  { value: 0.382, color: "$ind-1", on: true },
  { value: 0.5, color: "$ind-4", on: true },
  { value: 0.618, color: "$accent", on: true },
  { value: 0.786, color: "$ind-2", on: true },
  { value: 1, color: "$text-3", on: true },
  { value: 1.272, color: "$down", on: false },
  { value: 1.618, color: "$ind-3", on: false },
  { value: 2.618, color: "$ind-5", on: false },
];

export const fib = defineFibTool({
  tool: "fib",
  label: "피보나치 되돌림",
  icon: "M3 4 H21 M3 9 H21 M3 14 H21 M3 20 H21 M5 20 L19 4",
  count: 2,
  pointRoles: [
    { label: "시작", uses: "both" },
    { label: "끝", uses: "both" },
  ],
  levels: FIB_LEVELS,
  anchor: ([start, end]) => ({ zero: end.price, one: start.price }),
});
