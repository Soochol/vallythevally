import { expect, test } from "vitest";
import type { BarsQuery, SeriesKey } from "../api/bars";
import type { Bar } from "../api/generated/Bar";
import type { BarsPage } from "../api/generated/BarsPage";
import { ApiRequestError } from "../api/http";
import type { SubEvent } from "../api/socket";
import type { FineSpan } from "./drawings/finePeriod";
import { FineBars, MAX_FINE_PAGES } from "./fineBars";

const kst = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) / 1000 - 9 * 3600;
const NOW = kst(2026, 11, 13, 15);
const MIN = 60;
const PAGE_BARS = 10;

const bar = (t: number, c = 100): Bar => ({ t, o: c, h: c, l: c, c, v: 1 });
const ts = (xs: readonly { t: number }[]) => xs.map((b) => b.t);

function minutePage(q: BarsQuery, last: number | null = null): BarsPage {
  const before = q.before ?? NOW;
  const bars = Array.from({ length: PAGE_BARS }, (_, i) => bar(before - (PAGE_BARS - i) * MIN));
  const first = bars[0]!.t;
  return { symbol: q.symbol, venue: q.venue, period: q.period, bars, current: null, nextBefore: last !== null && first <= last ? null : first, seq: null };
}

const daily: SeriesKey = { symbol: "005930", venue: "combined", period: "D" };

function fixture(pages: (q: BarsQuery) => BarsPage | Promise<BarsPage> = (q) => minutePage(q), key: SeriesKey = daily) {
  const fetched: BarsQuery[] = [];
  const subs = new Map<number, { key: SeriesKey; handler: (m: SubEvent) => void }>();
  let nextSub = 0;
  let notified = 0;
  const store = new FineBars(
    async (q) => {
      fetched.push(q);
      return pages(q);
    },
    {
      subscribe(k, handler) {
        const id = nextSub++;
        subs.set(id, { key: k, handler });
        return () => subs.delete(id);
      },
    },
    () => NOW,
  );
  store.open(key);
  store.subscribe(() => notified++);
  return {
    store,
    fetched,
    settle: () => new Promise((r) => setTimeout(r, 0)),
    notified: () => notified,
    subscribed: () => [...subs.values()].map((s) => `${s.key.symbol}/${s.key.venue}/${s.key.period}`),
    push: (m: SubEvent) => [...subs.values()].forEach((s) => s.handler(m)),
  };
}

const span = (from: number, to = NOW + MIN): FineSpan => ({ from, to });
const recent = span(NOW - 25 * MIN);
const befores = (qs: readonly BarsQuery[]) => qs.map((q) => q.before ?? null);

test("세부 봉 주기의 과거 페이지를 구간 시작에 닿을 때까지만 받는다", async () => {
  const f = fixture();
  f.store.demand([recent, span(NOW - 5 * MIN)]);
  await f.settle();
  expect(f.fetched.map((q) => q.period)).toEqual(["1m", "1m", "1m"]);
  expect(befores(f.fetched)).toEqual([null, NOW - 10 * MIN, NOW - 20 * MIN]);
  const read = f.store.read(recent);
  expect(read.kind).toBe("ready");
  if (read.kind !== "ready") return;
  expect(read.period).toBe("1m");
  expect(ts(read.bars)).toEqual(Array.from({ length: 25 }, (_, i) => NOW - (25 - i) * MIN));
  expect(f.notified()).toBe(3);
});

test("받는 동안은 loading이고, 같은 요구를 다시 넘겨도 조회가 더 나가지 않는다", async () => {
  const f = fixture();
  f.store.demand([recent]);
  f.store.demand([recent]);
  expect(f.store.read(recent)).toEqual({ kind: "loading" });
  await f.settle();
  f.store.demand([recent]);
  f.store.demand([recent]);
  await f.settle();
  expect(f.fetched).toHaveLength(3);
});

test("더 받을 과거가 없으면 구간 시작에 닿지 않아도 다 받은 것이다", async () => {
  const f = fixture((q) => minutePage(q, NOW - 15 * MIN));
  f.store.demand([recent]);
  await f.settle();
  expect(f.fetched).toHaveLength(2);
  const read = f.store.read(recent);
  expect(read.kind === "ready" && ts(read.bars)[0]).toBe(NOW - 20 * MIN);
});

test(`과거 페이지는 주기 하나에 ${MAX_FINE_PAGES}개에서 멈추고 한도 안에 드는 주기가 없다고 답한다`, async () => {
  const f = fixture();
  const far = span(kst(2026, 11, 9));
  f.store.demand([far]);
  await f.settle();
  expect(f.fetched).toHaveLength(1 + MAX_FINE_PAGES);
  expect(f.store.read(far)).toEqual({ kind: "none", reason: "overLimit" });
  f.store.demand([far]);
  await f.settle();
  expect(f.fetched).toHaveLength(1 + MAX_FINE_PAGES);
  expect(f.store.read(recent).kind).toBe("ready");
});

test("쓸 주기가 없는 구간은 조회하지 않고 까닭을 준다", async () => {
  const f = fixture(undefined, { ...daily, period: "1m" });
  f.store.demand([recent]);
  await f.settle();
  expect(f.fetched).toEqual([]);
  expect(f.store.read(recent)).toEqual({ kind: "none", reason: "oneMinuteChart" });
  const year = fixture();
  const old = span(kst(2025, 11, 1));
  year.store.demand([old]);
  await year.settle();
  expect(year.fetched).toEqual([]);
  expect(year.store.read(old)).toEqual({ kind: "none", reason: "pastYear" });
});

test("구간마다 주기를 골라 주기마다 따로 받고, 요구가 없어진 주기는 구독을 놓는다", async () => {
  const f = fixture();
  const sixtyDays = span(kst(2026, 8, 24));
  f.store.demand([recent, sixtyDays]);
  expect(f.subscribed()).toEqual(["005930/combined/1m", "005930/combined/5m"]);
  await f.settle();
  f.store.demand([sixtyDays]);
  expect(f.subscribed()).toEqual(["005930/combined/5m"]);
  expect(f.store.read(recent)).toEqual({ kind: "loading" });
  f.store.demand([]);
  expect(f.subscribed()).toEqual([]);
  const calls = f.fetched.length;
  await f.settle();
  expect(f.fetched).toHaveLength(calls);
});

test("요구에 없는 구간도 받은 봉이 덮으면 ready다", async () => {
  const f = fixture();
  f.store.demand([recent]);
  await f.settle();
  const inside = span(NOW - 12 * MIN, NOW - 8 * MIN);
  const read = f.store.read(inside);
  expect(read.kind === "ready" && ts(read.bars)).toEqual([NOW - 12 * MIN, NOW - 11 * MIN, NOW - 10 * MIN, NOW - 9 * MIN]);
  expect(f.store.read(span(NOW - 60 * MIN)).kind).toBe("loading");
});

test("최신 페이지를 받지 못하면 failed이고, 스스로 다시 받지 않다가 요구가 바뀌면 다시 받는다", async () => {
  let fail = true;
  const f = fixture((q) => {
    if (fail) throw new ApiRequestError("network", "x");
    return minutePage(q);
  });
  f.store.demand([recent]);
  await f.settle();
  expect(f.store.read(recent)).toEqual({ kind: "failed" });
  expect(f.notified()).toBe(1);
  f.store.demand([recent]);
  await f.settle();
  expect(f.fetched).toHaveLength(1);
  fail = false;
  f.store.demand([span(NOW - 15 * MIN)]);
  await f.settle();
  expect(befores(f.fetched)).toEqual([null, null, NOW - 10 * MIN]);
  expect(f.store.read(span(NOW - 15 * MIN)).kind).toBe("ready");
});

test("과거 페이지를 받지 못하면 failed이고, 요구가 바뀌면 과거 페이지부터 다시 받는다", async () => {
  let fail = true;
  const f = fixture((q) => {
    if (q.before !== undefined && fail) throw new ApiRequestError("network", "x");
    return minutePage(q);
  });
  f.store.demand([recent]);
  await f.settle();
  expect(f.store.read(recent)).toEqual({ kind: "failed" });
  expect(f.store.read(span(NOW - 5 * MIN)).kind).toBe("ready");
  f.store.demand([recent]);
  await f.settle();
  expect(f.fetched).toHaveLength(2);
  fail = false;
  f.store.demand([span(NOW - 26 * MIN)]);
  await f.settle();
  expect(befores(f.fetched)).toEqual([null, NOW - 10 * MIN, NOW - 10 * MIN, NOW - 20 * MIN]);
  expect(f.store.read(recent).kind).toBe("ready");
});

test("실시간 봉이 오면 ready의 봉에 반영하고 알린다", async () => {
  const f = fixture();
  f.store.demand([recent]);
  await f.settle();
  const before = f.notified();
  f.push({ type: "bar", sub: "s1", seq: 1, bar: bar(NOW, 7) });
  expect(f.notified()).toBe(before + 1);
  const read = f.store.read(recent);
  expect(read.kind === "ready" && read.bars.at(-1)).toEqual(bar(NOW, 7));
});

test("칸을 다시 열면 이전 응답을 버리고 새 종목으로 받는다", async () => {
  const held: { q: BarsQuery; resolve: (p: BarsPage) => void }[] = [];
  const f = fixture((q) => new Promise<BarsPage>((resolve) => held.push({ q, resolve })));
  f.store.demand([recent]);
  await f.settle();
  f.store.open({ symbol: "000660", venue: "krx", period: "W" });
  expect(f.subscribed()).toEqual([]);
  held[0]!.resolve(minutePage(held[0]!.q));
  await f.settle();
  expect(f.notified()).toBe(0);
  expect(f.store.read(recent)).toEqual({ kind: "loading" });
  f.store.demand([recent]);
  expect(f.fetched.at(-1)).toEqual({ symbol: "000660", venue: "krx", period: "1m" });
  expect(f.subscribed()).toEqual(["000660/krx/1m"]);
});

test(`받지 못한 과거 페이지는 ${MAX_FINE_PAGES}페이지 한도에 세지 않는다`, async () => {
  let older = 0;
  let failAt = MAX_FINE_PAGES;
  const f = fixture((q) => {
    if (q.before !== undefined && ++older === failAt) throw new ApiRequestError("network", "x");
    return minutePage(q);
  });
  const far = span(kst(2026, 11, 9));
  f.store.demand([far]);
  await f.settle();
  expect(f.store.read(far)).toEqual({ kind: "failed" });
  f.store.demand([span(kst(2026, 11, 9, 9))]);
  await f.settle();
  expect(f.fetched).toHaveLength(2 + MAX_FINE_PAGES);
  expect(f.store.read(far)).toEqual({ kind: "none", reason: "overLimit" });

  older = 0;
  failAt = 1;
  const g = fixture((q) => {
    if (q.before !== undefined && ++older === failAt) throw new ApiRequestError("network", "x");
    return minutePage(q);
  });
  g.store.demand([span(NOW - 200 * MIN)]);
  await g.settle();
  const reachedByTwentyPages = span(NOW - 210 * MIN);
  g.store.demand([reachedByTwentyPages]);
  await g.settle();
  expect(g.store.read(reachedByTwentyPages).kind).toBe("ready");
});
