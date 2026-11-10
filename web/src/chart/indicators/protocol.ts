import type { LineId } from "../../api/generated/LineId";
import type { Period } from "../../api/generated/Period";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";

export type BarTuple = [t: UnixSeconds, o: number, h: number, l: number, c: number, v: number];

export interface Columns {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
}

export interface Point {
  t: UnixSeconds;
  v: number;
  up?: boolean;
}

export type LineDraw = { op: "set"; points: Point[] } | { op: "update"; point: Point } | { op: "none" };

export interface LineInfo {
  id: LineId;
  shift: number;
}

export type EngineErrorKind = "spec" | "calc";

export type ToWorker =
  | {
      type: "create";
      chart: number;
      gen: number;
      period: Period;
      cols: Columns;
      current: BarTuple | null;
      engines: { id: string; spec: string }[];
    }
  | { type: "bar"; chart: number; kind: "preview" | "confirm"; bar: BarTuple }
  | { type: "drop"; chart: number; ids: string[] | "all" };

export type EngineResult =
  | { id: string; gen: number; ok: true; draws: LineDraw[] }
  | { id: string; gen: number; ok: false; error: EngineErrorKind; message: string };

export type Failed = Extract<EngineResult, { ok: false }>;
export type Created = Extract<EngineResult, { ok: true }> & { lines: LineInfo[] };

export type FromWorker =
  | { type: "created"; chart: number; results: (Created | Failed)[] }
  | { type: "tail"; chart: number; results: EngineResult[] }
  | { type: "fatal"; message: string };
