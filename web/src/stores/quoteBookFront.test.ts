import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SymbolCode } from "../api/generated/SymbolCode";
import { QuoteBook } from "./quoteBook";

function setup() {
  const watches: SymbolCode[][] = [];
  const fetches: SymbolCode[][] = [];
  const book = new QuoteBook({
    socket: {
      setWatch: (symbols) => {
        watches.push([...symbols]);
      },
      onQuotes: () => () => {},
    },
    fetchQuotes: (symbols) => {
      fetches.push([...symbols]);
      return Promise.resolve([]);
    },
  });
  return { book, watches, fetches };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("QuoteBook 앞자리 lease", () => {
  test("앞자리 lease의 종목은 다른 lease보다 앞에 서고 순서만 바뀌면 REST를 다시 부르지 않는다", async () => {
    const { book, watches, fetches } = setup();
    book.lease(["005930", "000660"]);
    await settle();
    const release = book.lease(["035420", "000660"], { front: true });
    await settle();
    expect(watches.at(-1)).toEqual(["035420", "000660", "005930"]);
    expect(fetches).toEqual([["005930", "000660"], ["035420"]]);

    release();
    await settle();
    expect(watches.at(-1)).toEqual(["005930", "000660"]);
    expect(fetches).toHaveLength(2);
  });

  test("같은 종목을 여러 화면이 앞자리로 잡으면 마지막이 놓을 때만 구독이 풀린다", async () => {
    const { book, watches, fetches } = setup();
    const first = book.lease(["005930", "000660"], { front: true });
    await settle();
    const second = book.lease(["005930", "000660"], { front: true });
    await settle();
    first();
    await settle();
    expect(watches).toEqual([["005930", "000660"]]);
    second();
    await settle();
    expect(watches).toEqual([["005930", "000660"], []]);
    expect(fetches).toEqual([["005930", "000660"]]);
  });
});
