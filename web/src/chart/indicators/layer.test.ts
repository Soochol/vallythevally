import type { IChartApi } from "lightweight-charts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FinancialsPage } from "../../api/generated/FinancialsPage";
import type { FinancialPoint } from "../../api/generated/FinancialPoint";
import type { Bar } from "../../api/generated/Bar";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { normalizeHex } from "../../lib/colors";
import type { History } from "../barFeed";
import type { IndicatorConfig, Panel } from "../settings";
import type { ThemeTokens } from "../theme";
import { toChartTime } from "../time";
import type { PortListener } from "./client";
import { specLines } from "./kinds";
import { IndicatorLayer } from "./layer";
import type { FromWorker, LineDraw, ToWorker } from "./protocol";

interface Datum {
  time: number;
  value?: number;
  base?: number;
  connect?: boolean;
  color?: string;
}

class FakeSeries {
  data: Datum[] = [];
  readonly sets: Datum[][] = [];
  readonly rejected: string[] = [];
  readonly options: object[] = [];
  readonly scaleOptions: object[] = [];
  failNextUpdate = false;

  get setDataCalls(): number {
    return this.sets.length;
  }

  setData(data: Datum[]): void {
    this.data = [...data];
    this.sets.push(this.data);
  }

  update(d: Datum): void {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error("시리즈가 실패함");
    }
    const last = this.data[this.data.length - 1];
    if (last && d.time < last.time) {
      const rejected = `${d.time} < ${last.time}`;
      this.rejected.push(rejected);
      throw new Error(`Cannot update oldest data: ${rejected}`);
    }
    if (last?.time === d.time) this.data[this.data.length - 1] = d;
    else this.data.push(d);
  }

  applyOptions(options: object): void {
    this.options.push(options);
  }
  priceScale() {
    return { applyOptions: (options: object) => this.scaleOptions.push(options) };
  }
  createPriceLine() {
    return { applyOptions() {} };
  }
}

const TOKENS = { text2: "text2", line: "line", upVol: "upVol", downVol: "downVol", ind: {} } as unknown as ThemeTokens;

const T0 = Date.parse("2026-11-09T09:00:00+09:00") / 1000;
const at = (minute: number): UnixSeconds => T0 + minute * 60;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const close = (minute: number) => 100 + minute;
const bar = (minute: number, c = close(minute)): Bar => ({ t: at(minute), o: 100, h: 110, l: 90, c, v: 1000 });
const set = (minutes: number[], v: number): LineDraw => ({ op: "set", points: minutes.map((m) => ({ t: at(m), v })) });
const update = (minute: number, v: number): LineDraw => ({ op: "update", point: { t: at(minute), v } });
const drawn = (minute: number, value: number, base: number): Datum => ({ time: toChartTime(at(minute)), value, base });

const ICHIMOKU: IndicatorConfig = {
  id: "ichi",
  spec: { kind: "ichimoku", conversion: 3, base: 5, spanB: 8, displacement: 6 },
  panel: "price",
  visible: true,
  style: { colors: ["ind-1"], width: 1 },
};
const LINES = ["conversion", "base", "spanA", "spanB", "lagging"] as const;
type Line = (typeof LINES)[number];
type Draws = Partial<Record<Line, LineDraw>>;
const SHIFTS: Record<Line, number> = { conversion: 0, base: 0, spanA: 5, spanB: 5, lagging: -5 };
const perLine = <T>(f: (line: Line) => T) => Object.fromEntries(LINES.map((line) => [line, f(line)])) as Record<Line, T>;
const inLineOrder = (draws: Draws): LineDraw[] => LINES.map((line) => draws[line] ?? { op: "none" });

const CONFIRMED = range(0, 19).map((m) => bar(m));
const CREATED: Draws = { conversion: set(range(0, 19), 1), base: set(range(0, 19), 1), spanA: set(range(5, 24), 1), spanB: set(range(5, 24), 1), lagging: set(range(0, 14), 1) };

const created = (gen: number, draws: Draws = CREATED): Exclude<FromWorker, { type: "fatal" }> => ({
  type: "created",
  chart: 1,
  results: [{ id: ICHIMOKU.id, gen, ok: true, lines: LINES.map((id) => ({ id, shift: SHIFTS[id] })), draws: inLineOrder(draws) }],
});
const tail = (gen: number, draws: Draws): Exclude<FromWorker, { type: "fatal" }> => ({
  type: "tail",
  chart: 1,
  results: [{ id: ICHIMOKU.id, gen, ok: true, draws: inLineOrder(draws) }],
});

function fixture(period: "1m" | "Q" | "Y" = "1m", configs: IndicatorConfig[] = [ICHIMOKU], panels: Panel[] = []) {
  expect(specLines(ICHIMOKU.spec)).toEqual(LINES);
  const series: FakeSeries[] = [];
  const active: FakeSeries[] = [];
  const theme = { tokens: TOKENS };
  const sent: ToWorker[] = [];
  const port: { listener?: PortListener } = {};
  const add = (_definition: unknown, options: object) => {
    const s = new FakeSeries();
    s.applyOptions(options);
    series.push(s);
    active.push(s);
    return s;
  };
  const chart = {
    addSeries: add,
    addCustomSeries: add,
    removeSeries: (s: FakeSeries) => active.splice(active.indexOf(s), 1),
    panes: () => [],
  };
  const layer = new IndicatorLayer(
    { chart: chart as unknown as IChartApi, tokens: () => theme.tokens, isIndex: () => false, period: () => period, requestFrame: () => {}, axisFormatted: () => {}, axisCoordinates: () => [], axisFailed: () => {}, guard: (draw) => draw() },
    (listener) => {
      port.listener = listener;
      return { chart: 1, post: (m) => sent.push(m), close: () => {} };
    },
  );
  layer.setConfigs(configs, panels);
  const reply = (m: Exclude<FromWorker, { type: "fatal" }>) => port.listener?.message(structuredClone(m));
  const line = (id: Line) => series[LINES.indexOf(id)]!;
  return { layer, series, active, theme, line, sent, reply, breakWorker: () => port.listener?.broken("worker failed") };
}

interface Step {
  minute: number;
  kind: "live" | "confirmed";
  draws: Draws;
}

type Fixture = ReturnType<typeof fixture>;

function feedTails(steps: Step[], flushEach: boolean, beforeLastFlush: (f: Fixture) => void = () => {}, createdDraws: Draws = CREATED) {
  const f = fixture();
  let bars = CONFIRMED;
  f.layer.reset({ bars, current: null, nextBefore: null });
  f.reply(created(1, createdDraws));
  const setsBefore = perLine((id) => f.line(id).setDataCalls);
  for (const step of steps) {
    const b = bar(step.minute);
    if (step.kind === "confirmed") bars = [...bars, b];
    const h: History = { bars, current: step.kind === "live" ? b : null, nextBefore: null };
    f.layer.advance(h, b, step.kind);
    f.reply(tail(1, step.draws));
    if (flushEach) f.layer.flush();
  }
  beforeLastFlush(f);
  f.layer.flush();
  expect(f.sent.filter((m) => m.type === "create")).toHaveLength(1);
  return {
    ...f,
    data: () => perLine((id) => f.line(id).data),
    rejected: () => f.series.flatMap((s) => s.rejected),
    setsInFrame: () => perLine((id) => f.line(id).setDataCalls - setsBefore[id]),
  };
}

const lastOf = (s: FakeSeries) => s.data[s.data.length - 1];

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
});

test("선행스팬을 다시 놓은 프레임에 그 봉 확정과 다음 봉이 겹쳐도, 모든 선을 메시지마다 그린 것과 같게 그린다", () => {
  const regrid = set([...range(5, 19), ...range(21, 26)], 2);
  const steps: Step[] = [
    { minute: 21, kind: "live", draws: { conversion: update(21, 2), base: update(21, 2), spanA: regrid, spanB: regrid, lagging: update(15, 2) } },
    { minute: 21, kind: "confirmed", draws: { conversion: update(21, 3), base: update(21, 3), spanA: update(26, 3), spanB: update(26, 3), lagging: update(15, 3) } },
    { minute: 22, kind: "live", draws: { conversion: update(22, 4), base: update(22, 4), spanA: update(27, 4), spanB: update(27, 4), lagging: update(16, 4) } },
  ];
  const each = feedTails(steps, true);
  const once = feedTails(steps, false);

  expect(once.rejected()).toEqual([]);
  expect(consoleError).not.toHaveBeenCalled();
  expect(once.data()).toEqual(each.data());
  expect(perLine((id) => lastOf(once.line(id)))).toEqual({
    conversion: drawn(22, 4, close(22)),
    base: drawn(22, 4, close(22)),
    spanA: drawn(27, 4, 4),
    spanB: drawn(27, 4, 4),
    lagging: drawn(16, 4, close(16)),
  });
  const { conversion, base, lagging } = once.setsInFrame();
  expect({ conversion, base, lagging }).toEqual({ conversion: 0, base: 0, lagging: 0 });
});

test.each<[string, Step[]]>([
  [
    "보통 봉의 update 뒤에 다시 놓기가 온다",
    [
      { minute: 20, kind: "live", draws: { spanA: update(25, 2) } },
      { minute: 20, kind: "confirmed", draws: { spanA: update(25, 3) } },
      { minute: 22, kind: "live", draws: { spanA: set([...range(5, 20), ...range(22, 27)], 4) } },
      { minute: 22, kind: "confirmed", draws: { spanA: update(27, 5) } },
      { minute: 23, kind: "live", draws: { spanA: update(28, 6) } },
    ],
  ],
  [
    "한 프레임에 다시 놓기가 두 번 온다",
    [
      { minute: 21, kind: "live", draws: { spanA: set([...range(5, 19), ...range(21, 26)], 2) } },
      { minute: 21, kind: "confirmed", draws: { spanA: update(26, 3) } },
      { minute: 23, kind: "live", draws: { spanA: set([...range(5, 19), 21, ...range(23, 28)], 4) } },
      { minute: 23, kind: "confirmed", draws: { spanA: update(28, 5) } },
      { minute: 24, kind: "live", draws: { spanA: update(29, 6) } },
    ],
  ],
])("한 프레임에 쌓인 그리기는 메시지마다 그린 것과 같다: %s", (_, steps) => {
  const each = feedTails(steps, true);
  const once = feedTails(steps, false);
  expect(once.rejected()).toEqual([]);
  expect(consoleError).not.toHaveBeenCalled();
  expect(once.data()).toEqual(each.data());
  const last = steps[steps.length - 1]!.draws.spanA as Extract<LineDraw, { op: "update" }>;
  expect(lastOf(once.line("spanA"))).toEqual({ time: toChartTime(last.point.t), value: last.point.v, base: last.point.v });
});

test.each([true, false])("가격 패널 선은 기준값만 든 점을 첫 실제 점 앞에 주 봉마다 하나씩만 두고, 실제 점의 기준값은 그 시각의 주 봉 종가다 (메시지마다 그리기: %s)", (flushEach) => {
  const warmup: Draws = { conversion: set(range(2, 19), 1), base: set([], 1), spanA: set(range(12, 24), 1), spanB: set(range(15, 24), 1), lagging: set([], 1) };
  const regrid = (from: number) => set([...range(from, 20), ...range(22, 27)], 4);
  const steps: Step[] = [
    { minute: 20, kind: "live", draws: { conversion: update(20, 2), base: update(20, 2), spanA: update(25, 2), spanB: update(25, 2) } },
    { minute: 20, kind: "confirmed", draws: { conversion: update(20, 3), base: update(20, 3), spanA: update(25, 3), spanB: update(25, 3), lagging: set(range(0, 15), 3) } },
    { minute: 22, kind: "live", draws: { conversion: update(22, 4), base: update(22, 4), spanA: regrid(12), spanB: regrid(15), lagging: update(16, 4) } },
    { minute: 22, kind: "confirmed", draws: { conversion: update(22, 4), base: update(22, 4), spanA: update(27, 4), spanB: update(27, 4), lagging: update(16, 4) } },
    { minute: 23, kind: "live", draws: { conversion: update(23, 5), spanA: update(28, 5), spanB: update(28, 5), lagging: update(17, 5) } },
  ];
  const f = feedTails(steps, flushEach, undefined, warmup);
  const mains = [...CONFIRMED, bar(20), bar(22), bar(23)];
  const closeAt = new Map<number, number>(mains.map((b) => [toChartTime(b.t), b.c]));

  expect(f.line("lagging").sets[0]).toEqual([]);
  expect(f.line("base").data[0]).toEqual({ time: toChartTime(at(0)), base: close(0) });
  for (const id of LINES) {
    const sets = f.line(id).sets.filter((rows) => rows.length > 0);
    expect(sets.length).toBeGreaterThan(0);
    for (const rows of sets) {
      const first = rows.findIndex((r) => r.value !== undefined);
      const warm = rows.slice(0, first);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(rows.slice(first).every((r) => r.value !== undefined)).toBe(true);
      expect(warm.map((r) => r.time)).toEqual(CONFIRMED.map((b) => toChartTime(b.t)).filter((t) => t < rows[first]!.time));
      expect(warm.map((r) => r.base)).toEqual(warm.map((r) => closeAt.get(r.time)));
    }
    const real = f.line(id).data.filter((r) => r.value !== undefined);
    expect(real.map((r) => r.base)).toEqual(real.map((r) => closeAt.get(r.time) ?? r.value));
  }
  expect(lastOf(f.line("spanA"))).toEqual(drawn(28, 5, 5));
  expect(f.line("spanA").data.find((r) => r.time === toChartTime(at(23)))?.base).toBe(close(23));
});

type Order = "응답 뒤 그리기" | "그리기 뒤 응답" | "한 프레임에 모두";

test.each<Order>(["응답 뒤 그리기", "그리기 뒤 응답", "한 프레임에 모두"])("같은 봉의 체결과 확정으로 종가가 바뀌어도, 모든 가격 패널 선의 기준값은 그 시각 주 봉의 지금 종가다 (%s)", (order) => {
  const f = fixture();
  f.layer.reset({ bars: CONFIRMED, current: null, nextBefore: null });
  f.reply(created(1));
  const ticks: { kind: "live" | "confirmed"; c: number }[] = [
    { kind: "live", c: 120 },
    { kind: "live", c: 150 },
    { kind: "live", c: 150 },
    { kind: "confirmed", c: 140 },
  ];
  ticks.forEach(({ kind, c }, i) => {
    const b = bar(20, c);
    const h: History = kind === "live" ? { bars: CONFIRMED, current: b, nextBefore: null } : { bars: [...CONFIRMED, b], current: null, nextBefore: null };
    f.layer.advance(h, b, kind);
    if (order === "그리기 뒤 응답") f.layer.flush();
    f.reply(tail(1, { conversion: update(20, i), base: update(20, i), spanA: update(25, i), spanB: update(25, i), lagging: update(15, i) }));
    if (order !== "한 프레임에 모두") f.layer.flush();
  });
  f.layer.flush();
  const closeAt = new Map<number, number>([...CONFIRMED, bar(20, 140)].map((b) => [toChartTime(b.t), b.c]));
  const current = toChartTime(at(20));

  expect(f.series.flatMap((s) => s.rejected)).toEqual([]);
  expect(consoleError).not.toHaveBeenCalled();
  for (const id of LINES) {
    const rows = f.line(id).data;
    expect(rows.map((r) => r.base)).toEqual(rows.map((r) => closeAt.get(r.time) ?? r.value));
  }
  expect(LINES.filter((id) => f.line(id).data.some((r) => r.time === current))).toEqual(["conversion", "base", "spanA", "spanB"]);
});

test("한 선의 update가 실패해도 같은 프레임의 다른 선은 그리고, 실패한 선만 점 사본으로 다시 맞춘다", () => {
  const steps: Step[] = [{ minute: 20, kind: "live", draws: { conversion: update(20, 2), base: update(20, 2), spanA: update(25, 2), spanB: update(25, 2), lagging: update(15, 2) } }];
  const each = feedTails(steps, true);
  const once = feedTails(steps, false, (f) => {
    f.line("conversion").failNextUpdate = true;
  });

  expect(once.data()).toEqual(each.data());
  const plain = each.setsInFrame();
  expect(once.setsInFrame()).toEqual({ ...plain, conversion: plain.conversion + 1 });
  expect(consoleError).toHaveBeenCalledTimes(1);
});

test("늦게 온 옛 세대의 created·tail 응답은 새 세대의 선을 바꾸지 않는다", () => {
  const f = fixture();
  f.layer.reset({ bars: CONFIRMED, current: null, nextBefore: null });
  const live = bar(20);
  f.layer.advance({ bars: CONFIRMED, current: live, nextBefore: null }, live, "live");
  f.layer.clear();
  const later = range(100, 119).map((m) => bar(m, 105));
  f.layer.reset({ bars: later, current: null, nextBefore: null });
  f.reply(created(2, { conversion: set(range(100, 119), 7), base: set(range(100, 119), 7), spanA: set(range(105, 124), 7), spanB: set(range(105, 124), 7), lagging: set(range(100, 114), 7) }));
  f.layer.flush();
  const before = f.series.map((s) => s.data);

  f.reply(created(1));
  f.reply(tail(1, { conversion: update(20, 9), base: update(20, 9), spanA: update(25, 9), spanB: update(25, 9), lagging: update(15, 9) }));
  f.layer.flush();

  expect(f.series.map((s) => s.data)).toEqual(before);
  expect(f.layer.rows(at(110))[0]?.values.map((v) => v.text)).not.toContain("—");
});

test("마지막 확정 봉과 같은 시각의 봉이 오면 preview가 아니라 지표를 다시 만든다", () => {
  const f = fixture();
  f.layer.reset({ bars: CONFIRMED, current: null, nextBefore: null });
  f.reply(created(1));
  const replaced = bar(19, 102);
  f.layer.advance({ bars: [...CONFIRMED.slice(0, -1), replaced], current: null, nextBefore: null }, replaced, "live");

  const last = f.sent[f.sent.length - 1];
  expect(last?.type).toBe("create");
  f.reply(created(last?.type === "create" ? last.gen : -1));
  expect(f.layer.rows(replaced.t)[0]?.state).toBe("ok");
});


test("재무값은 WASM 계산 없이 API bucket에 그리고 누락·겹침·미공시를 연결하지 않는다", () => {
  const f = fixture("Q");
  const color = normalizeHex("#a3e635");
  if (!color) throw new Error("시험 색상이 올바르지 않습니다");
  const config: IndicatorConfig = { id: "financial", spec: { kind: "debt_ratio" }, panel: "p", visible: true, style: { colors: [color], width: 5 } };
  f.layer.setConfigs([config], [{ id: "p", stretch: 0.25 }]);
  f.layer.reset({ bars: CONFIRMED, current: null, nextBefore: null });
  const bucket = (month: number) => Date.UTC(2024, month, 1) / 1000 - 32400;
  const point = (month: number, value: number | null): FinancialPoint => ({ businessYear: 2024, reportCode: "11013", status: value === null ? "unpublished" : "available", reason: null, value, reportedValue: null, period: { kind: "instant", date: "2024-03-31" }, priceBucket: bucket(month), basis: "CFS", currency: "KRW", inputs: [] });
  const page: FinancialsPage = { symbol: "005930", period: "Q", status: "partial_failure", reason: null, failure: null, corpCode: null, fiscalMonth: 3, shareClass: null, shareClassReason: null, lastCheckedAt: null, lastAttemptAt: null, disclosureFailure: null, refreshVersion: 0, disclosureVersion: 0, latestCorrections: true, progress: { total: 4, completed: 3, failed: 1, pending: 0 }, series: [{ metric: "debt_ratio", points: [point(0, -10), point(3, null), point(6, 0), point(9, 20), point(12, null)] }] };
  f.layer.setFinancials(page);
  const line = f.series.at(-1)!;
  expect(line.data).toEqual([{ time: toChartTime(bucket(0)), value: -10, base: -10, connect: false }, { time: toChartTime(bucket(6)), value: 0, base: 0, connect: false }, { time: toChartTime(bucket(9)), value: 20, base: 20, connect: true }]);
  expect(f.sent.filter((m) => m.type === "create")).toHaveLength(0);
  expect(f.layer.rows(bucket(6))[0]).toMatchObject({ name: "부채비율 · 3월 결산", color: "#A3E635", values: [{ text: "0 %" }] });
  f.layer.setFinancials({ ...page, series: [{ metric: "debt_ratio", points: [{ ...point(0, null), reason: "period_overlap", reportedValue: 500 }] }] });
  expect(line.data).toEqual([]);
  f.layer.setFinancials(null);
  expect(line.data).toEqual([]);
});

const VOLUME: IndicatorConfig = { id: "volume", spec: { kind: "volume", maPeriod: null }, panel: "p", visible: true, style: { colors: ["ind-1"], width: 1 } };
const VOLUME_PANELS: Panel[] = [{ id: "p", stretch: 0.25 }];
const volumeRows = (bars: Bar[], tokens = TOKENS): Datum[] => bars.map(b => ({ time: toChartTime(b.t), value: b.v, color: b.c >= b.o ? tokens.upVol : tokens.downVol }));
const history = (bars: Bar[], current: Bar | null = null): History => ({ bars, current, nextBefore: null });

function workerVolume(gen: number, value: number): Exclude<FromWorker, { type: "fatal" }> {
  return { type: "created", chart: 1, results: [{ id: VOLUME.id, gen, ok: true, lines: [{ id: "volume", shift: 0 }, { id: "ma", shift: 0 }], draws: [set([0, 1], value), set([1], value / 2)] }] };
}

function latestCreate(f: Fixture): Extract<ToWorker, { type: "create" }> {
  const message = f.sent.findLast(m => m.type === "create");
  if (!message || message.type !== "create") throw new Error("worker 생성 요청이 없습니다");
  return message;
}

test.each([null, bar(1, 90), bar(2, 100)])("기본 거래량은 worker 응답 없이 초기 이력과 중복 없는 현재 봉을 그리고 과거 prepend를 반영한다 (%j)", current => {
  const f = fixture("1m", [VOLUME], VOLUME_PANELS);
  const bars = [{ ...bar(0, 90), v: 0 }, { ...bar(1, 100), v: 1500 }];
  const shown = current && current.t > bars[1]!.t ? [...bars, current] : bars;
  f.layer.reset(history(bars, current));
  expect(f.active[0]?.data).toEqual(volumeRows(shown));
  expect(f.layer.rows(bars[0]!.t)[0]).toMatchObject({ state: "ok", values: [{ text: "0" }] });
  expect(f.active[0]?.scaleOptions).toContainEqual({ mode: 0, scaleMargins: { top: 0.12, bottom: 0 } });
  const older = { ...bar(-1, 105), v: 3000 };
  f.layer.reset(history([older, ...bars], current));
  expect(f.active[0]?.data).toEqual(volumeRows([older, ...shown]));
  expect(f.sent.filter(m => m.type === "create" || m.type === "bar")).toEqual([]);
});

test("기본 거래량은 빈 이력 뒤 현재 봉, 같은 종가의 거래량 변경, 확정과 다음 봉을 flush 없이 반영한다", () => {
  const f = fixture("1m", [VOLUME], VOLUME_PANELS);
  f.layer.reset(history([]));
  expect(f.active[0]?.data).toEqual([]);
  expect(f.layer.rows(null)[0]?.state).toBe("ok");
  const first = { ...bar(0, 110), v: 100 };
  f.layer.advance(history([], first), first, "live");
  expect(f.active[0]?.data).toEqual(volumeRows([first]));
  const more = { ...first, v: 250 };
  f.layer.advance(history([], more), more, "live");
  expect(f.active[0]?.data).toEqual(volumeRows([more]));
  const confirmed = { ...more, c: 90, v: 500 };
  f.layer.advance(history([confirmed]), confirmed, "confirmed");
  expect(f.active[0]?.data).toEqual(volumeRows([confirmed]));
  const next = { ...bar(1, 100), v: 0 };
  f.layer.advance(history([confirmed], next), next, "live");
  expect(f.active[0]?.data).toEqual(volumeRows([confirmed, next]));
  const correction = { ...next, c: 80, v: 600 };
  f.layer.advance(history([confirmed, correction]), correction, "confirmed");
  const revised = { ...correction, v: 800 };
  f.layer.advance(history([confirmed, revised]), revised, "live");
  expect(f.active[0]?.data).toEqual(volumeRows([confirmed, revised]));
  expect(f.active[0]?.rejected).toEqual([]);
  expect(f.sent.filter(m => m.type === "create" || m.type === "bar")).toEqual([]);
});

test("기본 거래량은 숨긴 동안 비우고 다시 표시할 때 최신 이력으로 복원하며 테마와 패널 순서를 따른다", () => {
  const second: IndicatorConfig = { ...VOLUME, id: "second", panel: "q" };
  const panels: Panel[] = [...VOLUME_PANELS, { id: "q", stretch: 0.5 }];
  const f = fixture("1m", [VOLUME, second], panels);
  const bars = [bar(0, 80), bar(1, 100)];
  f.layer.reset(history(bars));
  f.layer.setConfigs([{ ...VOLUME, visible: false }, second], panels);
  expect(f.active[0]?.data).toEqual([]);
  expect(f.layer.rows(at(1))[0]).toMatchObject({ state: "hidden", values: [] });
  const live = { ...bar(2, 105), v: 2000 };
  f.layer.advance(history(bars, live), live, "live");
  expect(f.active[0]?.data).toEqual([]);
  f.layer.setConfigs([VOLUME, second], panels);
  expect(f.active.map(s => s.data)).toEqual([volumeRows([...bars, live]), volumeRows([...bars, live])]);
  f.theme.tokens = { ...TOKENS, upVol: "newUp", downVol: "newDown" };
  f.layer.setTheme();
  expect(f.active.map(s => s.data)).toEqual([volumeRows([...bars, live], f.theme.tokens), volumeRows([...bars, live], f.theme.tokens)]);
  f.layer.setConfigs([second, VOLUME], [panels[1]!, panels[0]!]);
  expect(f.layer.rows(live.t).map(row => ({ id: row.id, panel: row.panel?.index }))).toEqual([{ id: "second", panel: 0 }, { id: "volume", panel: 1 }]);
  expect(f.active.map(s => s.data)).toEqual([volumeRows([...bars, live], f.theme.tokens), volumeRows([...bars, live], f.theme.tokens)]);
  expect(f.active.every(s => s.options.some(o => "visible" in o && o.visible === true))).toBe(true);
});

test("거래량 MA를 끄면 이전 worker 엔진을 버리고 늦은 응답이 기본 거래량과 새 종목을 덮지 못한다", () => {
  const ma: IndicatorConfig = { ...VOLUME, spec: { kind: "volume", maPeriod: 5 } };
  const f = fixture("1m", [ma], VOLUME_PANELS);
  const bars = [bar(0, 80), bar(1, 105)];
  f.layer.reset(history(bars));
  const old = latestCreate(f);
  expect(old.engines).toEqual([{ id: VOLUME.id, spec: JSON.stringify(ma.spec) }]);
  expect(f.active.map(s => s.data)).toEqual([[], []]);
  f.reply(workerVolume(old.gen, 9000));
  expect(f.active[0]?.data.map(d => d.value)).toEqual([9000, 9000]);
  expect(f.active[1]?.data.map(d => d.value)).toEqual([4500]);
  f.layer.setConfigs([VOLUME], VOLUME_PANELS);
  expect(f.active.map(s => s.data)).toEqual([volumeRows(bars)]);
  expect(f.sent).toContainEqual({ type: "drop", chart: 1, ids: [VOLUME.id] });
  f.reply(workerVolume(old.gen, 99999));
  f.reply({ type: "tail", chart: 1, results: [{ id: VOLUME.id, gen: old.gen, ok: true, draws: [update(2, 99999)] }] });
  f.layer.flush();
  expect(f.active.map(s => s.data)).toEqual([volumeRows(bars)]);
  f.layer.clear();
  expect(f.active[0]?.data).toEqual([]);
  const other = [bar(100, 90), bar(101, 110)];
  f.layer.reset(history(other));
  f.reply(workerVolume(old.gen, 99999));
  f.layer.flush();
  expect(f.active[0]?.data).toEqual(volumeRows(other));
  expect(f.layer.rows(at(100))[0]?.state).toBe("ok");
});

test("기본 거래량에 MA를 켜면 worker 결과를 기다리고 다시 끄면 최신 봉을 동기로 복원한다", () => {
  const f = fixture("1m", [VOLUME], VOLUME_PANELS);
  const bars = [bar(0), bar(1)];
  f.layer.reset(history(bars));
  const ma: IndicatorConfig = { ...VOLUME, spec: { kind: "volume", maPeriod: 5 } };
  f.layer.setConfigs([ma], VOLUME_PANELS);
  const request = latestCreate(f);
  expect(f.active.map(s => s.data)).toEqual([[], []]);
  expect(f.layer.rows(at(1))[0]?.state).toBe("pending");
  f.reply(workerVolume(request.gen, 1200));
  expect(f.layer.rows(at(1))[0]?.state).toBe("ok");
  expect(f.active.map(s => s.data.map(d => d.value))).toEqual([[1200, 1200], [600]]);
  const current = { ...bar(2), v: 3000 };
  f.layer.advance(history(bars, current), current, "live");
  expect(f.sent.at(-1)).toMatchObject({ type: "bar", kind: "preview", bar: [current.t, current.o, current.h, current.l, current.c, current.v] });
  f.layer.setConfigs([VOLUME], VOLUME_PANELS);
  expect(f.active.map(s => s.data)).toEqual([volumeRows([...bars, current])]);
  f.reply({ type: "tail", chart: 1, results: [{ id: VOLUME.id, gen: request.gen, ok: false, error: "calc", message: "late failure" }] });
  expect(f.layer.rows(current.t)[0]?.state).toBe("ok");
  expect(f.active[0]?.data).toEqual(volumeRows([...bars, current]));
});

test.each([true, false])("worker가 고장 나도 기본 거래량의 초기·실시간·설정 전환은 보이고 다른 지표의 실패는 남는다 (초기 고장 %s)", beforeReset => {
  const f = fixture("1m", [VOLUME, ICHIMOKU], VOLUME_PANELS);
  if (beforeReset) f.breakWorker();
  const bars = [bar(0, 90), bar(1, 100)];
  f.layer.reset(history(bars));
  if (!beforeReset) f.breakWorker();
  expect(f.layer.rows(at(1)).map(row => row.state)).toEqual(["ok", "calc"]);
  expect(f.active.at(-1)?.data).toEqual(volumeRows(bars));
  const current = { ...bar(2, 110), v: 4000 };
  f.layer.advance(history(bars, current), current, "live");
  expect(f.active.at(-1)?.data).toEqual(volumeRows([...bars, current]));
  const ma: IndicatorConfig = { ...VOLUME, spec: { kind: "volume", maPeriod: 5 } };
  f.layer.setConfigs([ma, ICHIMOKU], VOLUME_PANELS);
  expect(f.layer.rows(current.t).map(row => row.state)).toEqual(["calc", "calc"]);
  f.layer.setConfigs([VOLUME, ICHIMOKU], VOLUME_PANELS);
  expect(f.layer.rows(current.t).map(row => row.state)).toEqual(["ok", "calc"]);
  expect(f.active.at(-1)?.data).toEqual(volumeRows([...bars, current]));
});
