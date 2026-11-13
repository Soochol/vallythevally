import type { Shape } from "../toolSpec";
import type { ScreenPoint, Stroke } from "../types";
import type { ModeSpec } from ".";

const LASER: Stroke = { color: "$draw", width: 3, dash: "solid" };
export const DEMO_HOLD_MS = 800;
export const DEMO_FADE_MS = 600;

const trail = (path: readonly ScreenPoint[]): Shape[] => path.length < 2 ? [] : [{ kind: "polyline", points: path, closed: false, stroke: LASER }];

export const demo: ModeSpec = {
  id: "demo",
  label: "시연 커서",
  icon: "M3 19 C7 11 11 17 15 9 M17 7 A2 2 0 1 0 21 7 A2 2 0 1 0 17 7",
  preview: trail,
  finish: (path) => ({ ops: [], transient: { shapes: trail(path), holdMs: DEMO_HOLD_MS, fadeMs: DEMO_FADE_MS } }),
};
