import type { IChartApi } from "lightweight-charts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { History } from "../barFeed";
import type { IndicatorConfig } from "../settings";
import type { ThemeTokens } from "../theme";
import { toChartTime } from "../time";
import type { PortListener } from "./client";
import { specLines } from "./kinds";
import { IndicatorLayer } from "./layer";
import type { FromWorker, LineDraw, ToWorker } from "./protocol";

interface Datum {
  time: number;
  value: number;
}

class FakeSeries {
  data: Datum[] = [];
  setDataCalls = 0;
  readonly rejected: string[] = [];
  failNextUpdate = false;

  setData(data: Datum[]): void {
    this.data = [...data];
    this.setDataCalls++;
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

  applyOptions(): void {}
  priceScale() {
    return { applyOptions() {} };
  }
  createPriceLine() {
    return { applyOptions() {} };
  }
}

const TOKENS = { text2: "text2", line: "line", upVol: "upVol", downVol: "downVol", ind: {} } as unknown as ThemeTokens;

const T0 = Date.parse("2026-11-09T09:00:00+09:00") / 1000;
const at = (minute: number): UnixSeconds => T0 + minute * 60;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const bar = (minute: number, c = 100): Bar => ({ t: at(minute), o: 100, h: 110, l: 90, c, v: 1000 });
const set = (minutes: number[], v: number): LineDraw => ({ op: "set", points: minutes.map((m) => ({ t: at(m), v })) });
const update = (minute: number, v: number): LineDraw => ({ op: "update", point: { t: at(minute), v } });
const drawn = (minute: number, value: number): Datum => ({ time: toChartTime(at(minute)), value });

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

function fixture() {
  expect(specLines(ICHIMOKU.spec)).toEqual(LINES);
  const series: FakeSeries[] = [];
  const sent: ToWorker[] = [];
  const port: { listener?: PortListener } = {};
  const chart = {
    addSeries: () => {
      const s = new FakeSeries();
      series.push(s);
      return s;
    },
    removeSeries: () => {},
    panes: () => [],
  };
  const layer = new IndicatorLayer(
    { chart: chart as unknown as IChartApi, tokens: () => TOKENS, isIndex: () => false, period: () => "1m", requestFrame: () => {}, guard: (draw) => draw() },
    (listener) => {
      port.listener = listener;
      return { chart: 1, post: (m) => sent.push(m), close: () => {} };
    },
  );
  layer.setConfigs([ICHIMOKU], []);
  const reply = (m: Exclude<FromWorker, { type: "fatal" }>) => port.listener?.message(structuredClone(m));
  const line = (id: Line) => series[LINES.indexOf(id)]!;
  return { layer, series, line, sent, reply };
}

interface Step {
  minute: number;
  kind: "live" | "confirmed";
  draws: Draws;
}

type Fixture = ReturnType<typeof fixture>;

function feedTails(steps: Step[], flushEach: boolean, beforeLastFlush: (f: Fixture) => void = () => {}) {
  const f = fixture();
  let bars = CONFIRMED;
  f.layer.reset({ bars, current: null, nextBefore: null });
  f.reply(created(1));
  const setsBefore = perLine((id) => f.line(id).setDataCalls);
  for (const step of steps) {
    const b = bar(step.minute, 100 + step.minute);
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
    conversion: drawn(22, 4),
    base: drawn(22, 4),
    spanA: drawn(27, 4),
    spanB: drawn(27, 4),
    lagging: drawn(16, 4),
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
  expect(lastOf(once.line("spanA"))).toEqual({ time: toChartTime(last.point.t), value: last.point.v });
});

test("한 선의 update가 실패해도 같은 프레임의 다른 선은 그리고, 실패한 선만 점 사본으로 다시 맞춘다", () => {
  const steps: Step[] = [{ minute: 20, kind: "live", draws: { conversion: update(20, 2), base: update(20, 2), spanA: update(25, 2), spanB: update(25, 2), lagging: update(15, 2) } }];
  const each = feedTails(steps, true);
  const once = feedTails(steps, false, (f) => {
    f.line("conversion").failNextUpdate = true;
  });

  expect(once.data()).toEqual(each.data());
  expect(once.setsInFrame()).toEqual({ conversion: 1, base: 0, spanA: 0, spanB: 0, lagging: 0 });
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
