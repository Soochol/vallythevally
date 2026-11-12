import { readFile } from "node:fs/promises";
import { beforeAll, expect, test } from "vitest";
import type { IndicatorSpec } from "../../api/generated/IndicatorSpec";
import type { Period } from "../../api/generated/Period";
import init, * as wasm from "../../wasm/indicators/indicators.js";
import { type Engine, Engines, type Wasm } from "./engines";
import type { BarTuple, Columns, Created, EngineResult, FromWorker, LineDraw, Point } from "./protocol";
import { isFinancial, KIND_ORDER, KINDS, specLines } from "./kinds";
import { wasmAdapter } from "./wasm";

let real: Wasm;

const panic = () => Object.assign(new Error("unreachable"), { name: "RuntimeError" });
let bars: BarTuple[];

const kst = (iso: string) => Date.parse(`${iso}+09:00`) / 1000;

function weekdays(from: string, n: number): number[] {
  const out: number[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(kst(d.toISOString().slice(0, 10) + "T00:00:00"));
  }
  return out;
}

beforeAll(async () => {
  await init({ module_or_path: await readFile(new URL("../../wasm/indicators/indicators_bg.wasm", import.meta.url)) });
  real = wasmAdapter(wasm);
  const csv = await readFile(new URL("../../../../crates/indicators/tests/reference/input.csv", import.meta.url), "utf8");
  const [, ...rows] = csv.trim().split("\n").filter((l) => !l.startsWith("#"));
  const times = weekdays("2025-01-06", rows.length);
  bars = rows.map((r, i) => [times[i]!, ...r.split(",").map(Number)] as BarTuple);
});

function columns(bs: BarTuple[]): Columns {
  const col = (k: number) => Float64Array.from(bs, (b) => b[k]!);
  return { t: col(0), o: col(1), h: col(2), l: col(3), c: col(4), v: col(5) };
}

const ICHIMOKU: IndicatorSpec = { kind: "ichimoku", conversion: 9, base: 26, spanB: 52, displacement: 26 };
const VOLUME: IndicatorSpec = { kind: "volume", maPeriod: 20 };

function create(engines: Engines, specs: IndicatorSpec[], confirmed: BarTuple[], current: BarTuple | null, period: Period = "D", gen = 1) {
  const out = engines.handle({
    type: "create", chart: 1, gen, period, cols: columns(confirmed), current,
    engines: specs.map((s, i) => ({ id: `e${i}`, spec: JSON.stringify(s) })),
  });
  if (out?.type !== "created") throw new Error("created가 아님");
  return out.results;
}

const bar = (engines: Engines, kind: "preview" | "confirm", b: BarTuple) => {
  const out = engines.handle({ type: "bar", chart: 1, kind, bar: b }) as Extract<FromWorker, { type: "tail" }>;
  return out.results;
};

/** Lightweight Charts의 `setData`·`update` 규칙을 따라 그리는 가짜 시리즈. 마지막 점보다 이른 update는 실패다. */
function applyDraw(series: Point[], d: LineDraw): Point[] {
  if (d.op === "none") return series;
  if (d.op === "set") return d.points;
  const last = series[series.length - 1];
  if (last && d.point.t < last.t) throw new Error(`마지막 점보다 이른 update: ${d.point.t} < ${last.t}`);
  return last?.t === d.point.t ? [...series.slice(0, -1), d.point] : [...series, d.point];
}

const okDraws = (r: EngineResult | Created) => {
  if (!r.ok) throw new Error(r.message);
  return r.draws;
};

test("일목균형표: 선행스팬은 마지막 봉 뒤 미래 시각에, 후행스팬은 25봉 앞 과거 시각에 놓인다", () => {
  const confirmed = bars.slice(0, 100);
  const current = bars[100]!;
  const [r] = create(new Engines(real), [ICHIMOKU], confirmed, current);
  if (!r?.ok) throw new Error("만들지 못함");
  expect(r.lines.map((l) => [l.id, l.shift])).toEqual([["conversion", 0], ["base", 0], ["spanA", 25], ["spanB", 25], ["lagging", -25]]);
  const last = (li: number) => (r.draws[li] as Extract<LineDraw, { op: "set" }>).points.at(-1)!.t;
  const future = Array.from(wasm.futureBarStarts("D", current[0], 25));
  expect(last(0)).toBe(current[0]);
  expect(last(2)).toBe(future[24]);
  expect(last(2)).toBeGreaterThan(current[0]);
  expect(last(4)).toBe(bars[100 - 25]![0]);
});

test("체결을 흘려도 모든 선의 update는 그 선의 마지막 점만 바꾸고, 결과는 처음부터 다시 만든 것과 같다", () => {
  const engines = new Engines(real);
  const start = 80;
  const results = create(engines, [ICHIMOKU, VOLUME, { kind: "macd", fast: 12, slow: 26, signal: 9 }], bars.slice(0, start), null);
  let series = results.map((r) => okDraws(r).map((d) => applyDraw([], d)));
  const feed = (rs: EngineResult[]) => {
    expect(rs).toHaveLength(3);
    series = rs.map((r, i) => okDraws(r).map((d, li) => applyDraw(series[i]![li]!, d)));
    rs.forEach((r) => okDraws(r).forEach((d) => expect(d.op).not.toBe("set")));
  };
  for (let i = start; i < start + 30; i++) {
    const b = bars[i]!;
    const ticks: BarTuple[] = [[b[0], b[1], b[1], b[1], b[1], 1], [b[0], b[1], b[2], b[3], b[4] - 1, b[5] - 1], b];
    for (const tick of ticks) feed(bar(engines, "preview", tick));
    feed(bar(engines, "confirm", b));
  }
  const next = bars[start + 30]!;
  feed(bar(engines, "preview", next));

  const fresh = create(new Engines(real), [ICHIMOKU, VOLUME, { kind: "macd", fast: 12, slow: 26, signal: 9 }], bars.slice(0, start + 30), next);
  expect(series).toEqual(fresh.map((r) => okDraws(r).map((d) => applyDraw([], d))));
});

test("새 봉이 예상한 미래 칸과 다르면(체결 없던 분) 선행스팬만 다시 놓는다", () => {
  const engines = new Engines(real);
  const minutes = Array.from({ length: 80 }, (_, i) => kst("2026-11-09T09:00:00") + i * 60);
  const minuteBars = bars.slice(0, 80).map((b, i) => [minutes[i]!, ...b.slice(1)] as BarTuple);
  create(engines, [ICHIMOKU], minuteBars, null, "1m");
  const skipped: BarTuple = [minutes[79]! + 120, ...bars[80]!.slice(1)] as BarTuple;
  const [r] = bar(engines, "preview", skipped);
  expect(okDraws(r!).map((d) => d.op)).toEqual(["update", "update", "set", "set", "update"]);
  const fresh = create(new Engines(real), [ICHIMOKU], minuteBars, skipped, "1m");
  expect((okDraws(r!)[2] as Extract<LineDraw, { op: "set" }>).points).toEqual((okDraws(fresh[0]!)[2] as Extract<LineDraw, { op: "set" }>).points);
});

test("거래량 막대 점은 그 봉의 등락을 싣는다", () => {
  const [r] = create(new Engines(real), [{ kind: "volume", maPeriod: null }], bars.slice(0, 3), null);
  const pts = (okDraws(r!)[0] as Extract<LineDraw, { op: "set" }>).points;
  expect(pts.map((p) => p.up)).toEqual(bars.slice(0, 3).map((b) => b[4] >= b[1]));
  expect(pts.map((p) => p.v)).toEqual(bars.slice(0, 3).map((b) => b[5]));
});

test("설정값이 틀리면 spec 오류, 이어지지 않는 봉은 그 엔진만 calc 오류로 버린다", () => {
  const engines = new Engines(real);
  const rs = create(engines, [{ kind: "ma", method: "sma", period: 0 }, { kind: "ma", method: "sma", period: 5 }], bars.slice(0, 10), null);
  expect(rs.map((r) => (r.ok ? "ok" : r.error))).toEqual(["spec", "ok"]);
  expect(bar(engines, "confirm", bars[10]!).map((r) => r.ok)).toEqual([true]);
  expect(bar(engines, "preview", bars[10]!).map((r) => (r.ok ? "ok" : r.error))).toEqual(["calc"]);
  expect(bar(engines, "preview", bars[11]!)).toEqual([]);
});

test("엔진 하나가 panic해도 같은 칸의 다른 엔진은 계속 계산한다", () => {
  let broken: Engine | null = null;
  const faulty: Wasm = {
    ...real,
    newEngine: (spec, cols) => {
      const e = real.newEngine(spec, cols);
      if (!spec.includes('"period":7')) return e;
      broken = e;
      return Object.assign(Object.create(Object.getPrototypeOf(e)), e, {
        lines: () => e.lines(), shift: (i: number) => e.shift(i), line: (i: number) => e.line(i), free: () => { throw panic(); },
        preview: () => { throw panic(); },
        pushConfirmed: () => { throw panic(); },
      }) as Engine;
    },
  };
  const engines = new Engines(faulty);
  create(engines, [{ kind: "ma", method: "sma", period: 7 }, { kind: "rsi", period: 14, signal: null }], bars.slice(0, 30), null);
  expect(broken).not.toBeNull();
  const first = bar(engines, "preview", bars[30]!);
  expect(first.map((r) => (r.ok ? "ok" : r.error))).toEqual(["calc", "ok"]);
  const after = bar(engines, "confirm", bars[30]!);
  expect(after.map((r) => [r.id, r.ok])).toEqual([["e1", true]]);
});

test("kinds.ts의 선 순서는 wasm 엔진의 선 순서와 같다", () => {
  const specs: IndicatorSpec[] = [...KIND_ORDER.map((k) => KINDS[k].defaults).filter((s) => !isFinancial(s)), { kind: "volume", maPeriod: null }, { kind: "rsi", period: 14, signal: 9 }];
  for (const spec of specs) {
    const e = real.newEngine(JSON.stringify(spec), columns(bars.slice(0, 5)));
    expect(e.lines(), spec.kind).toEqual(specLines(spec));
    e.free();
  }
});

for (const period of ["Q", "Y"] as const) {
  test(`${period}의 모든 기술지표는 해당 봉으로 계산하고 일목 선행스팬은 달력 봉만큼 이동한다`, () => {
    const specs = KIND_ORDER.map((kind) => KINDS[kind].defaults).filter((s) => !isFinancial(s));
    const calendarBars: BarTuple[] = bars.slice(0, 100).map(([, o, h, l, c, v], i) => [Date.UTC(1900, i * (period === "Q" ? 3 : 12), 1) / 1000 - 32400, o, h, l, c, v]);
    const results = create(new Engines(real), specs, calendarBars.slice(0, -1), calendarBars.at(-1)!, period);
    for (const result of results) {
      const draws = okDraws(result);
      expect(draws.length).toBeGreaterThan(0);
      for (const draw of draws) {
        const points = applyDraw([], draw);
        expect(points.length).toBeGreaterThan(0);
        expect(points.every((p) => Number.isFinite(p.v))).toBe(true);
      }
    }
    const ichimoku = results[specs.findIndex((s) => s.kind === "ichimoku")]!;
    if (!ichimoku.ok) throw new Error("일목균형표 계산 실패");
    const last = calendarBars.at(-1)![0];
    const d = new Date((last + 32400) * 1000);
    for (const [i, line] of ichimoku.lines.entries()) {
      if (line.shift <= 0) continue;
      const expected = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + line.shift * (period === "Q" ? 3 : 12), 1) / 1000 - 32400;
      expect(applyDraw([], ichimoku.draws[i]!).at(-1)!.t).toBe(expected);
    }
  });
}
