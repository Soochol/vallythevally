import { describe, expect, test } from "vitest";
import type { BarsQuery, JumpQuery, SeriesKey } from "../api/bars";
import type { Bar } from "../api/generated/Bar";
import type { BarsPage } from "../api/generated/BarsPage";
import type { JumpBarsPage } from "../api/generated/JumpBarsPage";
import { ApiRequestError } from "../api/http";
import type { SubEvent } from "../api/socket";
import { displayBars, type History } from "./barFeed";
import { JumpableFeed } from "./jumpFeed";

const key = (symbol: string, period: SeriesKey["period"] = "1m"): SeriesKey => ({ symbol, venue: "combined", period });
const bar = (t: number): Bar => ({ t, o: t, h: t, l: t, c: t, v: 1 });
const latest = (bars: Bar[], nextBefore: number | null = null): BarsPage => ({ symbol: "005930", venue: "combined", period: "1m", bars, current: null, nextBefore, seq: null });
const jump = (bars: Bar[], nextBefore: number | null = null, unadjustedDays: string[] = []): JumpBarsPage => ({ symbol: "005930", venue: "combined", period: "1m", date: "2026-11-09", bars, nextBefore, unadjustedDays });

function harness() {
  const normal: { q: BarsQuery; resolve: (p: BarsPage) => void; reject: (e: unknown) => void }[] = [];
  const jumps: { q: JumpQuery; resolve: (p: JumpBarsPage) => void; reject: (e: unknown) => void }[] = [];
  const subs = new Map<number, (m: SubEvent) => void>();
  let nextSub = 0;
  const events: string[] = [];
  let history: History | null = null;
  const feed = new JumpableFeed(
    (q) => new Promise((resolve, reject) => normal.push({ q, resolve, reject })),
    (q) => new Promise((resolve, reject) => jumps.push({ q, resolve, reject })),
    {
      reset: (h) => { history = h; events.push(`reset ${h.bars.length}`); },
      jumpEntered: (h) => { history = h; events.push(`entered ${h.bars.length}`); },
      modeChanged: () => events.push("mode"),
      prepended: (h, added) => { history = h; events.push(`prepend ${added}`); },
      failed: (e) => events.push(`failed ${e.code}`),
      olderFailed: (e) => events.push(`olderFailed ${e.code}`),
      olderLoading: () => events.push("olderLoading"),
      live: (h, b) => { history = h; events.push(`live ${b.t}`); },
      confirmed: (h, b) => { history = h; events.push(`confirmed ${b.t}`); },
      subError: () => {},
    },
    { subscribe: (_k, handler) => { const id = nextSub++; subs.set(id, handler as (m: SubEvent) => void); return () => subs.delete(id); } },
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const push = (m: SubEvent) => { for (const handler of [...subs.values()]) handler(m); };
  return { feed, normal, jumps, events, flush, push, subscribers: () => subs.size, shown: () => (history ? displayBars(history).map((b) => b.t) : null) };
}

async function entered(h = harness(), symbol = "005930") {
  h.feed.open(key(symbol));
  h.normal[0]!.resolve(latest([bar(100), bar(101)]));
  await h.flush();
  const entry = h.feed.enterMode("2026-11-09");
  h.jumps[0]!.resolve(jump([bar(10), bar(11)], 10, ["2026-11-02"]));
  expect(await entry).toBe("entered");
  return h;
}

describe("바로가기 모드 진입", () => {
  test("첫 페이지 요청에 기준 날짜가 실리고, 도착하면 평소 구독이 닫힌다", async () => {
    const h = harness();
    h.feed.open(key("005930"));
    h.normal[0]!.resolve(latest([bar(100)]));
    await h.flush();
    expect(h.subscribers()).toBe(1);
    const entry = h.feed.enterMode("2026-11-09");
    expect(h.jumps[0]!.q).toMatchObject({ symbol: "005930", period: "1m", date: "2026-11-09" });
    expect(h.jumps[0]!.q.before).toBeUndefined();
    expect(h.feed.mode).toEqual({ date: "2026-11-09", entering: true, unadjustedDays: [] });
    expect(h.subscribers()).toBe(1);
    h.jumps[0]!.resolve(jump([bar(10), bar(11)], 10, ["2026-11-02"]));
    expect(await entry).toBe("entered");
    expect(h.subscribers()).toBe(0);
    expect(h.shown()).toEqual([10, 11]);
    expect(h.feed.mode).toEqual({ date: "2026-11-09", entering: false, unadjustedDays: ["2026-11-02"] });
    expect(h.feed.activeDate).toBe("2026-11-09");
  });

  test("모드 중 과거 받기는 같은 날짜와 before로 나가고 수정주가 미반영 날짜가 쌓인다", async () => {
    const h = await entered();
    h.feed.needOlder();
    expect(h.jumps[1]!.q).toMatchObject({ date: "2026-11-09", before: 10 });
    h.jumps[1]!.resolve(jump([bar(8), bar(9)], null, ["2026-10-30"]));
    await h.flush();
    expect(h.shown()).toEqual([8, 9, 10, 11]);
    expect(h.feed.mode?.unadjustedDays).toEqual(["2026-10-30", "2026-11-02"]);
    expect(h.normal).toHaveLength(1);
  });

  test("모드 중에는 실시간 메시지를 붙이지 않는다", async () => {
    const h = await entered();
    const before = [...h.events];
    h.push({ type: "bar", sub: "s1", seq: 5, bar: bar(120) });
    h.push({ type: "confirmed", sub: "s1", seq: 6, bar: bar(120) });
    expect(h.events).toEqual(before);
    expect(h.shown()).toEqual([10, 11]);
  });

  test("끝내기 뒤 평소 최신 페이지를 다시 받고 구독을 다시 연다", async () => {
    const h = await entered();
    h.feed.endMode();
    expect(h.normal).toHaveLength(2);
    expect(h.normal[1]!.q.before).toBeUndefined();
    expect(h.subscribers()).toBe(1);
    expect(h.feed.mode).toBeNull();
    h.normal[1]!.resolve(latest([bar(100), bar(101), bar(102)]));
    await h.flush();
    expect(h.events.at(-1)).toBe("reset 3");
    h.push({ type: "bar", sub: "s1", seq: 1, bar: bar(103) });
    expect(h.events.at(-1)).toBe("live 103");
  });

  test("모드 중 다른 날짜가 오면 새 기준일 계열로 바꾸고 앞 계열의 응답은 버린다", async () => {
    const h = await entered();
    h.feed.needOlder();
    const stale = h.jumps[1]!;
    const entry = h.feed.enterMode("2026-10-20");
    expect(h.feed.mode?.entering).toBe(true);
    expect(h.feed.activeDate).toBe("2026-11-09");
    stale.resolve(jump([bar(8)], null));
    h.jumps[2]!.resolve(jump([bar(1), bar(2), bar(3)], 1));
    expect(await entry).toBe("entered");
    expect(h.feed.activeDate).toBe("2026-10-20");
    expect(h.shown()).toEqual([1, 2, 3]);
    expect(h.jumps[2]!.q.date).toBe("2026-10-20");
  });
});

describe("모드 중 새 기준일", () => {
  test("받는 동안 뱃지에는 앞 기준일의 수정주가 미반영 날짜가 섞이지 않는다", async () => {
    const h = await entered();
    expect(h.feed.mode?.unadjustedDays).toEqual(["2026-11-02"]);
    const entry = h.feed.enterMode("2026-11-05");
    expect(h.feed.mode).toEqual({ date: "2026-11-05", entering: true, unadjustedDays: [] });
    h.jumps[1]!.resolve(jump([bar(1), bar(2)], null, ["2026-10-20"]));
    expect(await entry).toBe("entered");
    expect(h.feed.mode).toEqual({ date: "2026-11-05", entering: false, unadjustedDays: ["2026-10-20"] });
  });

  test("새 기준일 받기가 실패하면 앞 모드와 그 날짜가 그대로다", async () => {
    const h = await entered();
    const entry = h.feed.enterMode("2026-11-05");
    h.jumps[1]!.reject(new ApiRequestError("kiwoom_unavailable", "x"));
    expect(await entry).toBe("failed");
    expect(h.feed.mode).toEqual({ date: "2026-11-09", entering: false, unadjustedDays: ["2026-11-02"] });
    expect(h.shown()).toEqual([10, 11]);
  });
});

describe("바로가기 모드에 들지 않는 경우", () => {
  test("받는 도중 종목이 바뀌면 앞 응답을 버린다", async () => {
    const h = harness();
    h.feed.open(key("005930"));
    h.normal[0]!.resolve(latest([bar(100)]));
    await h.flush();
    const entry = h.feed.enterMode("2026-11-09");
    h.feed.open(key("000660"));
    expect(await entry).toBe("cancelled");
    h.jumps[0]!.resolve(jump([bar(10)]));
    await h.flush();
    expect(h.feed.mode).toBeNull();
    expect(h.events.some((e) => e.startsWith("entered"))).toBe(false);
    expect(h.normal[1]!.q.symbol).toBe("000660");
    expect(h.subscribers()).toBe(1);
  });

  test("받는 도중 끝내기나 취소도 앞 응답을 버린다", async () => {
    const h = harness();
    h.feed.open(key("005930"));
    h.normal[0]!.resolve(latest([bar(100)]));
    await h.flush();
    const entry = h.feed.enterMode("2026-11-09");
    h.feed.cancelEntering();
    expect(await entry).toBe("cancelled");
    h.jumps[0]!.resolve(jump([bar(10)]));
    await h.flush();
    expect(h.feed.mode).toBeNull();
    expect(h.shown()).toEqual([100]);
  });

  test("빈 첫 페이지면 모드에 들지 않고 평소 받기가 그대로 남는다", async () => {
    const h = harness();
    h.feed.open(key("005930"));
    h.normal[0]!.resolve(latest([bar(100)]));
    await h.flush();
    const entry = h.feed.enterMode("2026-01-05");
    h.jumps[0]!.resolve(jump([]));
    expect(await entry).toBe("empty");
    expect(h.feed.mode).toBeNull();
    expect(h.subscribers()).toBe(1);
    expect(h.shown()).toEqual([100]);
    h.push({ type: "bar", sub: "s1", seq: 1, bar: bar(101) });
    expect(h.shown()).toEqual([100, 101]);
  });

  test("받기에 실패하면 모드에 들지 않고 평소 받기가 그대로 남는다", async () => {
    const h = harness();
    h.feed.open(key("005930"));
    h.normal[0]!.resolve(latest([bar(100)]));
    await h.flush();
    const entry = h.feed.enterMode("2026-11-09");
    h.jumps[0]!.reject(new ApiRequestError("kiwoom_unavailable", "조회가 응답하지 않습니다"));
    expect(await entry).toBe("failed");
    expect(h.feed.mode).toBeNull();
    expect(h.subscribers()).toBe(1);
    expect(h.events.some((e) => e.startsWith("failed"))).toBe(false);
  });

  test("열기 전에는 들 수 없다", async () => {
    expect(await harness().feed.enterMode("2026-11-09")).toBe("cancelled");
  });
});

describe("이어 받기", () => {
  test("olderUntil은 조건을 만족할 때까지 과거 페이지를 받고, 끝에 닿으면 exhausted다", async () => {
    const h = harness();
    h.feed.open(key("005930", "D"));
    h.normal[0]!.resolve(latest([bar(100), bar(101)], 100));
    await h.flush();
    const reached = h.feed.olderUntil((history) => history.bars[0]!.t <= 50);
    h.normal[1]!.resolve(latest([bar(80), bar(90)], 80));
    await h.flush();
    h.normal[2]!.resolve(latest([bar(40), bar(60)], null));
    expect(await reached).toBe("reached");
    expect(h.shown()).toEqual([40, 60, 80, 90, 100, 101]);
    expect(await h.feed.olderUntil(() => false)).toBe("exhausted");
  });

  test("받기 실패와 세대 교체를 알린다", async () => {
    const h = harness();
    h.feed.open(key("005930", "D"));
    h.normal[0]!.resolve(latest([bar(100)], 100));
    await h.flush();
    const failing = h.feed.olderUntil(() => false);
    h.normal[1]!.reject(new ApiRequestError("kiwoom_unavailable", "x"));
    expect(await failing).toBe("failed");
    h.feed.retryOlder();
    const replaced = h.feed.olderUntil(() => false);
    h.feed.open(key("000660", "D"));
    expect(await replaced).toBe("stale");
  });
});
