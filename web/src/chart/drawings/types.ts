import type { Drawing } from "../../api/generated/Drawing";
import type { DrawingInput } from "../../api/generated/DrawingInput";
import type { DrawingPoint } from "../../api/generated/DrawingPoint";
import type { DrawingScope } from "../../api/generated/DrawingScope";
import type { DrawingTool } from "../../api/generated/DrawingTool";

export type { Drawing, DrawingInput, DrawingPoint, DrawingScope, DrawingTool };

export type DrawingBody = DrawingInput;
export type DrawingId = DrawingBody["id"];

export type DrawingOp =
  | { kind: "create"; after: DrawingBody }
  | { kind: "update"; before: DrawingBody; after: DrawingBody }
  | { kind: "delete"; before: DrawingBody };

export function opId(op: DrawingOp): DrawingId {
  switch (op.kind) {
    case "create":
      return op.after.id;
    case "update":
    case "delete":
      return op.before.id;
  }
}

type ExactPoints = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type PointCount = { kind: "exact"; n: ExactPoints } | { kind: "range"; min: 2; max: number };

const exact = (n: ExactPoints): PointCount => ({ kind: "exact", n });

export const TOOL_POINTS: Record<DrawingTool, PointCount> = {
  trendline: exact(2),
  ray: exact(2),
  extline: exact(2),
  hline: exact(1),
  hray: exact(1),
  vline: exact(1),
  channel: exact(3),
  fib: exact(2),
  fibext: exact(3),
  rect: exact(2),
  ellipse: exact(2),
  arrow: exact(2),
  path: { kind: "range", min: 2, max: 100 },
  brush: { kind: "range", min: 2, max: 1000 },
  text: exact(1),
  callout: exact(2),
  pricelabel: exact(1),
  pricerange: exact(2),
  daterange: exact(2),
  long: exact(3),
  short: exact(3),
  crossline: exact(1),
  regression: exact(2),
  pitchfork: exact(3),
  fibfan: exact(2),
  fibtime: exact(2),
  gannfan: exact(2),
  gannbox: exact(2),
  triangle: exact(3),
  datepricerange: exact(2),
  avwap: exact(1),
  volprofile: exact(2),
  elliott: exact(6),
  elliottabc: exact(4),
  xabcd: exact(5),
  headshoulders: exact(7),
};

export const isDrawingTool = (x: string): x is DrawingTool => Object.hasOwn(TOOL_POINTS, x);

export interface ScreenPoint {
  x: number;
  y: number;
}

export type Color = string;
export type Dash = "solid" | "dashed" | "dotted";
export type Width = 1 | 2 | 3 | 4 | 5;

export interface Stroke {
  color: Color;
  width: Width;
  dash: Dash;
}

export interface Fill {
  on: boolean;
  color: Color;
  opacity: number;
}

export interface TextStyle {
  color: Color;
  size: number;
  bold: boolean;
  italic: boolean;
}

export type Extend = "none" | "left" | "right" | "both";
export type LineEnd = "plain" | "arrow";
export type ShiftRule = "angle45" | "square" | "axis";
