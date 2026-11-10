import type { LineId } from "../../api/generated/LineId";
import type { Period } from "../../api/generated/Period";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";

/** 메인 스레드와 지표 워커 사이의 메시지(frontend.md §5.6). */

export type BarTuple = [t: UnixSeconds, o: number, h: number, l: number, c: number, v: number];

export interface Columns {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
}

/** t는 진짜 Unix 초다. 차트 시각으로 바꾸는 것은 메인 스레드(time.ts)가 한다. */
export interface Point {
  t: UnixSeconds;
  v: number;
  /** 거래량 막대만: 그 봉이 양봉(c >= o)인가. */
  up?: boolean;
}

export type LineDraw = { op: "set"; points: Point[] } | { op: "update"; point: Point } | { op: "none" };

export interface LineInfo {
  id: LineId;
  shift: number;
}

/** "spec"은 설정값이 틀린 것, "calc"는 그 밖의 계산 실패(wasm init 실패, 워커 오류, 엔진 panic). */
export type EngineErrorKind = "spec" | "calc";

export type ToWorker =
  | {
      type: "create";
      cell: number;
      gen: number;
      period: Period;
      cols: Columns;
      current: BarTuple | null;
      engines: { id: string; spec: string }[];
    }
  | { type: "bar"; cell: number; kind: "preview" | "confirm"; bar: BarTuple }
  | { type: "drop"; cell: number; ids: string[] | "all" };

export type EngineResult =
  | { id: string; gen: number; ok: true; draws: LineDraw[] }
  | { id: string; gen: number; ok: false; error: EngineErrorKind; message: string };

export type Failed = Extract<EngineResult, { ok: false }>;
export type Created = Extract<EngineResult, { ok: true }> & { lines: LineInfo[] };

export type FromWorker =
  | { type: "created"; cell: number; results: (Created | Failed)[] }
  | { type: "tail"; cell: number; results: EngineResult[] }
  | { type: "fatal"; message: string };
