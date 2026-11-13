import type { Level } from "../toolSpec";
import { defineFibTool } from "./fibKit";

export const FIB_LEVELS: readonly Level[] = [
  { value: 0, color: "#787b86", on: true },
  { value: 0.236, color: "#f23645", on: true },
  { value: 0.382, color: "#ff9800", on: true },
  { value: 0.5, color: "#4caf50", on: true },
  { value: 0.618, color: "#089981", on: true },
  { value: 0.786, color: "#00bcd4", on: true },
  { value: 1, color: "#787b86", on: true },
  { value: 1.272, color: "#3f51b5", on: false },
  { value: 1.618, color: "#2962ff", on: false },
  { value: 2.618, color: "#e91e63", on: false },
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
