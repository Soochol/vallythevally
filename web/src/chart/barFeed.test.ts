import { describe, expect, test } from "vitest";
import type { BarsQuery, SeriesKey } from "../api/bars";
import type { Bar } from "../api/generated/Bar";
import type { BarsPage } from "../api/generated/BarsPage";
import { ApiRequestError } from "../api/http";
import { BarFeed, displayBars, type History, prependOlder } from "./barFeed";

const key = (symbol: string, period: SeriesKey["period"], venue: SeriesKey["venue"] = "combined"): SeriesKey => ({
  symbol,
  venue,
  period,
});
const bar = (t: number, c = t): Bar => ({ t, o: c, h: c, l: c, c, v: 1 });
const page = (bars: Bar[], nextBefore: number | null, current: Bar | null = null): BarsPage => ({
  symbol: "005930",
  venue: "combined",
  period: "D",
  bars,
  current,
  nextBefore,
  seq: null,
});

describe("prependOlder", () => {
  test("과거 페이지를 앞에 붙이고 커서를 바꾼다", () => {
    const h: History = { bars: [bar(10), bar(11)], current: bar(12), nextBefore: 10 };
    const { history, added } = prependOlder(h, page([bar(8), bar(9)], 8));
    expect(history.bars.map((b) => b.t)).toEqual([8, 9, 10, 11]);
    expect(history.current?.t).toBe(12);
    expect(history.nextBefore).toBe(8);
    expect(added).toBe(2);
  });

  test("이미 가진 봉과 겹치거나 늦은 봉은 덮어쓰지 않는다(D1)", () => {
    const h: History = { bars: [bar(10, 100), bar(11, 110)], current: null, nextBefore: 10 };
    const { history, added } = prependOlder(h, page([bar(9, 90), bar(10, 999), bar(11, 999)], null));
    expect(history.bars.map((b) => [b.t, b.c])).toEqual([[9, 90], [10, 100], [11, 110]]);
    expect(added).toBe(1);
    expect(history.nextBefore).toBeNull();
  });
});

test("displayBars는 확정 봉 뒤에 현재 봉을 붙인다", () => {
  expect(displayBars({ bars: [bar(1)], current: bar(2), nextBefore: null }).map((b) => b.t)).toEqual([1, 2]);
  expect(displayBars({ bars: [bar(1)], current: null, nextBefore: null }).map((b) => b.t)).toEqual([1]);
});

/** 응답을 손으로 풀어 주는 가짜 fetch. */
function harness() {
  const calls: { q: BarsQuery; resolve: (p: BarsPage) => void; reject: (e: unknown) => void }[] = [];
  const events: string[] = [];
  let last: History | null = null;
  const feed = new BarFeed(
    (q) => new Promise((resolve, reject) => calls.push({ q, resolve, reject })),
    {
      reset: (h) => { last = h; events.push(`reset ${h.bars.length}`); },
      prepended: (h, added) => { last = h; events.push(`prepend ${added}`); },
      failed: (e) => events.push(`failed ${e.code}`),
      olderFailed: (e) => events.push(`olderFailed ${e.code}`),
    },
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { feed, calls, events, flush, history: () => last };
}

describe("BarFeed", () => {
  test("이전 세대의 응답은 버린다", async () => {
    const { feed, calls, events, flush, history } = harness();
    feed.open(key("005930", "D"));
    feed.open(key("005930", "W"));
    calls[0]!.resolve(page([bar(1)], null));
    calls[1]!.resolve(page([bar(5), bar(6)], null));
    await flush();
    expect(events).toEqual(["reset 2"]);
    expect(history()?.bars.map((b) => b.t)).toEqual([5, 6]);
  });

  test("거래소를 바꾸면 새 세대다. 이전 거래소의 늦은 최신·과거 페이지는 버린다", async () => {
    const { feed, calls, events, flush, history } = harness();
    feed.open(key("005930", "D", "krx"));
    calls[0]!.resolve(page([bar(10), bar(11)], 10));
    await flush();
    feed.needOlder();
    feed.open(key("005930", "D", "nxt"));
    expect(calls.map((c) => [c.q.venue, c.q.before])).toEqual([["krx", undefined], ["krx", 10], ["nxt", undefined]]);
    calls[1]!.resolve(page([bar(8), bar(9)], null));
    calls[2]!.resolve(page([bar(20)], null));
    await flush();
    expect(events).toEqual(["reset 2", "reset 1"]);
    expect(history()?.bars.map((b) => b.t)).toEqual([20]);
  });

  test("과거 페이지 요청은 한 번에 하나, nextBefore를 before로 보낸다", async () => {
    const { feed, calls, events, flush } = harness();
    feed.open(key("005930", "D"));
    feed.needOlder(); // 최신 페이지가 오기 전에는 받지 않는다
    calls[0]!.resolve(page([bar(10), bar(11)], 10, bar(12)));
    await flush();
    feed.needOlder();
    feed.needOlder();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.q.before).toBe(10);
    calls[1]!.resolve(page([bar(8), bar(9)], 8));
    await flush();
    expect(events).toEqual(["reset 2", "prepend 2"]);
    feed.needOlder();
    expect(calls[2]!.q.before).toBe(8);
  });

  test("nextBefore가 null이면 더 받지 않는다", async () => {
    const { feed, calls, flush } = harness();
    feed.open(key("005930", "D"));
    calls[0]!.resolve(page([bar(10)], 10));
    await flush();
    feed.needOlder();
    calls[1]!.resolve(page([bar(9)], null));
    await flush();
    feed.needOlder();
    feed.needOlder();
    expect(calls).toHaveLength(2);
  });

  test("봉 주기를 바꾼 뒤 도착한 과거 페이지는 버린다", async () => {
    const { feed, calls, events, flush } = harness();
    feed.open(key("005930", "D"));
    calls[0]!.resolve(page([bar(10)], 10));
    await flush();
    feed.needOlder();
    feed.open(key("005930", "W"));
    calls[1]!.resolve(page([bar(9)], null));
    calls[2]!.resolve(page([bar(20)], null));
    await flush();
    expect(events).toEqual(["reset 1", "reset 1"]);
    expect(calls[1]!.q.period).toBe("D");
  });

  test("최신 페이지 실패를 알린다", async () => {
    const { feed, calls, events, flush } = harness();
    feed.open(key("999999", "D"));
    calls[0]!.reject(new ApiRequestError("unknown_symbol", "없음"));
    await flush();
    expect(events).toEqual(["failed unknown_symbol"]);
  });

  test("과거 페이지 실패를 알리고, 가진 봉은 그대로 두고, 스크롤로는 다시 보내지 않는다", async () => {
    const { feed, calls, events, flush, history } = harness();
    feed.open(key("005930", "D"));
    calls[0]!.resolve(page([bar(10), bar(11)], 10));
    await flush();
    feed.needOlder();
    calls[1]!.reject(new ApiRequestError("kiwoom_auth_failed", "키움 인증에 실패했습니다"));
    await flush();
    expect(events).toEqual(["reset 2", "olderFailed kiwoom_auth_failed"]);
    expect(history()?.bars.map((b) => b.t)).toEqual([10, 11]);
    feed.needOlder();
    feed.needOlder();
    expect(calls).toHaveLength(2);
  });

  test("retryOlder는 실패한 과거 페이지를 다시 받는다", async () => {
    const { feed, calls, events, flush } = harness();
    feed.open(key("005930", "D"));
    calls[0]!.resolve(page([bar(10)], 10));
    await flush();
    feed.needOlder();
    calls[1]!.reject(new ApiRequestError("kiwoom_unavailable", "잠시 뒤 다시 시도하세요"));
    await flush();
    feed.retryOlder();
    expect(calls).toHaveLength(3);
    expect(calls[2]!.q.before).toBe(10);
    calls[2]!.resolve(page([bar(9)], null));
    await flush();
    expect(events).toEqual(["reset 1", "olderFailed kiwoom_unavailable", "prepend 1"]);
  });

  test("다시 열면 과거 페이지 실패 상태를 지운다", async () => {
    const { feed, calls, flush } = harness();
    feed.open(key("005930", "D"));
    calls[0]!.resolve(page([bar(10)], 10));
    await flush();
    feed.needOlder();
    calls[1]!.reject(new ApiRequestError("network", "서버에 연결하지 못했습니다"));
    await flush();
    feed.reload();
    calls[2]!.resolve(page([bar(10)], 10));
    await flush();
    feed.needOlder();
    expect(calls).toHaveLength(4);
  });

  test("dispose 뒤 도착한 응답은 버린다", async () => {
    const { feed, calls, events, flush } = harness();
    feed.open(key("005930", "D"));
    feed.dispose();
    calls[0]!.resolve(page([bar(1)], null));
    await flush();
    expect(events).toEqual([]);
  });
});
