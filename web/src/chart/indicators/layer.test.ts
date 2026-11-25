import type { IChartApi } from "lightweight-charts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FinancialsPage } from "../../api/generated/FinancialsPage";
import type { FinancialPoint } from "../../api/generated/FinancialPoint";
import type { Bar } from "../../api/generated/Bar";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { normalizeHex } from "../../lib/colors";
import type { History } from "../barFeed";
import { trackedValuesOf } from "../legendShapes";
import type { IndicatorConfig, Panel } from "../settings";
import type { ThemeTokens } from "../theme";
import { toChartTime } from "../time";
import type { PortListener } from "./client";
import { formatPrice, formatVolume } from "../../lib/format";
import type { QuoteDepthPoint } from "../../api/generated/QuoteDepthPoint";
import type { QuoteTotalPoint } from "../../api/generated/QuoteTotalPoint";
import type { QuoteState, QuoteView } from "../quotes/feed";
import { specLines } from "./kinds";
import { IndicatorLayer } from "./layer";
import type { FromWorker, LineDraw, ToWorker } from "./protocol";

interface Datum {
  time: number;
  value?: number;
  base?: number;
  connect?: boolean;
  break?: boolean;
  color?: string;
}

class FakeSeries {
  data: Datum[] = [];
  readonly sets: Datum[][] = [];
  readonly rejected: string[] = [];
  readonly options: object[] = [];
  readonly scaleOptions: object[] = [];
  pane = 0;
  order: number | undefined;
  failNextUpdate = false;

  get setDataCalls(): number {
    return this.sets.length;
  }

  setData(data: Datum[]): void {
    this.data = [...data];
    this.sets.push(this.data);
  }

  update(d: Datum, historical = false): void {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error("시리즈가 실패함");
    }
    const last = this.data[this.data.length - 1];
    if (historical && last && d.time < last.time) {
      const old = this.data.findIndex((known) => known.time === d.time);
      if (old >= 0) this.data[old] = d;
      return;
    }
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
  setSeriesOrder(order: number) {
    this.order = order;
  }
}

const TOKENS = { text2: "text2", line: "line", up: "#FF6B78", down: "#5B9BFF", upVol: "upVol", downVol: "downVol", ind: {} } as unknown as ThemeTokens;

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

function fixture(period: "1m" | "Q" | "Y" = "1m", configs: IndicatorConfig[] = [ICHIMOKU], panels: Panel[] = [], isIndex = false) {
  expect(specLines(ICHIMOKU.spec)).toEqual(LINES);
  const series: FakeSeries[] = [];
  const active: FakeSeries[] = [];
  const theme = { tokens: TOKENS };
  const sent: ToWorker[] = [];
  const port: { listener?: PortListener } = {};
  const add = (_definition: unknown, options: object, pane = 0) => {
    const s = new FakeSeries();
    s.pane = pane;
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
    { chart: chart as unknown as IChartApi, tokens: () => theme.tokens, isIndex: () => isIndex, period: () => period, requestFrame: () => {}, axisFormatted: () => {}, axisCoordinates: () => [], axisFailed: () => {}, guard: (draw) => draw() },
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
  expect(f.line("spanA").setDataCalls).toBe(1);
  expect(f.line("spanB").setDataCalls).toBe(1);
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
const VOLUME_COLORS = { up: "rgba(255, 107, 120, 0.38)", down: "rgba(91, 155, 255, 0.38)" };
const volumeRows = (bars: Bar[], colors = VOLUME_COLORS): Datum[] => bars.map(b => ({ time: toChartTime(b.t), value: b.v, color: b.c >= b.o ? colors.up : colors.down }));
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

test("기본 거래량은 빈 이력 뒤 현재 봉, 같은 종가의 거래량 변경, 확정과 다음 봉을 프레임에 반영한다", () => {
  const f = fixture("1m", [VOLUME], VOLUME_PANELS);
  f.layer.reset(history([]));
  expect(f.active[0]?.data).toEqual([]);
  expect(f.layer.rows(null)[0]?.state).toBe("ok");
  const first = { ...bar(0, 110), v: 100 };
  f.layer.advance(history([], first), first, "live");
  expect(f.layer.rows(first.t)[0]).toMatchObject({ state: "ok", values: [{ text: "100" }] });
  expect(f.active[0]?.data).toEqual([]);
  f.layer.flush();
  expect(f.active[0]?.data).toEqual(volumeRows([first]));
  const more = { ...first, v: 250 };
  f.layer.advance(history([], more), more, "live");
  expect(f.layer.rows(more.t)[0]).toMatchObject({ values: [{ text: "250" }] });
  expect(f.active[0]?.data).toEqual(volumeRows([first]));
  f.layer.flush();
  expect(f.active[0]?.data).toEqual(volumeRows([more]));
  const confirmed = { ...more, c: 90, v: 500 };
  f.layer.advance(history([confirmed]), confirmed, "confirmed");
  f.layer.flush();
  expect(f.active[0]?.data).toEqual(volumeRows([confirmed]));
  const next = { ...bar(1, 100), v: 0 };
  f.layer.advance(history([confirmed], next), next, "live");
  f.layer.flush();
  expect(f.active[0]?.data).toEqual(volumeRows([confirmed, next]));
  const correction = { ...next, c: 80, v: 600 };
  f.layer.advance(history([confirmed, correction]), correction, "confirmed");
  const revised = { ...correction, v: 800 };
  f.layer.advance(history([confirmed, revised]), revised, "live");
  expect(f.active[0]?.data).toEqual(volumeRows([confirmed, revised]));
  expect(f.active[0]?.rejected).toEqual([]);
  expect(f.sent.filter(m => m.type === "create" || m.type === "bar")).toEqual([]);
});

test("기본 거래량은 같은 시각의 여러 체결과 rollover를 flush에서 두 최종 값으로 묶는다", () => {
  const f = fixture("1m", [VOLUME], VOLUME_PANELS);
  const bars = [bar(0)];
  f.layer.reset(history(bars));
  const series = f.active[0]!;
  const updates = vi.spyOn(series, "update");
  const first = { ...bar(1, 110), v: 100 };
  const more = { ...first, v: 250 };
  const confirmed = { ...more, c: 90, v: 500 };
  const next = { ...bar(2, 100), v: 0 };
  const latest = { ...next, v: 600 };
  f.layer.advance(history(bars, first), first, "live");
  f.layer.advance(history(bars, more), more, "live");
  f.layer.advance(history([...bars, confirmed]), confirmed, "confirmed");
  f.layer.advance(history([...bars, confirmed], next), next, "live");
  f.layer.advance(history([...bars, confirmed], latest), latest, "live");
  expect(f.layer.rows(confirmed.t)[0]).toMatchObject({ state: "ok", values: [{ text: "500" }] });
  expect(f.layer.rows(latest.t)[0]).toMatchObject({ state: "ok", values: [{ text: "600" }] });
  expect(series.data).toEqual(volumeRows(bars));
  expect(updates).not.toHaveBeenCalled();
  f.layer.flush();
  expect(updates.mock.calls).toEqual(volumeRows([confirmed, latest]).map(point => [point]));
  expect(series.data).toEqual(volumeRows([...bars, confirmed, latest]));
  f.layer.flush();
  expect(updates).toHaveBeenCalledTimes(2);
  expect(series.rejected).toEqual([]);
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
  expect(f.active.map(s => s.data)).toEqual([volumeRows([...bars, live]), volumeRows(bars)]);
  f.layer.flush();
  expect(f.active.map(s => s.data)).toEqual([volumeRows([...bars, live]), volumeRows([...bars, live])]);
  f.theme.tokens = { ...TOKENS, up: "#102030", down: "#405060" };
  const recolored = { up: "rgba(16, 32, 48, 0.38)", down: "rgba(64, 80, 96, 0.38)" };
  f.layer.setTheme();
  expect(f.active.map(s => s.data)).toEqual([volumeRows([...bars, live], recolored), volumeRows([...bars, live], recolored)]);
  f.layer.setConfigs([second, VOLUME], [panels[1]!, panels[0]!]);
  expect(f.layer.rows(live.t).map(row => ({ id: row.id, panel: row.panel?.index }))).toEqual([{ id: "second", panel: 0 }, { id: "volume", panel: 1 }]);
  expect(f.active.map(s => s.data)).toEqual([volumeRows([...bars, live], recolored), volumeRows([...bars, live], recolored)]);
  expect(f.active.every(s => s.options.some(o => "visible" in o && o.visible === true))).toBe(true);
});

const optionOf = (s: FakeSeries, key: string): unknown => s.options.findLast((o) => key in o)?.[key as keyof object];

test("가격 패널에 겹친 거래량은 0번 pane의 자기 축 아래 20%에 막대를 봉 뒤로 그리고 이동평균선도 그 축을 쓴다", () => {
  const over: IndicatorConfig = { ...VOLUME, spec: { kind: "volume", maPeriod: 20 }, panel: "price" };
  const f = fixture("1m", [over], []);
  f.layer.reset(history([bar(0), bar(1)]));
  f.reply(workerVolume(1, 500));
  const [bars, ma] = f.active;
  expect([bars?.pane, ma?.pane]).toEqual([0, 0]);
  expect(optionOf(bars!, "priceScaleId")).toBe("volume:volume");
  expect(optionOf(ma!, "priceScaleId")).toBe("volume:volume");
  expect(bars!.scaleOptions.at(-1)).toMatchObject({ scaleMargins: { top: 0.8, bottom: 0 } });
  expect([bars?.order, ma?.order]).toEqual([0, undefined]);
  expect([optionOf(bars!, "lastValueVisible"), optionOf(ma!, "lastValueVisible")]).toEqual([false, false]);
  expect(ma!.data).toEqual([drawn(1, 250, 250)]);
  expect(f.layer.rows(at(1))[0]).toMatchObject({ id: "volume", panel: null, values: [{ text: "500" }, { text: "250" }] });
});

test("거래량 막대의 알파는 barOpacity이고 별도 패널과 겹침, 테마 변경에 함께 따른다", () => {
  const f = fixture("1m", [VOLUME], VOLUME_PANELS);
  const bars = [bar(0, 80), bar(1, 100)];
  f.layer.reset(history(bars));
  expect(f.active[0]!.data).toEqual(volumeRows(bars));
  const paler = { ...VOLUME, style: { ...VOLUME.style, barOpacity: 0.8 } };
  f.layer.setConfigs([paler], VOLUME_PANELS);
  const strong = { up: "rgba(255, 107, 120, 0.8)", down: "rgba(91, 155, 255, 0.8)" };
  expect(f.active).toHaveLength(1);
  expect(f.active[0]!.data).toEqual(volumeRows(bars, strong));
  f.layer.setConfigs([{ ...paler, panel: "price" }], []);
  expect(f.active).toHaveLength(1);
  expect(f.active[0]!.pane).toBe(0);
  expect(f.active[0]!.data).toEqual(volumeRows(bars, strong));
  f.theme.tokens = { ...TOKENS, up: "#102030", down: "#405060" };
  f.layer.setTheme();
  expect(f.active[0]!.data).toEqual(volumeRows(bars, { up: "rgba(16, 32, 48, 0.8)", down: "rgba(64, 80, 96, 0.8)" }));
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
  expect(f.layer.rows(current.t).map(row => row.state)).toEqual(["ok", "calc"]);
  f.layer.flush();
  expect(f.active.at(-1)?.data).toEqual(volumeRows([...bars, current]));
  const ma: IndicatorConfig = { ...VOLUME, spec: { kind: "volume", maPeriod: 5 } };
  f.layer.setConfigs([ma, ICHIMOKU], VOLUME_PANELS);
  expect(f.layer.rows(current.t).map(row => row.state)).toEqual(["calc", "calc"]);
  f.layer.setConfigs([VOLUME, ICHIMOKU], VOLUME_PANELS);
  expect(f.layer.rows(current.t).map(row => row.state)).toEqual(["ok", "calc"]);
  expect(f.active.at(-1)?.data).toEqual(volumeRows([...bars, current]));
});

const OLDER = range(-10, -1).map((m) => bar(m));
const EXTENDED: Draws = { conversion: set(range(-10, 19), 2), base: set(range(-10, 19), 2), spanA: set(range(-5, 24), 2), spanB: set(range(-5, 24), 2), lagging: set(range(-10, 14), 2) };
const realPoints = (f: Fixture) => perLine((id) => f.line(id).data.filter((r) => r.value !== undefined).map((r) => ({ time: r.time, value: r.value })));
const expectedPoints = (draws: Draws) => perLine((id) => {
  const d = draws[id];
  return d?.op === "set" ? d.points.map((p) => ({ time: toChartTime(p.t), value: p.v })) : [];
});

const HIDDEN_MA: IndicatorConfig = { id: "hiddenMa", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: false, style: { colors: ["ind-2"], width: 1 } };

const RSI: IndicatorConfig = { id: "rsi", spec: { kind: "rsi", period: 5, signal: null }, panel: "r", visible: true, style: { colors: ["ind-3"], width: 1 } };

function prependedAfterFirstDraw() {
  const f = fixture("1m", [ICHIMOKU, HIDDEN_MA, RSI, VOLUME], [{ id: "r", stretch: 0.25 }, ...VOLUME_PANELS]);
  f.layer.reset(history(CONFIRMED));
  f.reply(created(1));
  f.reply({ type: "created", chart: 1, results: [{ id: RSI.id, gen: 1, ok: true, lines: [{ id: "rsi", shift: 0 }], draws: [set(range(5, 19), 50)] }] });
  f.layer.flush();
  const pointsBefore = realPoints(f);
  const rsiLine = f.series[LINES.length + 1]!;
  const rsiBefore = rsiLine.data;
  const allSetsBefore = f.series.map((s) => s.setDataCalls);
  const legendBefore = f.layer.rows(at(10))[0];
  f.layer.prepend(history([...OLDER, ...CONFIRMED]));
  const drawnAfterPrepend = perLine((id) => f.line(id).data);
  const setsAfterPrepend = perLine((id) => f.line(id).setDataCalls);
  const emptySetsInPrepend = f.series.flatMap((s, i) => s.sets.slice(allSetsBefore[i])).filter((rows) => rows.length === 0).length;
  return { ...f, pointsBefore, rsiLine, rsiBefore, drawnAfterPrepend, emptySetsInPrepend, hiddenLine: f.series[LINES.length]!, volumeLine: f.series.at(-1)!, legendBefore, request: latestCreate(f), setsSincePrepend: () => perLine((id) => f.line(id).setDataCalls - setsAfterPrepend[id]) };
}

test("과거 페이지를 붙이는 동안 워커 지표의 선과 범례 값은 직전 그대로이고, 새 세대 응답이 오면 선마다 한 번에 바꾼다", () => {
  const f = prependedAfterFirstDraw();

  expect(realPoints(f)).toEqual(f.pointsBefore);
  expect(perLine((id) => f.line(id).data[0])).toEqual(perLine(() => ({ time: toChartTime(OLDER[0]!.t), base: OLDER[0]!.c })));
  expect(f.emptySetsInPrepend).toBe(0);
  expect(f.rsiBefore.map((r) => r.value)).toEqual(range(5, 19).map(() => 50));
  expect(f.rsiLine.data).toEqual(f.rsiBefore);
  expect(f.layer.rows(at(10)).find((row) => row.id === RSI.id)).toMatchObject({ state: "ok", values: [{ text: "50.00" }] });
  expect(f.hiddenLine.data).toEqual([]);
  expect(f.layer.rows(at(10))[1]).toMatchObject({ id: HIDDEN_MA.id, state: "hidden", values: [] });
  expect(f.legendBefore).toMatchObject({ state: "ok" });
  expect(f.legendBefore?.values.map((v) => v.text)).not.toContain("—");
  expect(f.layer.rows(at(10))[0]).toEqual(f.legendBefore);
  expect(f.sent.filter((m) => m.type === "create").map((m) => m.type === "create" && m.gen)).toEqual([1, f.request.gen]);
  expect(f.request.gen).toBeGreaterThan(1);
  expect(Array.from(f.request.cols.t)).toEqual([...OLDER, ...CONFIRMED].map((b) => b.t));
  expect(f.request.engines).toEqual([ICHIMOKU, RSI].map((c) => ({ id: c.id, spec: JSON.stringify(c.spec) })));
  expect(f.volumeLine.data).toEqual(volumeRows([...OLDER, ...CONFIRMED]));

  f.reply(created(1, { conversion: set(range(0, 19), 9), base: set(range(0, 19), 9), spanA: set(range(5, 24), 9), spanB: set(range(5, 24), 9), lagging: set(range(0, 14), 9) }));
  f.reply(tail(1, { conversion: update(20, 9), base: update(20, 9), spanA: update(25, 9), spanB: update(25, 9), lagging: update(15, 9) }));
  f.layer.flush();
  expect(perLine((id) => f.line(id).data)).toEqual(f.drawnAfterPrepend);
  expect(f.layer.rows(at(10))[0]).toEqual(f.legendBefore);

  f.reply(created(f.request.gen, EXTENDED));
  f.layer.flush();
  expect(f.setsSincePrepend()).toEqual(perLine(() => 1));
  expect(realPoints(f)).toEqual(expectedPoints(EXTENDED));
  expect(f.layer.rows(at(-5))[0]).toMatchObject({ state: "ok" });
  expect(f.layer.rows(at(-5))[0]?.values.map((v) => v.text)).not.toContain("—");
});

test("과거 페이지를 붙인 뒤 새 세대가 실패하면 오류로 바꾸고 선을 비운다", () => {
  const f = prependedAfterFirstDraw();
  f.reply({ type: "created", chart: 1, results: [{ id: ICHIMOKU.id, gen: f.request.gen, ok: false, error: "calc", message: "failed" }] });

  expect(f.layer.rows(at(10))[0]).toMatchObject({ state: "calc", values: [] });
  expect(perLine((id) => f.line(id).data)).toEqual(perLine(() => []));
  expect(f.volumeLine.data).toEqual(volumeRows([...OLDER, ...CONFIRMED]));
});

test("과거 페이지를 붙인 뒤 종목을 바꾸면 다른 종목의 응답이 올 때까지 지표 선을 비운다", () => {
  const f = prependedAfterFirstDraw();
  f.layer.clear();
  expect(perLine((id) => f.line(id).data)).toEqual(perLine(() => []));
  const other = range(100, 119).map((m) => bar(m, 105));
  f.layer.reset(history(other));

  expect(perLine((id) => f.line(id).data)).toEqual(perLine(() => []));
  expect(f.layer.rows(at(110))[0]?.state).toBe("pending");
  f.reply(created(f.request.gen, EXTENDED));
  expect(perLine((id) => f.line(id).data)).toEqual(perLine(() => []));
  expect(f.volumeLine.data).toEqual(volumeRows(other));
});

test("그리지 않은 실시간 갱신이 남은 채 과거 페이지를 붙여도, 다음 프레임은 거부되는 갱신 없이 그 점들을 그대로 보인다", () => {
  const f = fixture();
  f.layer.reset(history(CONFIRMED));
  f.reply(created(1));
  f.layer.flush();
  const live = bar(21);
  const previous = bar(20);
  const confirmed = [...CONFIRMED, previous];
  f.layer.advance(history(confirmed), previous, "confirmed");
  f.reply(tail(1, { conversion: update(20, 7) }));
  f.layer.advance(history(confirmed, live), live, "live");
  f.reply(tail(1, { conversion: update(21, 8) }));
  expect(f.sent.filter((m) => m.type === "create")).toHaveLength(1);

  f.layer.prepend(history([...OLDER, ...confirmed], live));
  f.layer.flush();

  expect(f.series.flatMap((s) => s.rejected)).toEqual([]);
  expect(consoleError).not.toHaveBeenCalled();
  expect(f.line("conversion").data.slice(-2)).toEqual([drawn(20, 7, close(20)), drawn(21, 8, close(21))]);
});

test("가격 범례 원천은 주 봉 밖의 이동된 시각과 결측값을 실제 rows 표시와 같은 슬롯으로 담는다", () => {
  const f = fixture();
  f.layer.reset({ bars: CONFIRMED, current: null, nextBefore: null });
  expect(f.layer.priceLegendValues()).toEqual([{ id: "ichi", slots: [] }]);
  f.reply(created(1, { conversion: set(range(0, 19), 123456), base: set(range(0, 19), 1), spanA: set(range(5, 24), 9999999), spanB: set(range(5, 24), -100), lagging: set(range(0, 14), 0.01) }));
  const choices = f.layer.priceLegendValues();
  expect(choices[0]?.slots[2]).toContain("9,999,999");
  expect(choices[0]?.slots[0]).toContain("—");
  for (const t of [null, ...range(0, 24).map(at)]) for (const row of f.layer.rows(t).filter((row) => !row.panel)) {
    row.values.forEach((value, slot) => expect(choices.find((choice) => choice.id === row.id)?.slots[slot]).toContain(value.text));
  }
  expect(f.layer.rows(at(24))[0]?.values[2]?.text).toBe("9,999,999");
  f.layer.clear();
  expect(f.layer.priceLegendValues()).toEqual([{ id: "ichi", slots: [] }]);
  f.layer.setConfigs([], []);
  expect(f.layer.priceLegendValues()).toEqual([]);
  f.layer.dispose();
});


test("가격 범례 원천은 pending·hidden·error·패널 이동과 재계산 뒤의 현재 상태만 남긴다", () => {
  const f = fixture();
  f.layer.reset({ bars: CONFIRMED, current: null, nextBefore: null });
  const check = () => {
    const choices = f.layer.priceLegendValues();
    for (const t of [null, ...range(0, 24).map(at)]) for (const row of f.layer.rows(t).filter((row) => !row.panel)) {
      row.values.forEach((value, i) => expect(choices.find((choice) => choice.id === row.id)?.slots[i]).toContain(value.text));
    }
    return choices;
  };
  expect(check()[0]?.slots).toEqual([]);
  f.reply(created(1));
  expect(check()[0]?.slots).toHaveLength(5);
  f.layer.setConfigs([{ ...ICHIMOKU, visible: false }], []);
  expect(f.layer.rows(at(0))[0]?.state).toBe("hidden");
  expect(check()[0]?.slots).toEqual([]);
  f.layer.setConfigs([ICHIMOKU], []);
  expect(f.layer.rows(at(0))[0]?.state).toBe("pending");
  expect(check()[0]?.slots).toEqual([]);
  f.reply(created(latestCreate(f).gen));
  f.breakWorker();
  expect(f.layer.rows(at(0))[0]?.state).toBe("calc");
  expect(check()[0]?.slots).toEqual([]);
  f.layer.setConfigs([{ ...ICHIMOKU, panel: "p" }], [{ id: "p", stretch: .25 }]);
  expect(check()).toEqual([]);
  f.layer.setConfigs([{ ...ICHIMOKU, panel: "missing" }], []);
  expect(check()).toHaveLength(1);
  f.layer.dispose();
});

test("재무 패널의 실제 등록 시각은 기술 결측값에 포함되고 재무 텍스트는 가격 원천에 들어오지 않는다", () => {
  const financial: IndicatorConfig = { id: "finance", spec: { kind: "debt_ratio" }, panel: "missing", visible: true, style: { colors: ["ind-1"], width: 1 } };
  const f = fixture("Q", [ICHIMOKU, financial]);
  f.layer.reset({ bars: CONFIRMED, current: null, nextBefore: null });
  f.reply(created(1, perLine(() => set(range(0, 19), 1))));
  expect(f.layer.priceLegendValues()[0]?.slots.every((slot) => !slot.includes("—"))).toBe(true);
  const point: FinancialPoint = { businessYear: 2026, reportCode: "11013", status: "available", reason: null, value: 987654321, reportedValue: null, period: { kind: "instant", date: "2026-03-31" }, priceBucket: at(25), basis: "CFS", currency: "KRW", inputs: [] };
  const page: FinancialsPage = { symbol: "005930", period: "Q", status: "ready", reason: null, failure: null, corpCode: null, fiscalMonth: 3, shareClass: null, shareClassReason: null, lastCheckedAt: null, lastAttemptAt: null, disclosureFailure: null, refreshVersion: 0, disclosureVersion: 0, latestCorrections: true, progress: { total: 1, completed: 1, failed: 0, pending: 0 }, series: [{ metric: "debt_ratio", points: [point] }] };
  f.layer.setFinancials(page);
  const choices = f.layer.priceLegendValues();
  expect(choices.map((row) => row.id)).toEqual(["ichi"]);
  expect(choices[0]?.slots.every((slot) => slot.includes("—"))).toBe(true);
  const finance = f.layer.rows(at(25)).find((row) => row.id === "finance");
  expect(finance?.panel).toMatchObject({ index: -1 });
  expect(finance?.values[0]?.text).toContain("987,654,321");
  expect(JSON.stringify(choices)).not.toContain("987,654,321");
  f.layer.setFinancials(null);
  expect(f.layer.priceLegendValues()[0]?.slots.every((slot) => !slot.includes("—"))).toBe(true);
  f.layer.dispose();
});


test.each([false, true])("가격·지수·소수 지표·거래량의 원천 슬롯은 각각의 실제 표시 formatter를 따른다 (지수=%s)", (isIndex) => {
  const configs = [{ ...HIDDEN_MA, visible: true }, { ...RSI, panel: "price" }, { ...VOLUME, panel: "price" }];
  const f = fixture("1m", configs, [], isIndex);
  f.layer.reset({ bars: [{ ...bar(0), v: 2000000 }, { ...bar(1), v: 3000000 }], current: null, nextBefore: null });
  f.reply({ type: "created", chart: 1, results: configs.filter((config) => config.spec.kind !== "volume").map((config) => ({ id: config.id, gen: latestCreate(f).gen, ok: true, lines: specLines(config.spec).filter((id) => id !== "financial").map((id) => ({ id, shift: 0 })), draws: specLines(config.spec).map(() => set([0, 1], 123.456)) })) });
  const choices = f.layer.priceLegendValues();
  expect(choices.find((row) => row.id === HIDDEN_MA.id)?.slots[0]).toContain(isIndex ? "123.46" : "123");
  expect(choices.find((row) => row.id === RSI.id)?.slots[0]).toContain("123.46");
  expect(choices.find((row) => row.id === VOLUME.id)?.slots[0]).toContain("200만");
  for (const t of [null, at(0), at(1)]) for (const row of f.layer.rows(t)) row.values.forEach((value, i) => expect(choices.find((choice) => choice.id === row.id)?.slots[i]).toContain(value.text));
  f.layer.dispose();
});

test("지표 설정을 그리다 차트가 던져도 범례 원천을 다시 만들도록 한 번 요청하고 예외는 그대로 올린다", () => {
  let requested = 0;
  const failing = () => { throw new Error("pane gone"); };
  const chart = { addSeries: failing, addCustomSeries: failing, removeSeries: () => {}, panes: () => [] };
  const layer = new IndicatorLayer(
    { chart: chart as unknown as IChartApi, tokens: () => TOKENS, isIndex: () => false, period: () => "1m", requestFrame: () => { requested++; }, axisFormatted: () => {}, axisCoordinates: () => [], axisFailed: () => {}, guard: (draw) => draw() },
    () => ({ chart: 1, post: () => {}, close: () => {} }),
  );
  expect(() => layer.setConfigs([ICHIMOKU], [])).toThrow("pane gone");
  expect(requested).toBe(1);
  expect(layer.rows(null).map((row) => row.id)).toEqual([ICHIMOKU.id]);
});

test("가격 지표 범례 원천은 끝점 체결만 반영해 같은 모양은 버전을 유지하고 자릿수 증감과 결측 전환은 버전을 올린다", () => {
  const ma: IndicatorConfig = { id: "ma5", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } };
  const overVolume: IndicatorConfig = { ...VOLUME, panel: "price" };
  const f = fixture("1m", [ma, overVolume], []);
  const bars = range(0, 9).map((m) => ({ ...bar(m, 50_000 + m * 100), v: 1_000 + m * 10 }));
  f.layer.reset(history(bars));
  f.reply({ type: "created", chart: 1, results: [{ id: ma.id, gen: latestCreate(f).gen, ok: true, lines: [{ id: "ma", shift: 0 }], draws: [set(range(4, 9), 50_500)] }] });
  const initial = f.layer.priceLegendValues();
  const maValues = initial.find((row) => row.id === ma.id)!.slots[0]!;
  const volValues = initial.find((row) => row.id === overVolume.id)!.slots[0]!;
  const maTracked = trackedValuesOf(maValues)!;
  const volTracked = trackedValuesOf(volValues)!;
  expect(maValues).toEqual(["50,500", "50,500", "50,500", "50,500", "50,500", "50,500", "—"]);
  expect(volValues.at(-1)).toBe("1,090");
  const maVersion = maTracked.shapeVersion;
  const volVersion = volTracked.shapeVersion;

  const live1 = { ...bar(10, 51_000), v: 1_200 };
  f.layer.advance(history(bars, live1), live1, "live");
  f.reply({ type: "tail", chart: 1, results: [{ id: ma.id, gen: latestCreate(f).gen, ok: true, draws: [update(10, 51_200)] }] });
  expect(f.layer.priceLegendValues().find((row) => row.id === ma.id)!.slots[0]).toEqual(["50,500", "50,500", "50,500", "50,500", "50,500", "50,500", "51,200", "—"]);
  expect(maTracked.shapeVersion).toBe(maVersion);
  expect(volTracked.shapeVersion).toBe(volVersion);

  const live2 = { ...bar(10, 120_000), v: 250_000 };
  f.layer.advance(history(bars, live2), live2, "live");
  f.reply({ type: "tail", chart: 1, results: [{ id: ma.id, gen: latestCreate(f).gen, ok: true, draws: [update(10, 120_000)] }] });
  expect(f.layer.priceLegendValues().find((row) => row.id === ma.id)!.slots[0]!.slice(-2)).toEqual(["120,000", "—"]);
  expect(f.layer.priceLegendValues().find((row) => row.id === overVolume.id)!.slots[0]!.at(-1)).toBe("25만");
  expect(maTracked.shapeVersion).toBe(maVersion + 1);
  expect(volTracked.shapeVersion).toBe(volVersion + 1);

  const live3 = { ...bar(10, 52_000), v: 1_500 };
  f.layer.advance(history(bars, live3), live3, "live");
  f.reply({ type: "tail", chart: 1, results: [{ id: ma.id, gen: latestCreate(f).gen, ok: true, draws: [update(10, 52_000)] }] });
  expect(f.layer.priceLegendValues().find((row) => row.id === ma.id)!.slots[0]!.slice(-2)).toEqual(["52,000", "—"]);
  expect(f.layer.priceLegendValues().find((row) => row.id === overVolume.id)!.slots[0]!.at(-1)).toBe("1,500");
  expect(maTracked.shapeVersion).toBe(maVersion + 2);
  expect(volTracked.shapeVersion).toBe(volVersion + 2);
  f.layer.dispose();
});

const TOTALS: IndicatorConfig = { id: "totals", spec: { kind: "quoteTotals" }, panel: "quotes", visible: true, style: { colors: ["ind-1"], width: 1 } };

function totalsView(values: Record<number, [number, number]>, state: QuoteState = "ready"): QuoteView<QuoteTotalPoint> {
  const points = new Map(Object.entries(values).map(([minute, [ask, bid]]) => [at(Number(minute)), { t: at(Number(minute)), ask, bid }]));
  return { state, at: (t) => points.get(t) };
}

function totalsFixture(minutes: number[]) {
  const f = fixture("1m", [TOTALS], [{ id: "quotes", stretch: 0.25 }]);
  f.layer.reset({ bars: minutes.map((m) => bar(m)), current: null, nextBefore: null });
  const [ask, bid] = f.series as [FakeSeries, FakeSeries];
  return { ...f, ask, bid };
}

const totalAt = (minute: number, value: number, extra: { break?: true } = {}): Datum => ({ time: toChartTime(at(minute)), value, base: value, ...extra });
const optionsOf = (s: FakeSeries) => Object.assign({}, ...s.options) as { color?: string; lineWidth?: number };

test("총잔량 선은 봉이 있는 자리에 그리고 빈 봉에서 끊는다", () => {
  const f = totalsFixture(range(0, 5));
  f.layer.setQuoteTotals(totalsView({ 0: [10, 20], 1: [11, 21], 3: [13, 23], 4: [14, 24], 99: [1, 1] }));
  f.layer.flush();
  expect(f.ask.data).toEqual([totalAt(0, 10), totalAt(1, 11), totalAt(3, 13, { break: true }), totalAt(4, 14)]);
  expect(f.bid.data).toEqual([totalAt(0, 20), totalAt(1, 21), totalAt(3, 23, { break: true }), totalAt(4, 24)]);
  expect([optionsOf(f.ask).color, optionsOf(f.bid).color]).toEqual([TOKENS.down, TOKENS.up]);
  expect([optionsOf(f.ask).lineWidth, optionsOf(f.bid).lineWidth]).toEqual([2, 2]);
  expect([f.ask.pane, f.bid.pane]).toEqual([1, 1]);
  expect(f.sent.filter((m) => m.type === "create")).toEqual([]);

  f.layer.setQuoteTotals(totalsView({ 2: [12, 22] }));
  f.layer.flush();
  expect(f.ask.data).toEqual([totalAt(2, 12, { break: true })]);
  f.layer.setQuoteTotals(null);
  f.layer.flush();
  expect([f.ask.data, f.bid.data]).toEqual([[], []]);
});

test("총잔량 꼬리가 바뀌면 바뀐 봉만 고쳐 그린다", () => {
  const f = totalsFixture(range(0, 5));
  const values: Record<number, [number, number]> = { 0: [10, 20], 1: [11, 21], 2: [12, 22], 3: [13, 23], 4: [14, 24], 5: [15, 25] };
  f.layer.setQuoteTotals(totalsView(values));
  f.layer.flush();
  const sets = f.ask.setDataCalls;
  f.layer.setQuoteTotals(totalsView({ ...values, 4: [44, 24], 5: [55, 65], 6: [16, 26] }), at(4));
  f.layer.flush();
  expect(f.ask.data.slice(3)).toEqual([totalAt(3, 13), totalAt(4, 44), totalAt(5, 55)]);
  expect(f.bid.data[5]).toEqual(totalAt(5, 65));

  const six = bar(6);
  f.layer.advance({ bars: range(0, 5).map((m) => bar(m)), current: six, nextBefore: null }, six, "live");
  f.layer.flush();
  expect(lastOf(f.ask)).toEqual(totalAt(6, 16));
  const eight = bar(8);
  f.layer.advance({ bars: [...range(0, 6).map((m) => bar(m))], current: eight, nextBefore: null }, eight, "live");
  f.layer.flush();
  expect(lastOf(f.ask)).toEqual(totalAt(6, 16));
  expect(f.ask.setDataCalls).toBe(sets);
  expect(f.ask.rejected).toEqual([]);

  f.layer.setQuoteTotals(totalsView({ ...values, 4: [44, 24] }), at(5));
  f.layer.flush();
  expect(f.ask.data.map((d) => d.value)).toEqual([10, 11, 12, 13, 44, 15]);
});

test("총잔량 범례는 값과 수집하지 않는 종목을 알린다", () => {
  const f = totalsFixture(range(0, 5));
  const row = () => f.layer.rows(at(3)).find((r) => r.id === "totals")!;
  f.layer.setQuoteTotals(totalsView({}, "loading"));
  expect(row().state).toBe("pending");
  f.layer.setQuoteTotals(totalsView({ 3: [61_287, 110_859] }));
  expect(row()).toMatchObject({ name: "총잔량", state: "ok" });
  expect(row().values).toEqual([{ text: formatVolume(61_287), color: TOKENS.down }, { text: formatVolume(110_859), color: TOKENS.up }]);
  f.layer.setQuoteTotals(totalsView({}));
  expect(row().values.map((v) => v.text)).toEqual(["—", "—"]);
  f.layer.setQuoteTotals(totalsView({}, "notCollected"));
  expect(row().values.map((v) => v.text)).toEqual(["수집하지 않는 종목"]);
  f.layer.setQuoteTotals(totalsView({}, "disabled"));
  expect(row().values.map((v) => v.text)).toEqual(["수집 폴더 미설정"]);
  f.layer.setQuoteTotals(totalsView({}, "failed"));
  expect(row().values.map((v) => v.text)).toEqual(["호가 자료 조회 실패"]);
});

const DEPTH: IndicatorConfig = { id: "heat", spec: { kind: "quoteDepth", source: "priceMax", topLevels: null, maxOpacity: 0.7, aboveBars: false, askColor: null, bidColor: null }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } };

function depthView(points: Record<number, Pick<QuoteDepthPoint, "asks" | "bids">>, state: QuoteState = "ready"): QuoteView<QuoteDepthPoint> {
  const known = new Map(Object.entries(points).map(([minute, sides]) => [at(Number(minute)), { t: at(Number(minute)), ...sides }]));
  return { state, at: (t) => known.get(t) };
}

test("히트맵 범례는 가장 두꺼운 매도·매수 단을 알린다", () => {
  const f = fixture("1m", [DEPTH], []);
  f.layer.reset({ bars: range(0, 5).map((m) => bar(m)), current: null, nextBefore: null });
  const row = () => f.layer.rows(at(3)).find((r) => r.id === "heat")!;
  const show = (view: QuoteView<QuoteDepthPoint>) => f.layer.setQuoteDepths(new Map([["heat", view]]));
  show(depthView({}, "loading"));
  expect(row().state).toBe("pending");
  show(depthView({ 3: { asks: [[193_300, 9_000], [193_400, 9_000], [193_500, 10]], bids: [[193_200, 5], [193_100, 12_345]] } }));
  expect(row()).toMatchObject({ name: "호가 잔량 히트맵", state: "ok", panel: null });
  expect(row().values).toEqual([
    { text: `${formatPrice(193_300, false)} ${formatVolume(9_000)}`, color: TOKENS.down },
    { text: `${formatPrice(193_100, false)} ${formatVolume(12_345)}`, color: TOKENS.up },
  ]);
  show(depthView({}));
  expect(row().values.map((v) => v.text)).toEqual(["—", "—"]);
  show(depthView({}, "notCollected"));
  expect(row().values.map((v) => v.text)).toEqual(["수집하지 않는 종목"]);
  show(depthView({}, "disabled"));
  expect(row().values.map((v) => v.text)).toEqual(["수집 폴더 미설정"]);
  show(depthView({}, "failed"));
  expect(row().values.map((v) => v.text)).toEqual(["호가 자료 조회 실패"]);

  const teal = normalizeHex("#4FC7B8")!;
  f.layer.setConfigs([{ ...DEPTH, spec: { ...DEPTH.spec, askColor: teal } as IndicatorConfig["spec"] }], []);
  show(depthView({ 3: { asks: [[193_300, 1]], bids: [] } }));
  expect(row().values).toEqual([{ text: `${formatPrice(193_300, false)} ${formatVolume(1)}`, color: teal }, { text: "—", color: TOKENS.up }]);
});

test("히트맵은 선을 만들지 않고 설정을 바꿔도 다른 선을 다시 만들지 않는다", () => {
  const f = fixture("1m", [ICHIMOKU, DEPTH], []);
  f.layer.reset({ bars: CONFIRMED, current: null, nextBefore: null });
  expect(f.series).toHaveLength(LINES.length);
  for (const maxOpacity of [0.5, 0.3, 0.9]) f.layer.setConfigs([ICHIMOKU, { ...DEPTH, spec: { ...DEPTH.spec, maxOpacity } as IndicatorConfig["spec"] }], []);
  f.layer.setConfigs([ICHIMOKU, { ...DEPTH, visible: false }], []);
  expect(f.series).toHaveLength(LINES.length);
  expect(f.active).toHaveLength(LINES.length);
  expect(f.sent.filter((m) => m.type === "create").every((m) => m.type === "create" && m.engines.every((engine) => engine.id === "ichi"))).toBe(true);
});

test("분봉과 일봉 전환으로 히트맵이나 끝 패널 총잔량이 드나들어도 기존 가격·패널 지표 선은 다시 만들지 않는다", () => {
  const intradayPanels: Panel[] = [...VOLUME_PANELS, { id: "quotes", stretch: 0.25 }];
  const intradayConfigs: IndicatorConfig[] = [ICHIMOKU, DEPTH, VOLUME, TOTALS];
  const dailyConfigs: IndicatorConfig[] = [ICHIMOKU, VOLUME];
  const f = fixture("1m", intradayConfigs, intradayPanels);
  const keptBefore = [...f.active.slice(0, LINES.length + 1)];
  const totalCreated = f.series.length;

  f.layer.setConfigs(dailyConfigs, VOLUME_PANELS);
  expect(f.active).toEqual(keptBefore);
  expect(f.series).toHaveLength(totalCreated);

  f.layer.setConfigs(intradayConfigs, intradayPanels);
  expect(f.active.slice(0, LINES.length + 1)).toEqual(keptBefore);
  expect(f.active).toHaveLength(LINES.length + 3);
  expect(f.active.slice(-2).map((s) => s.pane)).toEqual([2, 2]);
  expect(f.series).toHaveLength(totalCreated + 2);
});
