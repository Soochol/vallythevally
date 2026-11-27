import { describe, expect, it } from "vitest";
import type { BrokerDay } from "../../api/brokers";
import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { FeedEvent } from "../../api/socket";
import { createTodayBrokerFeed, FALLBACK_RECHECK_MS, TODAY_POLL_MS, type TodayBrokerFeedDeps } from "./dayFeed";

const CODE = "005930" as SymbolCode;
const DATE = "20261125";
const ts = (n: number) => n as UnixSeconds;

function snapshot(t: number, qty: number): FeedBrokers {
  return { t: ts(t), buys: [{ code: "001", name: "키움", qty, qtyChange: qty }], sells: [] };
}

function replyOf(partial: Partial<BrokerDay> & Pick<BrokerDay, "source">): BrokerDay {
  return {
    symbol: CODE,
    date: DATE,
    cursor: "",
    reset: false,
    live: partial.source === "flow",
    snapshots: [],
    gaps: [],
    ...partial,
  };
}

function createHarness() {
  let visible = true;
  let nextTimerId = 1;
  let nextFrameId = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const frames = new Map<number, () => void>();
  const visibilityListeners = new Set<() => void>();
  const fetchCalls: { code: SymbolCode; date: string; after?: string; signal?: AbortSignal; fallback?: "latest" }[] = [];
  const pendingFetches: { resolve: (reply: BrokerDay) => void; reject: (err: unknown) => void; signal?: AbortSignal }[] = [];
  const socketListeners = new Set<(event: FeedEvent) => void>();
  let liveSubCount = 0;

  const deps: TodayBrokerFeedDeps = {
    fetchDay(code, date, after, signal, fallback) {
      fetchCalls.push({ code, date, after, signal, fallback });
      return new Promise<BrokerDay>((resolve, reject) => {
        pendingFetches.push({ resolve, reject, signal });
      });
    },
    subscribeLive(_code, listener) {
      liveSubCount += 1;
      socketListeners.add(listener);
      return () => {
        socketListeners.delete(listener);
      };
    },
    setTimer(fn, ms) {
      const id = nextTimerId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    requestFrame(fn) {
      const id = nextFrameId++;
      frames.set(id, fn);
      return id;
    },
    cancelFrame(id) {
      frames.delete(id);
    },
    isDocumentVisible: () => visible,
    onVisibilityChange(listener) {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
  };

  return {
    deps,
    fetchCalls,
    pendingFetches,
    timers,
    frames,
    socketListeners,
    liveSubCount: () => liveSubCount,
    setVisible(next: boolean) {
      visible = next;
      for (const listener of visibilityListeners) listener();
    },
    emitSocket(event: FeedEvent) {
      for (const listener of [...socketListeners]) listener(event);
    },
    flushFrames() {
      const batch = [...frames.entries()];
      frames.clear();
      for (const [, fn] of batch) fn();
    },
    flushTimers() {
      const batch = [...timers.entries()];
      timers.clear();
      for (const [, entry] of batch) entry.fn();
    },
    async resolveFetch(reply: BrokerDay) {
      const next = pendingFetches.shift()!;
      next.resolve(reply);
      await Promise.resolve();
      await Promise.resolve();
    },
    async rejectFetch(error: Error) {
      const next = pendingFetches.shift()!;
      next.reject(error);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("createTodayBrokerFeed", () => {
  it("source가 none이면 라이브 WS로 전환하고 rAF 배치·실패·재시도를 처리한다", async () => {
    const h = createHarness();
    const feed = createTodayBrokerFeed(CODE, h.deps);
    feed.configure({ date: DATE, enabled: true, active: true });
    expect(feed.snapshot().mode).toBe("loading");

    await h.resolveFetch(replyOf({ source: "none" }));
    expect(feed.snapshot().mode).toBe("live");
    expect(h.liveSubCount()).toBe(1);

    h.emitSocket({ type: "feed_brokers", sub: "s1", brokers: snapshot(1000, 10) });
    h.emitSocket({ type: "feed_brokers", sub: "s1", brokers: snapshot(1060, 25) });
    expect(feed.snapshot().state.grid.times).toEqual([]);
    h.flushFrames();
    expect(feed.snapshot().state.grid.times).toEqual([1000, 1060]);

    h.emitSocket({ type: "sub_error", sub: "s1", code: "realtime_limit" });
    expect(feed.snapshot().failed).toBe(true);

    feed.retry();
    expect(feed.snapshot().failed).toBe(false);
    expect(h.liveSubCount()).toBe(2);
    h.flushFrames();
    expect(feed.snapshot().state.gapPending).toBe(true);

    h.emitSocket({ type: "feed_brokers", sub: "s2", brokers: snapshot(1120, 40) });
    h.flushFrames();
    expect(feed.snapshot().state.grid.gapBefore).toEqual([false, false, true]);

    feed.dispose();
    expect(h.socketListeners.size).toBe(0);
  });

  it("초기 REST 조회가 실패하면 라이브 WS 모드로 폴백한다", async () => {
    const h = createHarness();
    const feed = createTodayBrokerFeed(CODE, h.deps);
    feed.configure({ date: DATE, enabled: true, active: true });

    await h.rejectFetch(new Error("offline"));
    expect(feed.snapshot().mode).toBe("live");
    expect(h.liveSubCount()).toBe(1);
    feed.dispose();
  });

  it("수집 source가 flow면 커서로 폴링하고 비가시 상태에서 멈췄다가 복귀 시 즉시 재개하며 store 전환 시 중단한다", async () => {
    const h = createHarness();
    const feed = createTodayBrokerFeed(CODE, h.deps);
    feed.configure({ date: DATE, enabled: true, active: true });

    await h.resolveFetch(replyOf({ source: "flow", cursor: "c1", snapshots: [snapshot(1000, 10)] }));
    expect(feed.snapshot().mode).toBe("collected");
    expect(feed.snapshot().state.grid.times).toEqual([1000]);
    expect(h.timers.size).toBe(1);
    expect([...h.timers.values()][0]!.ms).toBe(TODAY_POLL_MS);

    h.setVisible(false);
    expect(h.timers.size).toBe(0);

    h.setVisible(true);
    expect(h.fetchCalls).toHaveLength(2);
    expect(h.fetchCalls[1]!.after).toBe("c1");

    await h.resolveFetch(replyOf({ source: "store", cursor: "c2", snapshots: [snapshot(1060, 20)], gaps: [[ts(1010), ts(1050)]] }));
    expect(feed.snapshot().source).toBe("store");
    expect(feed.snapshot().state.grid.times).toEqual([1000, 1060]);
    expect(feed.snapshot().gaps).toEqual([[1010, 1050]]);
    expect(h.timers.size).toBe(0);

    feed.dispose();
  });

  it("과거 날짜로 잠시 이동했다가 오늘로 돌아오면 라이브 상태를 보존하고 resync 간격을 표시한다", async () => {
    const h = createHarness();
    const feed = createTodayBrokerFeed(CODE, h.deps);
    feed.configure({ date: DATE, enabled: true, active: true });
    await h.resolveFetch(replyOf({ source: "none" }));

    h.emitSocket({ type: "feed_brokers", sub: "s1", brokers: snapshot(1000, 10) });
    h.flushFrames();
    expect(feed.snapshot().state.grid.times).toEqual([1000]);

    feed.configure({ date: "20261124", enabled: false, active: true });
    expect(h.socketListeners.size).toBe(0);
    expect(feed.snapshot().mode).toBe("loading");

    feed.configure({ date: DATE, enabled: true, active: true });
    await h.resolveFetch(replyOf({ source: "none" }));
    expect(feed.snapshot().state.grid.times).toEqual([1000]);
    h.flushFrames();
    expect(feed.snapshot().state.gapPending).toBe(true);

    h.emitSocket({ type: "feed_brokers", sub: "s2", brokers: snapshot(1060, 30) });
    h.flushFrames();
    expect(feed.snapshot().state.grid.times).toEqual([1000, 1060]);
    expect(feed.snapshot().state.grid.gapBefore).toEqual([false, true]);

    feed.dispose();
  });

  it("직전 마감일 폴백을 표시하다가 실시간 스냅샷이 오면 라이브로 자동 전환한다", async () => {
    const h = createHarness();
    const feed = createTodayBrokerFeed(CODE, h.deps);
    feed.configure({ date: DATE, enabled: true, active: true, allowFallback: true });
    expect(h.fetchCalls[0]!.fallback).toBe("latest");

    await h.resolveFetch(replyOf({ date: "20261124", source: "store", live: false, snapshots: [snapshot(500, 80)] }));
    expect(feed.snapshot().mode).toBe("fallback");
    expect(feed.snapshot().date).toBe("20261124");
    expect(feed.snapshot().state.grid.times).toEqual([500]);
    expect(h.liveSubCount()).toBe(1);
    expect([...h.timers.values()][0]!.ms).toBe(FALLBACK_RECHECK_MS);

    h.emitSocket({ type: "sub_error", sub: "s1", code: "kiwoom_unavailable" });
    expect(feed.snapshot().mode).toBe("fallback");
    expect(feed.snapshot().failed).toBe(false);

    h.emitSocket({ type: "feed_brokers", sub: "s1", brokers: snapshot(1000, 120) });
    expect(h.timers.size).toBe(0);
    h.flushFrames();
    expect(feed.snapshot().mode).toBe("live");
    expect(feed.snapshot().date).toBeNull();
    expect(feed.snapshot().state.grid.times).toEqual([1000]);

    feed.dispose();
  });

  it("직전 마감일 폴백 중 재확인에서 당일 흐름이 생기면 수집 모드로 자동 전환하고 라이브를 닫는다", async () => {
    const h = createHarness();
    const feed = createTodayBrokerFeed(CODE, h.deps);
    feed.configure({ date: DATE, enabled: true, active: true, allowFallback: true });

    await h.resolveFetch(replyOf({ date: "20261124", source: "store", live: false, snapshots: [snapshot(500, 80)] }));
    expect(feed.snapshot().mode).toBe("fallback");
    expect(h.socketListeners.size).toBe(1);

    h.setVisible(false);
    expect(h.timers.size).toBe(0);

    h.setVisible(true);
    expect(h.fetchCalls).toHaveLength(2);
    expect(h.fetchCalls[1]!.fallback).toBeUndefined();

    await h.resolveFetch(replyOf({ date: DATE, source: "flow", cursor: "f:1:1", snapshots: [snapshot(1000, 200)], reset: true }));
    expect(feed.snapshot().mode).toBe("collected");
    expect(feed.snapshot().date).toBe(DATE);
    expect(feed.snapshot().state.grid.times).toEqual([1000]);
    expect(h.socketListeners.size).toBe(0);
    expect([...h.timers.values()][0]!.ms).toBe(TODAY_POLL_MS);

    feed.dispose();
  });

  it("수집 모드에서 720개를 넘는 스냅샷은 분 단위로 압축해 격자 크기를 제한한다", async () => {
    const h = createHarness();
    const feed = createTodayBrokerFeed(CODE, h.deps);
    feed.configure({ date: DATE, enabled: true, active: true });
    const start = 1_760_000_040;
    const snapshots = Array.from({ length: 900 }, (_, i) => snapshot(start + i * 2, (i + 1) * 10));
    await h.resolveFetch(replyOf({ source: "flow", cursor: "c900", snapshots }));
    expect(feed.snapshot().state.grid.times.length).toBeLessThanOrEqual(40);
    expect(feed.snapshot().state.grid.times.at(-1)).toBe(start + 899 * 2);
    feed.dispose();
  });
});
