import { describe, expect, test } from "vitest";
import type { BarsQuery, SeriesKey } from "../api/bars";
import type { Bar } from "../api/generated/Bar";
import type { BarsPage } from "../api/generated/BarsPage";
import { ApiRequestError } from "../api/http";
import type { SubEvent } from "../api/socket";
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

function fakeSocket() {
  const subs = new Map<number, { key: SeriesKey; handler: (m: SubEvent) => void }>();
  let next = 0;
  return {
    socket: {
      subscribe(k: SeriesKey, handler: (m: SubEvent) => void) {
        const id = next++;
        subs.set(id, { key: k, handler });
        return () => subs.delete(id);
      },
    },
    subscribedKeys: () => [...subs.values()].map((s) => `${s.key.symbol}/${s.key.period}`),
    push(m: SubEvent) {
      for (const s of [...subs.values()]) s.handler(m);
    },
  };
}

/** 응답을 손으로 풀어 주는 가짜 fetch. */
function harness(socket?: ReturnType<typeof fakeSocket>["socket"]) {
  const calls: { q: BarsQuery; resolve: (p: BarsPage) => void; reject: (e: unknown) => void }[] = [];
  const events: string[] = [];
  let olderLoads = 0;
  let last: History | null = null;
  const feed = new BarFeed(
    (q) => new Promise((resolve, reject) => calls.push({ q, resolve, reject })),
    {
      reset: (h) => { last = h; events.push(`reset ${h.bars.length}`); },
      prepended: (h, added) => { last = h; events.push(`prepend ${added}`); },
      failed: (e) => events.push(`failed ${e.code}`),
      olderFailed: (e) => events.push(`olderFailed ${e.code}`),
      olderLoading: () => { olderLoads++; },
      live: (h, b) => { last = h; events.push(`live ${b.t}:${b.c}`); },
      confirmed: (h, b) => { last = h; events.push(`confirmed ${b.t}:${b.c}`); },
      subError: (code) => events.push(`subError ${code}`),
    },
    socket,
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { feed, calls, events, flush, history: () => last, olderLoads: () => olderLoads };
}

function realtime() {
  const s = fakeSocket();
  return { ...harness(s.socket), ...s };
}

const shown = (h: History | null) => (h ? displayBars(h).map((b) => `${b.t}:${b.c}`) : null);
const withSeq = (p: BarsPage, seq: number | null): BarsPage => ({ ...p, seq });

describe("BarFeed 실시간", () => {
  test("페이지를 받기 전에 온 메시지를 쌓았다가 seq > page.seq만 차례로 적용한다", async () => {
    const { feed, calls, events, flush, history, push } = realtime();
    feed.open(key("005930", "1m"));
    push({ type: "subscribed", sub: "s1", seq: 10, current: bar(60, 1) });
    push({ type: "bar", sub: "s1", seq: 11, bar: bar(60, 2) });
    push({ type: "confirmed", sub: "s1", seq: 12, bar: bar(60, 3) });
    push({ type: "bar", sub: "s1", seq: 13, bar: bar(120, 4) });
    expect(events).toEqual(["subError null"]);
    calls[0]!.resolve(withSeq(page([bar(0)], null, bar(60, 2)), 11));
    await flush();
    expect(events).toEqual(["subError null", "reset 1", "confirmed 60:3", "live 120:4"]);
    expect(shown(history())).toEqual(["0:0", "60:3", "120:4"]);
  });

  test("page.seq가 null이면 쌓인 메시지를 모두 적용한다", async () => {
    const { feed, calls, events, flush, push } = realtime();
    feed.open(key("005930", "1m"));
    push({ type: "subscribed", sub: "s1", seq: 1, current: bar(60, 1) });
    push({ type: "bar", sub: "s1", seq: 2, bar: bar(60, 2) });
    calls[0]!.resolve(page([bar(0)], null));
    await flush();
    expect(events).toEqual(["subError null", "reset 1", "live 60:1", "live 60:2"]);
  });

  test("페이지 뒤에는 도착 순서대로 바로 적용한다. 확정 다음의 bar는 새 현재 봉이다", async () => {
    const { feed, calls, events, flush, history, push } = realtime();
    feed.open(key("005930", "1m"));
    calls[0]!.resolve(withSeq(page([bar(0)], null, bar(60, 5)), 3));
    await flush();
    push({ type: "bar", sub: "s1", seq: 4, bar: bar(60, 6) });
    expect(shown(history())).toEqual(["0:0", "60:6"]);
    push({ type: "confirmed", sub: "s1", seq: 5, bar: bar(60, 7) });
    expect(history()?.current).toBeNull();
    push({ type: "bar", sub: "s1", seq: 6, bar: bar(120, 8) });
    expect(events).toEqual(["reset 1", "live 60:6", "confirmed 60:7", "live 120:8"]);
    expect(history()?.bars.map((b) => b.t)).toEqual([0, 60]);
    expect(shown(history())).toEqual(["0:0", "60:7", "120:8"]);
  });

  test("가진 봉보다 이른 bar와 confirmed는 버린다", async () => {
    const { feed, calls, events, flush, history, push } = realtime();
    feed.open(key("005930", "1m"));
    calls[0]!.resolve(page([bar(0), bar(60)], null, bar(120, 9)));
    await flush();
    push({ type: "bar", sub: "s1", seq: 1, bar: bar(60, 1) });
    push({ type: "confirmed", sub: "s1", seq: 2, bar: bar(0, 1) });
    expect(events).toEqual(["reset 2"]);
    expect(shown(history())).toEqual(["0:0", "60:60", "120:9"]);
  });

  test("마지막 확정 봉과 같은 t의 bar는 그 확정 봉을 바꾼다", async () => {
    const { feed, calls, flush, history, push } = realtime();
    feed.open(key("005930", "1m"));
    calls[0]!.resolve(page([bar(0), bar(60)], null));
    await flush();
    push({ type: "bar", sub: "s1", seq: 1, bar: bar(60, 99) });
    expect(history()?.bars.map((b) => `${b.t}:${b.c}`)).toEqual(["0:0", "60:99"]);
    expect(history()?.current).toBeNull();
  });

  test("reload 메시지는 새 세대로 다시 받는다. 구독은 그대로이고 이전 페이지는 버린다", async () => {
    const { feed, calls, events, flush, history, push, subscribedKeys } = realtime();
    feed.open(key("005930", "1m"));
    calls[0]!.resolve(withSeq(page([bar(0)], null), 1));
    await flush();
    push({ type: "reload", sub: "s1", seq: 2, reason: "gap_filled", from: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.q.before).toBeUndefined();
    push({ type: "bar", sub: "s1", seq: 3, bar: bar(60, 1) });
    calls[1]!.resolve(withSeq(page([bar(0), bar(60)], null), 2));
    await flush();
    expect(events).toEqual(["reset 1", "reset 2", "live 60:1"]);
    expect(shown(history())).toEqual(["0:0", "60:1"]);
    expect(subscribedKeys()).toEqual(["005930/1m"]);
  });

  test("쌓아 둔 reload도 seq로 거른다. 페이지가 이미 반영했으면 버린다", async () => {
    const { feed, calls, flush, push } = realtime();
    feed.open(key("005930", "1m"));
    push({ type: "reload", sub: "s1", seq: 2, reason: "daily_reset", from: null });
    calls[0]!.resolve(withSeq(page([bar(0)], null), 2));
    await flush();
    expect(calls).toHaveLength(1);
  });

  test("resync는 페이지를 받는 중이어도 처음부터 다시 받는다", async () => {
    const { feed, calls, events, flush, push } = realtime();
    feed.open(key("005930", "1m"));
    push({ type: "bar", sub: "s1", seq: 1, bar: bar(60, 1) });
    push({ type: "resync" });
    calls[0]!.resolve(page([bar(0)], null));
    calls[1]!.resolve(page([bar(0), bar(60)], null));
    await flush();
    expect(calls).toHaveLength(2);
    expect(events).toEqual(["reset 2"]);
  });

  test("sub_error와 이어지는 subscribed를 알린다", () => {
    const { feed, events, push } = realtime();
    feed.open(key("005930", "1m"));
    push({ type: "sub_error", sub: "s1", code: "realtime_limit" });
    push({ type: "subscribed", sub: "s1", seq: 1, current: null });
    expect(events).toEqual(["subError realtime_limit", "subError null"]);
  });

  test("다시 열면 이전 구독을 풀고, dispose하면 구독이 남지 않는다", () => {
    const { feed, subscribedKeys } = realtime();
    feed.open(key("005930", "1m"));
    feed.reload();
    expect(subscribedKeys()).toEqual(["005930/1m"]);
    feed.open(key("005930", "5m"));
    expect(subscribedKeys()).toEqual(["005930/5m"]);
    feed.dispose();
    expect(subscribedKeys()).toEqual([]);
  });

  test("최신 페이지를 받지 못하면 쌓은 메시지를 버린다", async () => {
    const { feed, calls, events, flush, push } = realtime();
    feed.open(key("005930", "1m"));
    calls[0]!.reject(new ApiRequestError("network", "서버에 연결하지 못했습니다"));
    await flush();
    push({ type: "bar", sub: "s1", seq: 1, bar: bar(60, 1) });
    feed.reload();
    calls[1]!.resolve(page([bar(0)], null));
    await flush();
    expect(events).toEqual(["failed network", "reset 1"]);
  });
});

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
    const { feed, calls, events, flush, olderLoads } = harness();
    feed.open(key("005930", "D"));
    calls[0]!.resolve(page([bar(10)], 10));
    await flush();
    feed.needOlder();
    expect(olderLoads()).toBe(1);
    feed.needOlder();
    expect(olderLoads()).toBe(1);
    calls[1]!.reject(new ApiRequestError("kiwoom_unavailable", "잠시 뒤 다시 시도하세요"));
    await flush();
    feed.needOlder();
    expect(olderLoads()).toBe(1);
    feed.retryOlder();
    expect(olderLoads()).toBe(2);
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

test("HTTP 페이지보다 늦게 온 옛 subscribed는 봉을 되돌리지 않는다", async () => {
  const { feed, calls, flush, history, push } = realtime();
  feed.open(key("005930", "1m"));
  calls[0]!.resolve(withSeq(page([bar(0)], null, bar(60, 200)), 12));
  await flush();
  push({ type: "subscribed", sub: "s1", seq: 10, current: bar(60, 100) });
  expect(shown(history())).toEqual(["0:0", "60:200"]);
});

test("다시 받은 페이지보다 옛 bar는 봉을 되돌리지 않는다", async () => {
  const { feed, calls, flush, history, push } = realtime();
  feed.open(key("005930", "1m"));
  calls[0]!.resolve(withSeq(page([bar(0)], null, bar(60, 100)), 10));
  await flush();
  push({ type: "reload", sub: "s1", seq: 11, reason: "gap_filled", from: 0 });
  calls[1]!.resolve(withSeq(page([bar(0)], null, bar(60, 200)), 13));
  await flush();
  push({ type: "bar", sub: "s1", seq: 12, bar: bar(60, 150) });
  expect(shown(history())).toEqual(["0:0", "60:200"]);
});

test("페이지보다 옛 confirmed와 reload는 버린다", async () => {
  const { feed, calls, flush, history, push } = realtime();
  feed.open(key("005930", "1m"));
  calls[0]!.resolve(withSeq(page([bar(0)], null, bar(60, 200)), 12));
  await flush();
  push({ type: "confirmed", sub: "s1", seq: 11, bar: bar(60, 100) });
  push({ type: "reload", sub: "s1", seq: 12, reason: "gap_filled", from: 0 });
  expect(shown(history())).toEqual(["0:0", "60:200"]);
  expect(calls).toHaveLength(1);
  push({ type: "bar", sub: "s1", seq: 13, bar: bar(60, 210) });
  expect(shown(history())).toEqual(["0:0", "60:210"]);
});
