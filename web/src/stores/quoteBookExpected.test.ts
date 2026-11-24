import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Quote } from "../api/generated/Quote";
import type { QuoteEvent } from "../api/socket";
import { QuoteBook } from "./quoteBook";

const CODE = "005930";

const quote = (price: number, change: number, volume: number, source: Quote["source"]): Quote => ({
  symbol: CODE,
  price,
  change,
  changeRate: (change / (price - change)) * 100,
  volume,
  t: 1_000,
  source,
  venue: "combined",
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("예상 시세는 앞 줄의 거래량을 지운다고 보지 않는다", async () => {
  let emit: (e: QuoteEvent) => void = () => {};
  const book = new QuoteBook({
    socket: {
      setWatch: () => {},
      onQuotes: (handler) => {
        emit = handler;
        return () => {};
      },
    },
    fetchQuotes: () => new Promise(() => {}),
  });
  book.lease([CODE]);
  await vi.advanceTimersByTimeAsync(0);
  emit({ type: "quotes", venue: "combined", quotes: [quote(177_500, 0, 1_000, "realtime")] });
  emit({ type: "quotes", venue: "combined", quotes: [quote(194_900, 17_400, 0, "expected")] });
  const row = book.get(CODE).quote;
  expect(row).toMatchObject({ price: 194_900, change: 17_400, source: "expected", volume: 1_000 });
  expect(row?.changeRate).toBeCloseTo((17_400 / 177_500) * 100, 9);
});
