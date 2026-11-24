import type { IChartApi } from "lightweight-charts";
import { expect, test } from "vitest";
import type { BarsQuery, SeriesKey } from "../api/bars";
import type { Bar } from "../api/generated/Bar";
import type { BarsPage } from "../api/generated/BarsPage";
import { ApiRequestError } from "../api/http";
import type { SubEvent } from "../api/socket";
import type { ShownVenue } from "../lib/venue";
import { alignToMain, COMPARE_NOTE, CompareLayer, compareVenue, MAX_COVER_PAGES } from "./compare";
import { trackedValuesOf } from "./legendShapes";
import type { ThemeTokens } from "./theme";
import { fromChartTime } from "./time";

const bar = (t: number, c = 100 + t): Bar => ({ t, o: c, h: c, l: c, c, v: 1 });
const bars = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => bar(from + i));
const ts = (xs: readonly { t: number }[]) => xs.map((b) => b.t);

class FakeSeries {
  times: number[] = [];
  values: number[] = [];
  setData(data: { time: number; value: number }[]): void {
    this.times = data.map((d) => fromChartTime(d.time as never));
    this.values = data.map((d) => d.value);
  }
  update(d: { time: number; value: number }): void {
    const t = fromChartTime(d.time as never);
    const last = this.times[this.times.length - 1];
    if (last !== undefined && t < last) throw new Error("Cannot update oldest data");
    if (last === t) this.values[this.values.length - 1] = d.value;
    else {
      this.times.push(t);
      this.values.push(d.value);
    }
  }
  applyOptions(): void {}
}

function fixture(pages: (q: BarsQuery) => BarsPage | Promise<BarsPage>) {
  const series: FakeSeries[] = [];
  const removed: FakeSeries[] = [];
  const subs = new Map<number, { key: SeriesKey; handler: (m: SubEvent) => void }>();
  const fetched: BarsQuery[] = [];
  let nextSub = 0;
  let main: Bar[] = [];
  const chart = {
    addSeries: () => {
      const s = new FakeSeries();
      series.push(s);
      return s;
    },
    removeSeries: (s: FakeSeries) => removed.push(s),
  };
  const tokens = { cmp: { 1: "c1", 2: "c2", 3: "c3" } } as unknown as ThemeTokens;
  const layer = new CompareLayer(
    { chart: chart as unknown as IChartApi, tokens: () => tokens, requestFrame: () => {}, guard: (f) => f() },
    async (q) => {
      fetched.push(q);
      return pages(q);
    },
    {
      subscribe(key, handler) {
        const id = nextSub++;
        subs.set(id, { key, handler });
        return () => subs.delete(id);
      },
    },
  );
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    layer,
    series,
    removed,
    fetched,
    settle,
    subscribed: () => [...subs.values()].map((s) => `${s.key.symbol}/${s.key.venue}/${s.key.period}`),
    push: (symbol: string, m: SubEvent) => [...subs.values()].filter((s) => s.key.symbol === symbol).forEach((s) => s.handler(m)),
    mainTimes: () => new Set(ts(main)),
    flush: () => layer.flush(main),
    setMain(next: Bar[]) {
      main = next;
      layer.realign(main);
    },
    appendMain(b: Bar) {
      main = main[main.length - 1]?.t === b.t ? [...main.slice(0, -1), b] : [...main, b];
    },
  };
}

const page = (symbol: string, b: Bar[], nextBefore: number | null, current: Bar | null = null, seq: number | null = null): BarsPage => ({
  symbol,
  venue: "combined",
  period: "1m",
  bars: b,
  current,
  nextBefore,
  seq,
});

const key = { period: "1m" as const, venueFor: () => "combined" as const };
const entry = (code: string, slot: 1 | 2 | 3 = 1) => ({ code, slot, name: code });

test("비교 봉은 주 봉에 있는 시각만 남긴다", () => {
  const main = [bar(2), bar(3), bar(5), bar(8)];
  expect(ts(alignToMain([bar(1), bar(2), bar(4), bar(5), bar(8), bar(9)], main))).toEqual([2, 5, 8]);
  expect(alignToMain(bars(1, 9), [])).toEqual([]);
});

test("비교 종목의 거래소는 지수면 없고, 주 종목이 KRX이거나 지수면 KRX, 그 밖에는 통합이다", () => {
  const krx = "krx" as ShownVenue;
  const nxt = "nxt" as ShownVenue;
  expect(compareVenue("IDX:001", { symbol: "005930", venue: krx })).toBeNull();
  expect(compareVenue("000660", { symbol: "005930", venue: krx })).toBe("krx");
  expect(compareVenue("000660", { symbol: "IDX:001", venue: null })).toBe("krx");
  expect(compareVenue("000660", { symbol: "005930", venue: nxt })).toBe("combined");
  expect(compareVenue("000660", { symbol: "005930", venue: "combined" as ShownVenue })).toBe("combined");
});

test("비교 종목마다 구독 하나를 잡고, 빼면 풀고 시리즈를 지운다", async () => {
  const f = fixture((q) => page(q.symbol, bars(1, 5), null));
  f.layer.setCodes([entry("000660"), entry("IDX:001", 2)], key);
  expect(f.subscribed()).toEqual(["000660/combined/1m", "IDX:001/combined/1m"]);
  f.layer.setCodes([entry("IDX:001", 1)], key);
  expect(f.subscribed()).toEqual(["IDX:001/combined/1m"]);
  expect(f.removed).toEqual([f.series[0]]);
  f.layer.dispose();
  expect(f.subscribed()).toEqual([]);
});

test("봉 주기가 바뀌면 옛 구독을 풀고 새 키로 다시 받으며, 옛 키의 늦은 응답은 버린다", async () => {
  let release!: (p: BarsPage) => void;
  const f = fixture((q) => (q.period === "1m" ? new Promise((r) => (release = r)) : page(q.symbol, bars(1, 3), null)));
  f.setMain(bars(1, 5));
  f.layer.setCodes([entry("000660")], key);
  f.layer.setCodes([entry("000660")], { ...key, period: "5m" });
  expect(f.subscribed()).toEqual(["000660/combined/5m"]);
  await f.settle();
  release(page("000660", bars(1, 5).map((b) => ({ ...b, c: 999 })), null));
  await f.settle();
  f.flush();
  expect(f.series[0]!.times).toEqual([1, 2, 3]);
  expect(f.series[0]!.values).not.toContain(999);
});

test("주 시리즈를 비우면 비교 시리즈도 비운다", async () => {
  const f = fixture((q) => page(q.symbol, bars(1, 5), null));
  f.setMain(bars(1, 5));
  f.layer.setCodes([entry("000660")], key);
  await f.settle();
  f.flush();
  expect(f.series[0]!.times).toEqual([1, 2, 3, 4, 5]);
  f.setMain([]);
  expect(f.series[0]!.times).toEqual([]);
});

test("비교 시리즈는 어떤 순서로 체결이 와도 주 시리즈에 없는 시각을 갖지 않는다", async () => {
  const f = fixture((q) => page(q.symbol, bars(1, 5), null, bar(6), 0));
  f.setMain(bars(1, 6));
  f.layer.setCodes([entry("000660")], key);
  await f.settle();
  f.flush();
  const s = f.series[0]!;
  const check = () => {
    f.flush();
    const mainTimes = f.mainTimes();
    expect(s.times.every((t) => mainTimes.has(t))).toBe(true);
  };
  check();
  let seq = 1;
  const cmp = (type: "bar" | "confirmed", b: Bar) => f.push("000660", { type, sub: "s", seq: seq++, bar: b });
  cmp("bar", bar(7, 70));
  check();
  expect(s.times.at(-1)).toBe(6);
  f.appendMain(bar(7));
  check();
  expect(s.times.at(-1)).toBe(7);
  expect(s.values.at(-1)).toBe(70);
  cmp("confirmed", bar(7, 71));
  cmp("bar", bar(8, 80));
  cmp("confirmed", bar(8, 81));
  cmp("bar", bar(9, 90));
  check();
  f.appendMain(bar(9));
  check();
  expect(s.times.slice(-3)).toEqual([6, 7, 9]);
  expect(s.values.slice(-2)).toEqual([71, 90]);
  f.appendMain(bar(10));
  cmp("bar", bar(10, 100));
  check();
  expect(s.times.at(-1)).toBe(10);
});

test("보이는 왼쪽 끝까지 과거 페이지를 하나씩 잇는다", async () => {
  const f = fixture((q) => {
    const end = q.before ?? 101;
    return page(q.symbol, bars(Math.max(1, end - 10), end - 1), end - 10 > 1 ? end - 10 : null);
  });
  f.setMain(bars(1, 100));
  f.layer.setCodes([entry("000660")], key);
  await f.settle();
  f.layer.coverFrom(70);
  for (let i = 0; i < 5; i++) await f.settle();
  f.flush();
  expect(f.fetched.map((q) => q.before ?? null)).toEqual([null, 91, 81, 71]);
  expect(f.series[0]!.times[0]).toBe(61);
  expect(f.layer.rows(70, 100)[0]!.notes).toEqual([]);
});

test(`덮기 시도 한 번에 ${MAX_COVER_PAGES}페이지까지만 잇고, 못 덮으면 이유를 보이고, 왼쪽 끝이 바뀌면 다시 시도한다`, async () => {
  const f = fixture((q) => {
    const end = q.before ?? 10_001;
    return page(q.symbol, bars(end - 10, end - 1), end - 10);
  });
  f.setMain(bars(1, 10_000));
  f.layer.setCodes([entry("000660")], key);
  await f.settle();
  f.layer.coverFrom(100);
  for (let i = 0; i < MAX_COVER_PAGES + 5; i++) await f.settle();
  expect(f.fetched).toHaveLength(1 + MAX_COVER_PAGES);
  f.flush();
  expect(f.layer.rows(100, 10_000)[0]!.notes).toEqual([COMPARE_NOTE.base]);
  f.layer.coverFrom(100);
  await f.settle();
  expect(f.fetched).toHaveLength(1 + MAX_COVER_PAGES);
  f.layer.coverFrom(99);
  for (let i = 0; i < 3; i++) await f.settle();
  expect(f.fetched.length).toBeGreaterThan(1 + MAX_COVER_PAGES);
});

test("범례 값은 왼쪽 끝 봉 이후 첫 점을 0%로 잡고, 그 시각에 점이 없으면 직전 점을 쓴다", async () => {
  const f = fixture((q) => page(q.symbol, [bar(2, 100), bar(3, 110), bar(5, 120)], null));
  f.setMain(bars(1, 6));
  f.layer.setCodes([entry("000660")], key);
  await f.settle();
  f.flush();
  expect(f.layer.rows(1, 3)[0]!.value).toBe("+10.00%");
  expect(f.layer.rows(3, 5)[0]!.value).toBe("+9.09%");
  expect(f.layer.rows(3, 6)[0]!.value).toBe("+9.09%");
  expect(f.layer.rows(6, 6)[0]!.value).toBe("—");
});

test("최신 페이지를 받지 못하면 그 줄에 남기고, 다시 시도하면 그 종목만 다시 받는다", async () => {
  let fail = true;
  const f = fixture((q) => {
    if (q.symbol === "000660" && fail) throw new ApiRequestError("internal", "x");
    return page(q.symbol, bars(1, 3), null);
  });
  f.setMain(bars(1, 3));
  f.layer.setCodes([entry("000660"), entry("035420", 2)], key);
  await f.settle();
  expect(f.layer.rows(1, 3).map((r) => [r.notes, r.failed])).toEqual([[[COMPARE_NOTE.failed], true], [[], false]]);
  fail = false;
  f.layer.reload();
  await f.settle();
  f.flush();
  expect(f.fetched.map((q) => q.symbol)).toEqual(["000660", "035420", "000660"]);
  expect(f.layer.rows(1, 3).map((r) => r.notes)).toEqual([[], []]);
  expect(f.series[0]!.times).toEqual([1, 2, 3]);
});

test("실시간 구독이 거절되면 그 줄에 실시간 아님을 붙인다", async () => {
  const f = fixture((q) => page(q.symbol, bars(1, 3), null));
  f.setMain(bars(1, 3));
  f.layer.setCodes([entry("000660")], key);
  await f.settle();
  f.push("000660", { type: "sub_error", sub: "s", code: "realtime_limit" });
  expect(f.layer.rows(1, 3)[0]!.notes).toEqual([COMPARE_NOTE.limited]);
});

test("목록에 없는 비교 종목은 찾을 수 없음으로 남긴다", async () => {
  const f = fixture((q) => {
    if (q.symbol === "999999") throw new ApiRequestError("unknown_symbol", "x");
    return page(q.symbol, bars(1, 3), null);
  });
  f.setMain(bars(1, 3));
  f.layer.setCodes([entry("999999")], key);
  await f.settle();
  f.flush();
  expect(f.layer.rows(1, 3)[0]).toMatchObject({ notes: [COMPARE_NOTE.missing], failed: true, value: "—" });
  expect(f.series[0]!.times).toEqual([]);
});

test("비교 범례 원천은 실제 기준과 정렬된 봉의 모든 표시값 및 null을 포함하고 제거시 줄어든다", async () => {
  const f = fixture((q) => page(q.symbol, [bar(2, 100), bar(4, 10000), bar(6, 1), bar(9, 999999)], null));
  const main = bars(1, 8);
  f.setMain(main);
  f.layer.setCodes([entry("000660"), entry("035420", 2)], key);
  await f.settle();
  f.flush();
  for (const left of [null, 1, 3, 5, 8]) {
    const choices = f.layer.legendValues(left);
    for (const t of [null, ...ts(main)]) for (const row of f.layer.rows(left, t)) {
      expect(choices.find((choice) => choice.code === row.code)?.values).toContain(row.value);
    }
  }
  expect(f.layer.legendValues(1)[0]?.values).toContain("+9,900.00%");
  expect(f.layer.legendValues(5)[0]?.values).not.toContain("+9,900.00%");
  expect(f.layer.legendValues(null).every((row) => row.values.join() === "—")).toBe(true);
  f.layer.setCodes([], key);
  expect(f.layer.legendValues(1)).toEqual([]);
  f.layer.dispose();
});


test("비교 범례 원천은 loading·실패·제한·기준 안내와 현재 formatter의 null 의미를 보존한다", async () => {
  let reject = false;
  const f = fixture((q) => {
    if (reject) throw new ApiRequestError("unknown_symbol", "missing");
    return page(q.symbol, bars(3, 6), null);
  });
  f.setMain(bars(1, 8));
  f.layer.setCodes([entry("000660")], key);
  expect(f.layer.rows(1, null)[0]).toMatchObject({ value: "—", notes: [] });
  expect(f.layer.legendValues(1)[0]?.values).toEqual(["—"]);
  await f.settle();
  f.flush();
  expect(f.layer.rows(1, 4)[0]?.notes).toContain(COMPARE_NOTE.base);
  f.push("000660", { type: "sub_error", sub: "s", code: "realtime_limit" });
  expect(f.layer.rows(1, 4)[0]?.notes).toContain(COMPARE_NOTE.limited);
  for (const t of [null, 1, 4, 8]) expect(f.layer.legendValues(1)[0]?.values).toContain(f.layer.rows(1, t)[0]?.value);
  reject = true;
  f.layer.setCodes([entry("000660")], { ...key, period: "5m" });
  await f.settle();
  f.flush();
  expect(f.layer.rows(1, 4)[0]).toMatchObject({ value: "—", failed: true, notes: [COMPARE_NOTE.missing] });
  expect(f.layer.legendValues(1)[0]?.values).toEqual(["—"]);
  f.layer.dispose();
});

test("비교 범례 원천은 끝점 체결만 갱신하고 같은 모양은 버전을 유지하며 자릿수 증감과 왼쪽 끝 변경은 버전을 올린다", async () => {
  const f = fixture((q) => page(q.symbol, [bar(1, 100), bar(2, 105), bar(3, 110)], null, bar(4, 112), 0));
  f.setMain(bars(1, 4));
  f.layer.setCodes([entry("000660")], key);
  await f.settle();
  f.flush();
  const initial = f.layer.legendValues(1)[0]!.values;
  const tracked = trackedValuesOf(initial)!;
  expect(tracked).not.toBeNull();
  const baseVersion = tracked.shapeVersion;
  expect(initial).toEqual(["—", "0.00%", "+5.00%", "+10.00%", "+12.00%"]);
  f.push("000660", { type: "bar", sub: "s", seq: 1, bar: bar(4, 118) });
  f.flush();
  expect(f.layer.legendValues(1)[0]!.values).toEqual(["—", "0.00%", "+5.00%", "+10.00%", "+18.00%"]);
  expect(tracked.shapeVersion).toBe(baseVersion);
  f.push("000660", { type: "bar", sub: "s", seq: 2, bar: bar(4, 250) });
  f.flush();
  expect(f.layer.legendValues(1)[0]!.values).toEqual(["—", "0.00%", "+5.00%", "+10.00%", "+150.00%"]);
  expect(tracked.shapeVersion).toBe(baseVersion + 1);
  f.push("000660", { type: "bar", sub: "s", seq: 3, bar: bar(4, 115) });
  f.flush();
  expect(f.layer.legendValues(1)[0]!.values).toEqual(["—", "0.00%", "+5.00%", "+10.00%", "+15.00%"]);
  expect(tracked.shapeVersion).toBe(baseVersion + 2);
  f.appendMain(bar(5));
  f.push("000660", { type: "confirmed", sub: "s", seq: 4, bar: bar(4, 115) });
  f.push("000660", { type: "bar", sub: "s", seq: 5, bar: bar(5, 119) });
  f.flush();
  expect(f.layer.legendValues(1)[0]!.values).toEqual(["—", "0.00%", "+5.00%", "+10.00%", "+15.00%", "+19.00%"]);
  expect(tracked.shapeVersion).toBe(baseVersion + 2);
  const shifted = f.layer.legendValues(2)[0]!.values;
  expect(shifted).toEqual(["—", "0.00%", "+4.76%", "+9.52%", "+13.33%"]);
  expect(tracked.shapeVersion).toBe(baseVersion + 3);
  f.layer.dispose();
});
