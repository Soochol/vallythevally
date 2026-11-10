import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Quote } from "../api/generated/Quote";
import type { SymbolCode } from "../api/generated/SymbolCode";
import { ApiRequestError } from "../api/http";
import type { QuoteEvent } from "../api/socket";
import { QuoteBook } from "./quoteBook";

const quote = (symbol: SymbolCode, price: number, source: Quote["source"] = "realtime"): Quote => ({
  symbol,
  price,
  change: 0,
  changeRate: 0,
  volume: 1,
  t: 1_000,
  source,
});

interface Fetch {
  symbols: SymbolCode[];
  resolve(quotes: Quote[]): void;
  reject(error: unknown): void;
}

function setup() {
  const watches: SymbolCode[][] = [];
  const fetches: Fetch[] = [];
  let emit: (e: QuoteEvent) => void = () => {};
  const book = new QuoteBook({
    socket: {
      setWatch: (symbols) => watches.push([...symbols]),
      onQuotes: (handler) => {
        emit = handler;
        return () => {};
      },
    },
    fetchQuotes: (symbols) =>
      new Promise((resolve, reject) => {
        fetches.push({ symbols: [...symbols], resolve, reject });
      }),
  });
  const price = (code: SymbolCode) => book.get(code).quote?.price;
  const realtime = (...quotes: Quote[]) => emit({ type: "quotes", quotes });
  return { book, watches, fetches, price, realtime, emit: (e: QuoteEvent) => emit(e) };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("QuoteBook", () => {
  test("목록에 처음 들어온 종목만 묶어 REST를 한 번 부르고, 합친 목록을 서버에 알린다", async () => {
    const { book, watches, fetches, price } = setup();
    const release = book.lease(["005930", "000660"]);
    await settle();
    expect(watches).toEqual([["005930", "000660"]]);
    expect(fetches.map((f) => f.symbols)).toEqual([["005930", "000660"]]);
    fetches[0]!.resolve([quote("005930", 71_000, "polled"), quote("000660", 180_000, "polled")]);
    await settle();
    expect(price("005930")).toBe(71_000);

    release();
    book.lease(["005930", "000660", "IDX:001"]);
    await settle();
    expect(fetches.map((f) => f.symbols)).toEqual([["005930", "000660"], ["IDX:001"]]);
    expect(price("005930")).toBe(71_000);
  });

  test("순서를 바꾸면 서버에 새 순서만 알리고 REST를 다시 부르지 않는다. 값은 그대로다", async () => {
    const { book, watches, fetches, price } = setup();
    const release = book.lease(["005930", "000660"]);
    await settle();
    fetches[0]!.resolve([quote("005930", 71_000, "polled")]);
    await settle();

    release();
    book.lease(["000660", "005930"]);
    await settle();
    expect(watches).toEqual([
      ["005930", "000660"],
      ["000660", "005930"],
    ]);
    expect(fetches).toHaveLength(1);
    expect(price("005930")).toBe(71_000);
  });

  test("watch_limited와 다시 연결은 REST를 부르지 않는다. 다시 연결되면 limited만 지우고 값은 둔다", async () => {
    const { book, fetches, price, realtime, emit } = setup();
    book.lease(["005930", "000660"]);
    await settle();
    realtime(quote("000660", 180_000));
    emit({ type: "watch_limited", symbols: ["000660"] });
    expect(book.get("000660").limited).toBe(true);
    expect(book.get("005930").limited).toBe(false);

    emit({ type: "resync" });
    await settle();
    expect(book.get("000660")).toEqual({ quote: quote("000660", 180_000), limited: false });
    expect(price("000660")).toBe(180_000);

    emit({ type: "watch_limited", symbols: ["005930", "000660"] });
    emit({ type: "watch_limited", symbols: [] });
    await settle();
    expect(fetches).toHaveLength(1);
  });

  test("실시간 값이 REST를 이긴다. REST가 늦게 와도 덮지 않는다", async () => {
    const { book, fetches, price, realtime } = setup();
    book.lease(["005930", "000660"]);
    await settle();
    realtime(quote("005930", 71_500));
    fetches[0]!.resolve([quote("005930", 71_000, "polled"), quote("000660", 180_000, "polled")]);
    await settle();
    expect(price("005930")).toBe(71_500);
    expect(price("000660")).toBe(180_000);

    realtime(quote("000660", 181_000));
    expect(price("000660")).toBe(181_000);
  });

  test("목록에서 빠진 종목은 값과 limited를 지우고, 다시 들어오면 REST를 한 번 더 부른다", async () => {
    const { book, fetches, price, realtime, emit } = setup();
    const release = book.lease(["005930", "000660"]);
    await settle();
    realtime(quote("000660", 180_000));
    emit({ type: "watch_limited", symbols: ["000660"] });

    release();
    const again = book.lease(["005930"]);
    await settle();
    expect(book.get("000660")).toEqual({ quote: undefined, limited: false });
    realtime(quote("000660", 182_000));
    fetches[0]!.resolve([quote("000660", 179_000, "polled")]);
    await settle();
    expect(price("000660")).toBeUndefined();

    again();
    book.lease(["005930", "000660"]);
    await settle();
    expect(fetches.map((f) => f.symbols)).toEqual([["005930", "000660"], ["000660"]]);
  });

  test("빠졌다가 서버가 새로 알리기 전에 다시 들어온 종목은 마지막 watch_limited대로 실시간 아님이다", async () => {
    const { book, emit } = setup();
    const release = book.lease(["005930", "000660"]);
    await settle();
    emit({ type: "watch_limited", symbols: ["000660"] });

    release();
    await settle();
    expect(book.get("000660").limited).toBe(false);
    book.lease(["005930", "000660"]);
    await settle();
    expect(book.get("000660").limited).toBe(true);
    expect(book.get("005930").limited).toBe(false);

    emit({ type: "watch_limited", symbols: [] });
    expect(book.get("000660").limited).toBe(false);
  });

  test("두 목록이 빌리면 순서대로 합치고 겹친 종목은 처음 자리만 남긴다. 마지막 lease가 풀리면 빈 목록을 알린다", async () => {
    const { book, watches, fetches } = setup();
    const desktop = book.lease(["005930", "000660"]);
    await settle();
    const phone = book.lease(["000660", "IDX:001"]);
    await settle();
    expect(watches).toEqual([
      ["005930", "000660"],
      ["005930", "000660", "IDX:001"],
    ]);
    expect(fetches.map((f) => f.symbols)).toEqual([["005930", "000660"], ["IDX:001"]]);
    const subset = book.lease(["IDX:001"]);
    await settle();
    subset();
    await settle();
    expect(watches).toHaveLength(2);

    desktop();
    await settle();
    expect(watches[watches.length - 1]).toEqual(["000660", "IDX:001"]);
    phone();
    await settle();
    expect(watches[watches.length - 1]).toEqual([]);
    expect(fetches).toHaveLength(2);
  });

  test("같은 틱에 lease를 풀고 다시 잡으면(StrictMode) 서버에도 REST에도 한 번만 간다", async () => {
    const { book, watches, fetches } = setup();
    book.lease(["005930"])();
    book.lease(["005930"]);
    await settle();
    expect(watches).toEqual([["005930"]]);
    expect(fetches).toHaveLength(1);
  });

  test("줄마다 자기 종목이 바뀔 때만 알리고, 같은 상태면 같은 객체를 돌려준다", async () => {
    const { book, realtime, emit } = setup();
    book.lease(["005930", "000660"]);
    await settle();
    const calls: SymbolCode[] = [];
    book.subscribe("005930", () => calls.push("005930"));
    const off = book.subscribe("000660", () => calls.push("000660"));
    const before = book.get("005930");
    expect(book.get("005930")).toBe(before);

    realtime(quote("000660", 180_000));
    emit({ type: "watch_limited", symbols: [] });
    expect(book.get("005930")).toBe(before);
    expect(calls).toEqual(["000660"]);

    off();
    realtime(quote("000660", 181_000), quote("005930", 71_000));
    expect(calls).toEqual(["000660", "005930"]);
  });

  test("서버에 닿지 못한 REST는 retry 규칙대로 두 번까지 다시 부르고, 그 뒤 주기 조회는 없다", async () => {
    const { book, fetches, price } = setup();
    book.lease(["005930", "000660"]);
    await settle();
    const network = new ApiRequestError("network", "서버에 연결하지 못했습니다");
    fetches[0]!.reject(network);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetches.map((f) => f.symbols)).toEqual([
      ["005930", "000660"],
      ["005930", "000660"],
    ]);
    fetches[1]!.reject(network);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetches).toHaveLength(3);
    fetches[2]!.reject(network);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetches).toHaveLength(3);
    expect(price("005930")).toBeUndefined();
  });

  test("다시 부를 때는 아직 목록에 있고 값이 없는 종목만 묻는다", async () => {
    const { book, fetches, realtime } = setup();
    const release = book.lease(["005930", "000660", "IDX:001"]);
    await settle();
    fetches[0]!.reject(new ApiRequestError("network", "서버에 연결하지 못했습니다"));
    await settle();
    realtime(quote("005930", 71_000));
    release();
    book.lease(["005930", "000660"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetches.map((f) => f.symbols)).toEqual([["005930", "000660", "IDX:001"], ["000660"]]);
  });

  test("사람이 고쳐야 하는 실패는 다시 부르지 않는다", async () => {
    const { book, fetches } = setup();
    book.lease(["005930"]);
    await settle();
    fetches[0]!.reject(new ApiRequestError("kiwoom_unavailable", "m", { reason: "unknown_failure", retryAt: null, manualActionRequired: true }));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetches).toHaveLength(1);
  });
});
