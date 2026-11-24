import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { QuoteDayState } from "../../api/generated/QuoteDayState";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { QuoteFeed, type QuoteKey, type QuotePage, type QuoteRange } from "./feed";

interface Point { t: UnixSeconds; v: number }

interface Call {
  range: QuoteRange;
  reply(points: Point[], state?: QuoteDayState): Promise<void>;
}

const KEY: QuoteKey = { symbol: "005930", venue: "combined", period: "1m" };
const at = (text: string): UnixSeconds => Date.parse(`${text}+09:00`) / 1000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("떨어진 구간을 오가도 사이를 받지 않고 필요할 때만 받는다", async () => {
  const calls: Call[] = [];
  const settle = async () => { await vi.advanceTimersByTimeAsync(0); };
  const feed = new QuoteFeed<Point>({
    fetch: (_key, range) => new Promise<QuotePage<Point>>((resolve) => {
      calls.push({
        range,
        reply: async (points, state = "closed") => {
          resolve({ days: [{ date: range.to, state }], points });
          await settle();
        },
      });
    }),
    changed: () => {},
    now: () => at("2026-11-24T21:00:00"),
  });
  feed.open(KEY);

  const pSep = { t: at("2026-09-03T10:00:00"), v: 9 };
  const pNov = { t: at("2026-11-22T10:00:00"), v: 11 };
  const pOct = { t: at("2026-10-05T10:00:00"), v: 10 };

  feed.cover(at("2026-09-01T09:00:00"), at("2026-09-05T15:20:00"));
  await calls.at(-1)!.reply([pSep]);

  feed.cover(at("2026-11-20T09:00:00"), at("2026-11-24T15:20:00"));
  await calls.at(-1)!.reply([pNov]);

  feed.cover(at("2026-10-01T09:00:00"), at("2026-10-10T15:20:00"));
  await calls.at(-1)!.reply([pOct]);

  feed.cover(at("2026-09-01T09:00:00"), at("2026-09-05T15:20:00"));

  expect(calls.map((c) => c.range)).toEqual([
    { from: "2026-09-01", to: "2026-09-05" },
    { from: "2026-11-20", to: "2026-11-24" },
    { from: "2026-10-01", to: "2026-10-10" },
  ]);
  expect(feed.at(pSep.t)?.v).toBe(9);
  expect(feed.at(pNov.t)?.v).toBe(11);
  expect(feed.at(pOct.t)?.v).toBe(10);
  feed.dispose();
});
