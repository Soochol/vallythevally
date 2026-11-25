import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { QuoteDayState } from "../../api/generated/QuoteDayState";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { QuoteFeed, TAIL_EVERY_MS, type QuoteKey, type QuotePage, type QuoteRange } from "./feed";

interface Point { t: UnixSeconds; v: number }

interface Call {
  key: QuoteKey;
  range: QuoteRange;
  signal: AbortSignal;
  reply(points: Point[], state?: QuoteDayState, available?: boolean): Promise<void>;
  fail(): Promise<void>;
}

const KEY: QuoteKey = { symbol: "005930", venue: "combined", period: "1m" };
const at = (text: string): UnixSeconds => Date.parse(`${text}+09:00`) / 1000;
const clock = { now: at("2026-11-24T10:00:00") };

function started(key: QuoteKey | null = KEY) {
  const calls: Call[] = [];
  const changes: (UnixSeconds | null)[] = [];
  const settle = async () => { await vi.advanceTimersByTimeAsync(0); };
  const feed = new QuoteFeed<Point>({
    fetch: (requested, range, signal) => new Promise<QuotePage<Point>>((resolve, reject) => {
      calls.push({
        key: requested, range, signal,
        reply: async (points, state = "closed", available = true) => { resolve({ available, days: [{ date: range.to, state }], points }); await settle(); },
        fail: async () => { reject(new Error("실패")); await settle(); },
      });
    }),
    changed: (from) => changes.push(from),
    now: () => clock.now,
  });
  feed.open(key);
  return { feed, calls, changes, last: () => calls[calls.length - 1]!, ranges: () => calls.map(({ range }) => range) };
}

beforeEach(() => {
  vi.useFakeTimers();
  clock.now = at("2026-11-24T10:00:00");
});
afterEach(() => vi.useRealTimers());

const five = async (times = 1) => {
  for (let i = 0; i < times; i++) {
    clock.now += TAIL_EVERY_MS / 1000;
    await vi.advanceTimersByTimeAsync(TAIL_EVERY_MS);
  }
};

test("보이는 봉 범위만큼 나눠 받고 다시 받지 않는다", async () => {
  const f = started();
  expect(f.calls).toHaveLength(0);
  f.feed.cover(at("2026-10-12T09:00:00"), at("2026-11-20T15:20:00"));
  expect(f.ranges()).toEqual([{ from: "2026-10-21", to: "2026-11-20" }]);
  await f.last().reply([{ t: at("2026-11-20T09:00:00"), v: 1 }]);
  expect(f.ranges()[1]).toEqual({ from: "2026-10-12", to: "2026-10-20" });
  await f.last().reply([{ t: at("2026-10-12T09:00:00"), v: 2 }]);
  f.feed.cover(at("2026-10-12T09:00:00"), at("2026-11-20T15:20:00"));
  expect(f.calls).toHaveLength(2);
  f.feed.cover(at("2026-10-11T09:00:00"), at("2026-11-20T15:20:00"));
  expect(f.ranges()[2]).toEqual({ from: "2026-10-11", to: "2026-10-11" });
  await f.last().reply([], "none");
  expect(f.calls).toHaveLength(3);
  expect(f.feed.at(at("2026-11-20T09:00:00"))?.v).toBe(1);
  expect(f.feed.at(at("2026-10-12T09:00:00"))?.v).toBe(2);
  expect(f.feed.at(at("2026-10-13T09:00:00"))).toBeUndefined();
  expect(f.feed.state).toBe("ready");
  expect(f.changes.filter((from) => from === null).length).toBeGreaterThan(0);
  await five(3);
  expect(f.calls).toHaveLength(3);
  f.feed.dispose();
});

test("종목이나 주기를 바꾸면 앞 요청을 버린다", async () => {
  const f = started();
  f.feed.cover(at("2026-11-20T09:00:00"), at("2026-11-20T15:20:00"));
  const stale = f.last();
  f.feed.open({ ...KEY, period: "5m" });
  expect(stale.signal.aborted).toBe(true);
  await stale.reply([{ t: at("2026-11-20T09:00:00"), v: 1 }]);
  expect(f.feed.at(at("2026-11-20T09:00:00"))).toBeUndefined();
  expect(f.feed.state).toBe("loading");
  f.feed.cover(at("2026-11-20T09:00:00"), at("2026-11-20T15:20:00"));
  expect(f.last().key.period).toBe("5m");
  await f.last().reply([{ t: at("2026-11-20T09:00:00"), v: 5 }]);
  f.feed.open({ ...KEY, period: "5m" });
  expect(f.feed.at(at("2026-11-20T09:00:00"))?.v).toBe(5);
  f.feed.open(null);
  expect(f.feed.at(at("2026-11-20T09:00:00"))).toBeUndefined();
  const count = f.calls.length;
  f.feed.cover(at("2026-11-24T09:00:00"), at("2026-11-24T10:00:00"));
  await five(2);
  expect(f.calls).toHaveLength(count);
});

test("장중에는 5초마다 꼬리만 받아 바뀐 자리부터 알린다", async () => {
  const f = started();
  const p = (time: string, v: number): Point => ({ t: at(`2026-11-24T${time}:00`), v });
  f.feed.cover(at("2026-11-23T09:00:00"), at("2026-11-24T10:00:00"));
  await f.last().reply([p("09:58", 1), p("09:59", 2), p("10:00", 3)], "live");
  f.changes.length = 0;

  await five();
  expect(f.last().range).toEqual({ from: "2026-11-24", to: "2026-11-24", after: at("2026-11-24T09:59:00") });
  await five();
  expect(f.calls).toHaveLength(2);
  await f.last().reply([p("09:59", 2), p("10:00", 4), p("10:01", 5)], "live");
  expect(f.changes).toEqual([at("2026-11-24T10:00:00")]);
  expect(f.feed.at(at("2026-11-24T10:01:00"))?.v).toBe(5);
  expect(f.feed.at(at("2026-11-24T09:58:00"))?.v).toBe(1);

  await five();
  expect(f.last().range.after).toBe(at("2026-11-24T10:00:00"));
  await f.last().reply([p("10:00", 4)], "live");
  expect(f.changes).toEqual([at("2026-11-24T10:00:00"), at("2026-11-24T10:01:00")]);
  expect(f.feed.at(at("2026-11-24T10:01:00"))).toBeUndefined();

  await five();
  await f.last().reply([p("09:59", 2), p("10:00", 4)], "live");
  expect(f.changes).toHaveLength(2);

  await five();
  await f.last().fail();
  expect(f.feed.state).toBe("ready");

  const count = f.calls.length;
  clock.now = at("2026-11-24T20:05:01");
  await five(2);
  expect(f.calls).toHaveLength(count);
  f.feed.dispose();
});

test("수집하지 않는 종목과 실패를 상태로 알리고 실패는 다시 받는다", async () => {
  const f = started();
  expect(f.feed.state).toBe("loading");
  f.feed.cover(at("2026-11-20T09:00:00"), at("2026-11-20T15:20:00"));
  await f.last().reply([], "notCollected");
  expect(f.feed.state).toBe("notCollected");
  f.feed.cover(at("2026-11-19T09:00:00"), at("2026-11-20T15:20:00"));
  await f.last().reply([], "none");
  expect(f.feed.state).toBe("notCollected");
  f.feed.cover(at("2026-11-18T09:00:00"), at("2026-11-20T15:20:00"));
  await f.last().reply([{ t: at("2026-11-18T09:00:00"), v: 1 }], "closed");
  expect(f.feed.state).toBe("ready");

  const g = started({ ...KEY, symbol: "000660" });
  g.feed.cover(at("2026-11-20T09:00:00"), at("2026-11-20T15:20:00"));
  await g.last().fail();
  expect(g.feed.state).toBe("failed");
  expect(g.calls).toHaveLength(1);
  await five();
  expect(g.calls).toHaveLength(2);
  expect(g.ranges()[1]).toEqual({ from: "2026-11-20", to: "2026-11-20" });
  await g.last().reply([], "none");
  expect(g.feed.state).toBe("ready");
  g.feed.dispose();
  f.feed.dispose();
});

test("서버에 호가 자료 폴더가 없으면 disabled 상태로 알리고 장중 꼬리 조회를 멈춘다", async () => {
  const f = started();
  f.feed.cover(at("2026-11-24T09:00:00"), at("2026-11-24T10:00:00"));
  await f.last().reply([], "none", false);
  expect(f.feed.state).toBe("disabled");
  expect(f.calls).toHaveLength(1);
  await five(3);
  expect(f.calls).toHaveLength(1);
  f.feed.dispose();
});
