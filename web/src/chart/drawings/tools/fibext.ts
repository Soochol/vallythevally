import { defineFibTool } from "./fibKit";

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
  levels: [
    { value: 0, color: "#787b86", on: true },
    { value: 0.618, color: "#089981", on: true },
    { value: 1, color: "#787b86", on: true },
    { value: 1.272, color: "#3f51b5", on: true },
    { value: 1.618, color: "#2962ff", on: true },
    { value: 2.618, color: "#e91e63", on: false },
  ],
  anchor: ([start, end, pullback]) => ({ zero: pullback!.price, one: pullback!.price + end!.price - start!.price }),
});
