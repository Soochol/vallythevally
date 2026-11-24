import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Quote } from "../api/generated/Quote";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { Venue } from "../api/generated/Venue";
import { ApiRequestError } from "../api/http";
import type { Connection, QuoteEvent } from "../api/socket";
import { QuoteBook } from "./quoteBook";

const quote = (symbol: SymbolCode, price: number, source: Quote["source"] = "realtime"): Quote => ({
  symbol,
  price,
  change: 0,
  changeRate: 0,
  volume: 1,
  t: 1_000,
  source,
  venue: "combined",
});

interface Fetch {
  symbols: SymbolCode[];
  venue: Venue;
  resolve(quotes: Quote[]): void;
  reject(error: unknown): void;
}

function setup() {
  const watches: SymbolCode[][] = [];
  const watchVenues: Venue[] = [];
  const fetches: Fetch[] = [];
  let emit: (e: QuoteEvent) => void = () => {};
  let notifyConnection: (c: Connection) => void = () => {};
  const book = new QuoteBook({
    socket: {
      setWatch: (symbols, venue) => {
        watches.push([...symbols]);
        watchVenues.push(venue);
      },
      onQuotes: (handler) => {
        emit = handler;
        return () => {};
      },
      watch: (listener) => {
        notifyConnection = listener;
        listener({ socket: "open", status: { realtime: "live", since: 1_000, backfilling: false } });
        return () => {};
      },
    },
    fetchQuotes: (symbols, venue) =>
      new Promise((resolve, reject) => {
        fetches.push({ symbols: [...symbols], venue, resolve, reject });
      }),
  });
  const price = (code: SymbolCode) => book.get(code).quote?.price;
  const realtime = (...quotes: Quote[]) => emit({ type: "quotes", venue: "combined", quotes });
  const realtimeIn = (venue: Venue, ...quotes: Quote[]) => emit({ type: "quotes", venue, quotes });
  return { book, watches, watchVenues, realtimeIn, fetches, price, realtime, emit: (e: QuoteEvent) => emit(e), setConnection: (c: Connection) => notifyConnection(c) };
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
    expect(book.get("000660")).toEqual({ quote: quote("000660", 180_000), limited: false, stale: true });
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
    expect(book.get("000660")).toEqual({ quote: undefined, limited: false, stale: false });
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

  test("닫았다 다시 연 목록은 닫기 전 REST가 늦게 와도 새로 부른 값을 쓴다", async () => {
    const { book, fetches, emit } = setup();
    const close = book.lease(["005930"]);
    await settle();
    emit({ type: "watch_limited", symbols: ["005930"] });
    close();
    await settle();
    book.lease(["005930"]);
    await settle();

    fetches[0]!.resolve([quote("005930", 50_000, "polled")]);
    await settle();
    fetches[1]!.resolve([quote("005930", 51_500, "polled")]);
    await settle();
    expect(book.get("005930")).toEqual({ quote: quote("005930", 51_500, "polled"), limited: true, stale: true });
  });

  test("함께 부른 종목 중 빠졌다 돌아온 종목만 옛 응답을 버린다", async () => {
    const { book, fetches, price } = setup();
    const both = book.lease(["005930", "000660"]);
    await settle();
    both();
    const one = book.lease(["005930"]);
    await settle();
    one();
    book.lease(["005930", "000660"]);
    await settle();
    expect(fetches.map((f) => f.symbols)).toEqual([["005930", "000660"], ["000660"]]);

    fetches[0]!.resolve([quote("005930", 71_000, "polled"), quote("000660", 179_000, "polled")]);
    await settle();
    expect(price("005930")).toBe(71_000);
    expect(price("000660")).toBeUndefined();
    fetches[1]!.resolve([quote("000660", 180_000, "polled")]);
    await settle();
    expect(price("000660")).toBe(180_000);
  });

  test("닫힌 목록의 재시도는 다시 연 목록에서 REST를 더 부르지 않고, 새 진입의 재시도는 그대로 간다", async () => {
    const { book, fetches } = setup();
    const network = new ApiRequestError("network", "서버에 연결하지 못했습니다");
    const close = book.lease(["005930"]);
    await settle();
    fetches[0]!.reject(network);
    await settle();
    close();
    await settle();
    book.lease(["005930"]);
    await settle();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetches).toHaveLength(2);
    fetches[1]!.reject(network);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetches.map((f) => f.symbols)).toEqual([["005930"], ["005930"], ["005930"]]);
  });

  test("사람이 고쳐야 하는 실패는 다시 부르지 않는다", async () => {
    const { book, fetches } = setup();
    book.lease(["005930"]);
    await settle();
    fetches[0]!.reject(new ApiRequestError("kiwoom_unavailable", "m", { reason: "unknown_failure", retryAt: null, manualActionRequired: true }));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetches).toHaveLength(1);
  });

  describe("앱 전체 거래소", () => {
    const inVenue = (venue: Venue, symbol: SymbolCode, price: number): Quote => ({ ...quote(symbol, price), venue });

    test("거래소를 바꾸면 줄 값을 비우고 새 거래소로 watch와 REST를 다시 보낸다", async () => {
      const { book, watches, watchVenues, fetches, price, realtimeIn } = setup();
      book.lease(["005930", "000660"]);
      await settle();
      expect(watchVenues).toEqual(["combined"]);
      expect(fetches.map((f) => f.venue)).toEqual(["combined"]);
      fetches[0]!.resolve([inVenue("combined", "005930", 71_000)]);
      await settle();

      book.setVenue("krx");
      expect(price("005930")).toBeUndefined();
      expect(watches).toEqual([["005930", "000660"], ["005930", "000660"]]);
      expect(watchVenues).toEqual(["combined", "krx"]);
      expect(fetches.map((f) => [f.symbols, f.venue])).toEqual([[["005930", "000660"], "combined"], [["005930", "000660"], "krx"]]);
      fetches[1]!.resolve([inVenue("krx", "005930", 70_500)]);
      await settle();
      expect(price("005930")).toBe(70_500);
      realtimeIn("krx", inVenue("krx", "005930", 70_600));
      expect(price("005930")).toBe(70_600);
    });

    test("같은 거래소를 다시 알리면 아무것도 보내지 않는다", async () => {
      const { book, watches, fetches, price } = setup();
      book.lease(["005930"]);
      await settle();
      fetches[0]!.resolve([quote("005930", 71_000, "polled")]);
      await settle();
      book.setVenue("combined");
      await settle();
      expect(watches).toHaveLength(1);
      expect(fetches).toHaveLength(1);
      expect(price("005930")).toBe(71_000);
    });

    test("거래소를 바꾼 뒤 늦게 온 옛 거래소의 REST 응답은 쓰지 않는다", async () => {
      const { book, fetches, price } = setup();
      book.lease(["005930"]);
      await settle();
      book.setVenue("nxt");
      fetches[0]!.resolve([inVenue("combined", "005930", 71_000)]);
      await settle();
      expect(price("005930")).toBeUndefined();
      fetches[1]!.resolve([inVenue("nxt", "005930", 70_000)]);
      await settle();
      expect(price("005930")).toBe(70_000);
    });

    test("거래소를 바꾼 뒤 늦게 온 옛 거래소의 실시간 시세는 쓰지 않는다", async () => {
      const { book, fetches, price, realtimeIn } = setup();
      book.lease(["005930"]);
      await settle();
      book.setVenue("krx");
      realtimeIn("combined", inVenue("combined", "005930", 71_000));
      expect(price("005930")).toBeUndefined();
      realtimeIn("krx", inVenue("krx", "005930", 70_500));
      expect(price("005930")).toBe(70_500);
      fetches[1]!.resolve([inVenue("krx", "005930", 70_000)]);
      await settle();
      expect(price("005930")).toBe(70_500);
    });

    test("거래소를 바꾸면 서버가 이미 알린 실시간 아님은 값 없이 남는다", async () => {
      const { book, emit } = setup();
      book.lease(["005930"]);
      await settle();
      emit({ type: "watch_limited", symbols: ["005930"] });
      book.setVenue("krx");
      expect(book.get("005930")).toEqual({ quote: undefined, limited: true, stale: true });
    });

    test("보는 종목이 없을 때 바꾼 거래소는 다음에 종목이 들어올 때 쓴다", async () => {
      const { book, watches, watchVenues, fetches } = setup();
      book.setVenue("nxt");
      await settle();
      expect(watches).toEqual([]);
      book.lease(["005930"]);
      await settle();
      expect(watchVenues).toEqual(["nxt"]);
      expect(fetches.map((f) => f.venue)).toEqual(["nxt"]);
    });

    test("거래소를 바꾼 뒤 실패한 옛 조회의 재시도는 새 거래소 조회를 건드리지 않는다", async () => {
      const { book, fetches } = setup();
      book.lease(["005930"]);
      await settle();
      book.setVenue("krx");
      fetches[0]!.reject(new ApiRequestError("network", "서버에 연결하지 못했습니다"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetches.map((f) => f.venue)).toEqual(["combined", "krx"]);
    });
  });

  describe("옛 시세와 앞자리 재조회", () => {
    const LIVE: Connection = { socket: "open", status: { realtime: "live", since: 1_000, backfilling: false } };
    const RECONNECTING: Connection = { socket: "open", status: { realtime: "reconnecting", since: 2_000, backfilling: false } };

    test("watch_limited에서 돌아오면 앞자리 종목만 REST를 한 번 다시 부르고, 새 시세가 올 때까지 stale을 유지한다", async () => {
      const { book, fetches, realtime, emit } = setup();
      book.lease(["035420"]);
      book.lease(["000660"], { front: true });
      await settle();
      realtime(quote("000660", 185_000), quote("035420", 200_000));
      expect(book.get("000660").stale).toBe(false);

      emit({ type: "watch_limited", symbols: ["000660", "035420"] });
      expect(book.get("000660")).toEqual({ quote: quote("000660", 185_000), limited: true, stale: true });
      expect(book.get("035420")).toEqual({ quote: quote("035420", 200_000), limited: true, stale: true });

      emit({ type: "watch_limited", symbols: [] });
      expect(book.get("000660")).toEqual({ quote: quote("000660", 185_000), limited: false, stale: true });
      expect(book.get("035420")).toEqual({ quote: quote("035420", 200_000), limited: false, stale: true });
      expect(fetches.map((f) => f.symbols)).toEqual([["000660", "035420"], ["000660"]]);

      fetches[1]!.resolve([quote("000660", 187_000, "polled")]);
      await settle();
      expect(book.get("000660")).toEqual({ quote: quote("000660", 187_000, "polled"), limited: false, stale: false });
    });

    test("브라우저 소켓이 끊겼다 이어지면 앞자리 종목만 한 번 다시 조회하고, 응답 전 실시간 시세가 오면 그 값을 지킨다", async () => {
      const { book, fetches, realtime, emit, setConnection } = setup();
      book.lease(["035420"]);
      book.lease(["000660"], { front: true });
      await settle();
      realtime(quote("000660", 185_000), quote("035420", 200_000));

      setConnection({ socket: "closed" });
      expect(book.get("000660").stale).toBe(true);
      expect(book.get("035420").stale).toBe(true);

      setConnection(LIVE);
      emit({ type: "resync" });
      expect(fetches.map((f) => f.symbols)).toEqual([["000660", "035420"], ["000660"]]);
      expect(book.get("000660").stale).toBe(true);

      realtime(quote("000660", 188_000));
      expect(book.get("000660")).toEqual({ quote: quote("000660", 188_000), limited: false, stale: false });
      fetches[1]!.resolve([quote("000660", 187_000, "polled")]);
      await settle();
      expect(book.get("000660").quote?.price).toBe(188_000);
    });

    test("증권사 실시간이 live가 아니면 stale이고, live로 돌아오면 앞자리 종목을 한 번 다시 조회한다", async () => {
      const { book, fetches, realtime, setConnection } = setup();
      book.lease(["000660"], { front: true });
      await settle();
      realtime(quote("000660", 185_000));

      setConnection(RECONNECTING);
      expect(book.get("000660")).toEqual({ quote: quote("000660", 185_000), limited: false, stale: true });

      setConnection(LIVE);
      expect(fetches.map((f) => f.symbols)).toEqual([["000660"], ["000660"]]);
      fetches[1]!.resolve([quote("000660", 187_000, "polled")]);
      await settle();
      expect(book.get("000660")).toEqual({ quote: quote("000660", 187_000, "polled"), limited: false, stale: false });
    });

    test("이미 stale인 일반 종목에 앞자리 lease가 붙으면 그 종목을 한 번 다시 조회한다", async () => {
      const { book, fetches, realtime, setConnection } = setup();
      book.lease(["000660"]);
      await settle();
      realtime(quote("000660", 185_000));
      setConnection(RECONNECTING);
      setConnection(LIVE);
      expect(fetches).toHaveLength(1);
      expect(book.get("000660").stale).toBe(true);

      book.lease(["000660"], { front: true });
      await settle();
      expect(fetches.map((f) => f.symbols)).toEqual([["000660"], ["000660"]]);
    });
  });
});
