import type { Period } from "../../api/generated/Period";
import type { BarTuple, Columns, Created, EngineErrorKind, EngineResult, Failed, FromWorker, LineDraw, LineInfo, Point, ToWorker } from "./protocol";

export interface Engine {
  lines(): string[];
  shift(index: number): number;
  line(index: number): Float64Array;
  preview(...bar: BarTuple): Float64Array;
  pushConfirmed(...bar: BarTuple): Float64Array;
  free(): void;
}

export interface Wasm {
  specErrors(specJson: string): string[] | null;
  newEngine(specJson: string, cols: Columns): Engine;
  futureBarStarts(period: Period, lastStart: number, n: number): Float64Array;
}

interface Held {
  gen: number;
  engine: Engine;
  lines: LineInfo[];
  ahead: number;
  volumeLine: number;
  times: number[];
  up: boolean[];
  future: number[];
  current: { t: number; values: number[] } | null;
}

class EngineFailure extends Error {
  constructor(
    readonly kind: EngineErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Engines {
  private readonly charts = new Map<number, { period: Period; held: Map<string, Held> }>();

  constructor(private readonly wasm: Wasm) {}

  handle(msg: ToWorker): FromWorker | null {
    switch (msg.type) {
      case "create":
        return { type: "created", chart: msg.chart, results: this.create(msg) };
      case "bar":
        return { type: "tail", chart: msg.chart, results: this.bar(msg.chart, msg.kind, msg.bar) };
      case "drop":
        this.drop(msg.chart, msg.ids);
        return null;
    }
  }

  private create(msg: Extract<ToWorker, { type: "create" }>): (Created | Failed)[] {
    const chart = this.charts.get(msg.chart) ?? { period: msg.period, held: new Map() };
    chart.period = msg.period;
    this.charts.set(msg.chart, chart);
    return msg.engines.map(({ id, spec }): Created | Failed => {
      this.free(chart.held, id);
      try {
        const held = this.build(msg, spec);
        chart.held.set(id, held);
        return { id, gen: msg.gen, ok: true, lines: held.lines, draws: held.lines.map((_, li): LineDraw => ({ op: "set", points: this.allPoints(held, li) })) };
      } catch (e) {
        const kind = e instanceof EngineFailure ? e.kind : "calc";
        return { id, gen: msg.gen, ok: false, error: kind, message: messageOf(e) };
      }
    });
  }

  private build(msg: Extract<ToWorker, { type: "create" }>, spec: string): Held {
    const errors = this.wasm.specErrors(spec);
    if (errors) throw new EngineFailure("spec", errors.join(" "));
    const engine = this.wasm.newEngine(spec, msg.cols);
    try {
      const lines = engine.lines().map((id, i) => ({ id, shift: engine.shift(i) }) as LineInfo);
      const ahead = Math.max(0, ...lines.map((l) => l.shift));
      const times = Array.from(msg.cols.t);
      const up = Array.from(msg.cols.c, (c, i) => c >= msg.cols.o[i]!);
      let current: Held["current"] = null;
      if (msg.current) {
        current = { t: msg.current[0], values: Array.from(engine.preview(...msg.current)) };
        times.push(msg.current[0]);
        up.push(msg.current[4] >= msg.current[1]);
      }
      const last = times[times.length - 1];
      const future = ahead > 0 && last !== undefined ? Array.from(this.wasm.futureBarStarts(msg.period, last, ahead)) : [];
      return { gen: msg.gen, engine, lines, ahead, volumeLine: lines.findIndex((l) => l.id === "volume"), times, up, future, current };
    } catch (e) {
      safeFree(engine);
      throw e;
    }
  }

  private bar(chartId: number, kind: "preview" | "confirm", bar: BarTuple): EngineResult[] {
    const chart = this.charts.get(chartId);
    if (!chart) return [];
    return [...chart.held].map(([id, held]): EngineResult => {
      try {
        return { id, gen: held.gen, ok: true, draws: this.step(chart.period, held, kind, bar) };
      } catch (e) {
        this.free(chart.held, id);
        return { id, gen: held.gen, ok: false, error: "calc", message: messageOf(e) };
      }
    });
  }

  private step(period: Period, held: Held, kind: "preview" | "confirm", bar: BarTuple): LineDraw[] {
    const t = bar[0];
    const last = held.times[held.times.length - 1];
    const sameBar = held.current?.t === t;
    if (!sameBar && (held.current !== null || (last !== undefined && t <= last))) {
      throw new Error(`이어지지 않는 봉입니다: ${t}`);
    }
    const values = Array.from(kind === "preview" ? held.engine.preview(...bar) : held.engine.pushConfirmed(...bar));
    held.current = kind === "preview" ? { t, values } : null;
    let regrid = false;
    if (!sameBar) {
      held.times.push(t);
      if (held.ahead > 0) {
        regrid = held.future[0] !== t;
        held.future = Array.from(this.wasm.futureBarStarts(period, t, held.ahead));
      }
    }
    const index = held.times.length - 1;
    held.up[index] = bar[4] >= bar[1];
    return held.lines.map((line, li): LineDraw => {
      if (regrid && line.shift > 0) return { op: "set", points: this.allPoints(held, li) };
      const point = this.pointAt(held, li, index, values[li]!);
      return point ? { op: "update", point } : { op: "none" };
    });
  }

  private allPoints(held: Held, li: number): Point[] {
    const values = Array.from(held.engine.line(li));
    if (held.current) values.push(held.current.values[li]!);
    const points: Point[] = [];
    values.forEach((v, i) => {
      const p = this.pointAt(held, li, i, v);
      if (p) points.push(p);
    });
    return points;
  }

  private pointAt(held: Held, li: number, index: number, v: number): Point | null {
    const k = index + held.lines[li]!.shift;
    const t = k < 0 ? undefined : k < held.times.length ? held.times[k] : held.future[k - held.times.length];
    if (t === undefined || Number.isNaN(v)) return null;
    return li === held.volumeLine ? { t, v, up: held.up[index]! } : { t, v };
  }

  private drop(chartId: number, ids: string[] | "all"): void {
    const chart = this.charts.get(chartId);
    if (!chart) return;
    for (const id of ids === "all" ? [...chart.held.keys()] : ids) this.free(chart.held, id);
    if (chart.held.size === 0) this.charts.delete(chartId);
  }

  private free(held: Map<string, Held>, id: string): void {
    const h = held.get(id);
    if (!h) return;
    held.delete(id);
    safeFree(h.engine);
  }
}

/** panic 뒤의 엔진은 free도 던질 수 있다. 그 엔진은 이미 버렸으므로 무시한다. */
function safeFree(engine: Engine): void {
  try {
    engine.free();
  } catch {}
}
