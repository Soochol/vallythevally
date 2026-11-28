// @vitest-environment happy-dom
import { QueryClientProvider } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TODAY_REFETCH_MS } from "../../api/bookReplay";
import type { BookReplayDay } from "../../api/generated/BookReplayDay";
import type { BookReplayProgramDay } from "../../api/generated/BookReplayProgramDay";
import type { BookReplayTrades } from "../../api/generated/BookReplayTrades";
import type { BrokerDay } from "../../api/generated/BrokerDay";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { barInterval } from "../../chart/crosshairSync";
import { DEFAULT_CHART_SETTINGS } from "../../chart/settings";
import { windowId } from "../../layout/kinds";
import { DEFAULT_UI_PREFS } from "../../persist/uiState";
import { useBookReplayStore } from "../../stores/bookReplay";
import { useLayoutStore } from "../../stores/layout";
import { marketSocket } from "../../stores/realtime";
import { useServerClock } from "../../stores/serverClock";
import { useUiStore } from "../../stores/ui";
import { installMockWebSocket, renderWithProviders, stubFetch } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { BookWindow } from "../book/BookWindow";
import { BrokersWindow } from "../brokers/BrokersWindow";
import { BASE, ORDER_BOOK, setupOrderEnv } from "../order/orderTestHarness";
import { REPLAY_REASON } from "./replay";
import { useProgramReplay } from "./useProgramReplay";
import { useTradesReplay } from "./useTradesReplay";
import type { WorkspaceReplayCursor } from "./useWorkspaceReplayCursor";

const CODE = "005930" as SymbolCode;
const TODAY = "20261123";
const PAST_A = "20261120";
const PAST_B = "20261119";
const PAST_C = "20261118";

const unixKst = (isoDate: string, clock: string) => Date.parse(`${isoDate}T${clock}+09:00`) / 1000;
const secAt = (hour: number, minute: number, second = 0) => hour * 3600 + minute * 60 + second;

function pointedCursor(isoDate: string, compactDate: string, barHour: number, barMinute: number, isToday: boolean, close = 71_200): WorkspaceReplayCursor {
  const bar = barInterval(unixKst(isoDate, `${String(barHour).padStart(2, "0")}:${String(barMinute).padStart(2, "0")}:00`), "5m");
  const at = bar.end - 1;
  const endMinute = barMinute + 4;
  return {
    kind: "pointed",
    symbol: CODE,
    bar,
    date: compactDate,
    at,
    secondOfDay: secAt(barHour, endMinute, 59),
    minute: barHour * 60 + endMinute,
    isToday,
    close,
  };
}

function ProgramProbe({ cursor }: { cursor: WorkspaceReplayCursor }) {
  const view = useProgramReplay(CODE, cursor);
  if (view.kind === "past") {
    return <div data-testid="program-probe" data-kind="past" data-count={String(view.rowCount)} data-latest={view.latest?.time ?? ""} />;
  }
  return <div data-testid="program-probe" data-kind={view.kind} data-reason={view.kind === "none" ? view.reason : ""} />;
}

function TradesProbe({ cursor }: { cursor: WorkspaceReplayCursor }) {
  const view = useTradesReplay(CODE, cursor, "combined", 0);
  if (view.kind === "past") {
    return <div data-testid="trades-probe" data-kind="past" data-vol={String(view.cumVolume)} data-entries={String(view.entries.length)} />;
  }
  return <div data-testid="trades-probe" data-kind={view.kind} data-reason={view.kind === "none" ? view.reason : ""} />;
}

afterEach(() => {
  vi.useRealTimers();
  useBookReplayStore.getState().clear();
  useServerClock.setState({ serverTimeOrigin: null });
  marketSocket.stop();
});

resetDomAfterEach();

test("useProgramReplay refetches today after TODAY_REFETCH_MS when hovering a newer bar past the last fetched row", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(Date.parse("2026-11-23T10:00:00+09:00"));

  let fetchCount = 0;
  stubFetch(({ pathname }) => {
    if (pathname === `/api/symbols/${CODE}/book-replay/program`) {
      fetchCount += 1;
      const body: BookReplayProgramDay = {
        symbol: CODE,
        date: TODAY,
        coverage: "collected",
        previousClose: 70_000,
        gaps: [],
        rows:
          fetchCount === 1
            ? [{ secondOfDay: secAt(9, 5, 0), price: 71_000, buyQty: 100, sellQty: 20, netQty: 80, netQtyChange: 80, netAmountMillionWon: 500 }]
            : [
                { secondOfDay: secAt(9, 5, 0), price: 71_000, buyQty: 100, sellQty: 20, netQty: 80, netQtyChange: 80, netAmountMillionWon: 500 },
                { secondOfDay: secAt(9, 12, 0), price: 71_400, buyQty: 300, sellQty: 50, netQty: 250, netQtyChange: 170, netAmountMillionWon: 1700 },
              ],
      };
      return { body };
    }
    return { body: {} };
  });

  const bar0900 = pointedCursor("2026-11-23", TODAY, 9, 0, true);
  const view = renderWithProviders(<ProgramProbe cursor={bar0900} />);

  await waitFor(() => expect(screen.getByTestId("program-probe").getAttribute("data-kind")).toBe("past"));
  expect(screen.getByTestId("program-probe").getAttribute("data-count")).toBe("0");
  expect(fetchCount).toBe(1);

  await act(async () => {
    vi.advanceTimersByTime(TODAY_REFETCH_MS + 1_000);
  });
  expect(fetchCount).toBe(1);

  const bar0910 = pointedCursor("2026-11-23", TODAY, 9, 10, true);
  view.rerender(
    <QueryClientProvider client={view.client}>
      <ProgramProbe cursor={bar0910} />
    </QueryClientProvider>,
  );

  await waitFor(() => expect(fetchCount).toBe(2));
  await waitFor(() => expect(screen.getByTestId("program-probe").getAttribute("data-latest")).toBe("09:12:00"));
  expect(screen.getByTestId("program-probe").getAttribute("data-count")).toBe("2");
  view.client.clear();
});

test("useProgramReplay refetches today after TODAY_REFETCH_MS when hovered bar is in a transient gap", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(Date.parse("2026-11-23T10:00:00+09:00"));

  let fetchCount = 0;
  stubFetch(({ pathname }) => {
    if (pathname === `/api/symbols/${CODE}/book-replay/program`) {
      fetchCount += 1;
      const body: BookReplayProgramDay = {
        symbol: CODE,
        date: TODAY,
        coverage: "collected",
        previousClose: 70_000,
        gaps: fetchCount === 1 ? [[unixKst("2026-11-23", "09:10:00"), unixKst("2026-11-23", "09:16:00")]] : [],
        rows: [
          { secondOfDay: secAt(9, 12, 0), price: 71_400, buyQty: 300, sellQty: 50, netQty: 250, netQtyChange: 250, netAmountMillionWon: 1700 },
          { secondOfDay: secAt(9, 20, 0), price: 71_500, buyQty: 400, sellQty: 50, netQty: 350, netQtyChange: 100, netAmountMillionWon: 2400 },
        ],
      };
      return { body };
    }
    return { body: {} };
  });

  const bar0910 = pointedCursor("2026-11-23", TODAY, 9, 10, true);
  const view = renderWithProviders(<ProgramProbe cursor={bar0910} />);

  await waitFor(() => expect(screen.getByTestId("program-probe").getAttribute("data-reason")).toBe(REPLAY_REASON.gap));
  expect(fetchCount).toBe(1);

  await act(async () => {
    vi.advanceTimersByTime(TODAY_REFETCH_MS + 100);
  });

  await waitFor(() => expect(fetchCount).toBe(2));
  await waitFor(() => expect(screen.getByTestId("program-probe").getAttribute("data-kind")).toBe("past"));
  expect(screen.getByTestId("program-probe").getAttribute("data-latest")).toBe("09:12:00");
  view.client.clear();
});

test("useTradesReplay refetches today after TODAY_REFETCH_MS when hovered bar is in a transient gap and collector recovers", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(Date.parse("2026-11-23T10:00:00+09:00"));

  let fetchCount = 0;
  stubFetch(({ pathname }) => {
    if (pathname === `/api/symbols/${CODE}/book-replay/trades`) {
      fetchCount += 1;
      const body: BookReplayTrades = {
        symbol: CODE,
        date: TODAY,
        coverage: "collected",
        previousClose: 70_000,
        venue: "combined",
        gaps: fetchCount === 1 ? [[unixKst("2026-11-23", "09:10:00"), unixKst("2026-11-23", "09:16:00")]] : [],
        cumVolume: 500,
        cumBuyQty: 350,
        cumSellQty: 150,
        strength: 233.33,
        trades: [{ secondOfDay: secAt(9, 12, 0), price: 71_300, quantity: 50, side: "buy", venue: "krx" }],
      };
      return { body };
    }
    return { body: {} };
  });

  const bar0910 = pointedCursor("2026-11-23", TODAY, 9, 10, true);
  const view = renderWithProviders(<TradesProbe cursor={bar0910} />);

  await waitFor(() => expect(screen.getByTestId("trades-probe").getAttribute("data-reason")).toBe(REPLAY_REASON.gap));
  expect(fetchCount).toBe(1);

  await act(async () => {
    vi.advanceTimersByTime(TODAY_REFETCH_MS + 100);
  });

  await waitFor(() => expect(fetchCount).toBe(2));
  await waitFor(() => expect(screen.getByTestId("trades-probe").getAttribute("data-kind")).toBe("past"));
  expect(screen.getByTestId("trades-probe").getAttribute("data-vol")).toBe("500");
  view.client.clear();
});

test("BrokersWindow shows loading across past-day switches, hides cards with EmptyState during gap, and uses BrokerDay.coverage", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(Date.parse("2026-11-23T10:00:00+09:00"));
  useServerClock.setState({ serverTimeOrigin: null });

  useUiStore.setState({
    prefs: {
      ...DEFAULT_UI_PREFS,
      bookReplay: true,
    },
  });
  useLayoutStore.setState((s) => ({
    ...s,
    layout: {
      ...s.layout,
      windows: [
        { id: windowId("cell-0"), link: "a", kind: "chart", symbol: CODE, venue: "combined", period: "5m", chartSettings: DEFAULT_CHART_SETTINGS },
        { id: windowId("brokers-0"), link: "a", kind: "brokers" },
      ],
    },
  }));

  let resolvePastB: ((reply: { body: BrokerDay }) => void) | null = null;
  stubFetch(({ pathname, url }) => {
    if (pathname === "/api/book-replay/access") return { body: { available: true } };
    if (pathname === `/api/symbols/${CODE}`) {
      return { body: { code: CODE, name: "삼성전자", kind: "stock", market: "kospi", nxtEnabled: true } };
    }
    if (pathname === `/api/symbols/${CODE}/brokers`) {
      const date = url.searchParams.get("date");
      if (date === PAST_A) {
        const body: BrokerDay = {
          symbol: CODE,
          date: PAST_A,
          source: "store",
          coverage: "collected",
          snapshots: [
            {
              t: unixKst("2026-11-20", "09:04:00"),
              buys: [{ code: "151", name: "키움", qty: 500, qtyChange: 500 }],
              sells: [{ code: "141", name: "삼성", qty: 200, qtyChange: 200 }],
            },
          ],
          gaps: [[unixKst("2026-11-20", "09:20:00"), unixKst("2026-11-20", "09:26:00")]],
          live: false,
          cursor: "s:0",
          reset: true,
        };
        return { body };
      }
      if (date === PAST_B) {
        return new Promise<{ body: BrokerDay }>((resolve) => {
          resolvePastB = resolve;
        });
      }
      if (date === PAST_C) {
        const body: BrokerDay = {
          symbol: CODE,
          date: PAST_C,
          source: "none",
          coverage: "day_not_collected",
          snapshots: [],
          gaps: [],
          live: false,
          cursor: "",
          reset: true,
        };
        return { body };
      }
    }
    return { body: {} };
  });
  installMockWebSocket(marketSocket, { serverTime: unixKst("2026-11-23", "10:00:00") });

  useBookReplayStore.getState().point(CODE, barInterval(unixKst("2026-11-20", "09:00:00"), "5m"), 71_200);
  const view = renderWithProviders(<BrokersWindow id={windowId("brokers-0")} />);

  await waitFor(() => expect(screen.getByTestId("brokers-window").getAttribute("data-replay")).toBe("past"));
  expect(screen.getAllByTestId("broker-card").length).toBeGreaterThan(0);

  await act(async () => {
    useBookReplayStore.getState().point(CODE, barInterval(unixKst("2026-11-20", "09:20:00"), "5m"), 71_300);
  });
  await waitFor(() => expect(screen.getByTestId("brokers-window").getAttribute("data-replay")).toBe("none"));
  expect(screen.getByTestId("replay-strip").textContent).toBe(REPLAY_REASON.gap);
  expect(screen.queryAllByTestId("broker-card")).toHaveLength(0);
  expect(screen.getAllByText(REPLAY_REASON.gap).length).toBeGreaterThanOrEqual(2);

  await act(async () => {
    useBookReplayStore.getState().point(CODE, barInterval(unixKst("2026-11-19", "09:00:00"), "5m"), 70_900);
  });
  await waitFor(() => expect(screen.getByTestId("replay-strip").textContent).toBe(REPLAY_REASON.loading));
  expect(screen.getByRole("status", { name: "거래원 불러오는 중" })).toBeTruthy();
  expect(screen.queryAllByTestId("broker-card")).toHaveLength(0);
  expect(screen.getByTestId("brokers-time").textContent).toBe("");
  expect(screen.getByTestId("brokers-price").textContent).toBe("-");

  await act(async () => {
    vi.advanceTimersByTime(150);
  });
  await waitFor(() => expect(resolvePastB).not.toBeNull());
  await act(async () => {
    resolvePastB!({
      body: {
        symbol: CODE,
        date: PAST_B,
        source: "none",
        coverage: "symbol_not_collected",
        snapshots: [],
        gaps: [],
        live: false,
        cursor: "",
        reset: true,
      },
    });
  });
  await waitFor(() => expect(screen.getByTestId("replay-strip").textContent).toBe(REPLAY_REASON.symbolNotCollected));
  expect(screen.getAllByText(REPLAY_REASON.symbolNotCollected).length).toBeGreaterThanOrEqual(2);

  await act(async () => {
    useBookReplayStore.getState().point(CODE, barInterval(unixKst("2026-11-18", "09:00:00"), "5m"), 70_500);
    vi.advanceTimersByTime(150);
  });
  await waitFor(() => expect(screen.getByTestId("replay-strip").textContent).toBe(REPLAY_REASON.dayNotCollected));
  expect(screen.getAllByText(REPLAY_REASON.dayNotCollected).length).toBeGreaterThanOrEqual(2);
  view.client.clear();
});

test("BookWindow renders ErrorState instead of stale pre-replay OrderBook when replay turns off and order-book refetch fails", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(Date.parse("2026-11-09T10:00:00+09:00"));
  const env = setupOrderEnv();
  useLayoutStore.setState((s) => ({
    ...s,
    layout: {
      ...s.layout,
      windows: [
        { id: windowId("cell-0"), link: "a", kind: "chart", symbol: CODE, venue: "combined", period: "5m", chartSettings: DEFAULT_CHART_SETTINGS },
        { id: windowId("book"), link: "a", kind: "book" },
      ],
    },
  }));

  let failOrderBook = false;
  const replayDay: BookReplayDay = {
    symbol: CODE,
    date: "20261109",
    coverage: "collected",
    previousClose: BASE,
    covered: [[540, 545]],
    books: [
      {
        minute: 540,
        asks: [[71_200, 120]],
        bids: [[71_100, 150]],
        totalAsk: 120,
        totalBid: 150,
      },
    ],
    trades: [],
  };

  stubFetch(({ pathname, url }) => {
    if (pathname === "/api/book-replay/access") return { body: { available: true } };
    if (pathname === `/api/symbols/${CODE}/book-replay`) return { body: replayDay };
    if (pathname === `/api/symbols/${CODE}/order-book`) {
      if (failOrderBook) return { status: 500, body: { error: { code: "internal", message: "boom", reason: null, retryAt: null, manualActionRequired: false } } };
      return { body: ORDER_BOOK };
    }
    if (pathname === `/api/symbols/${CODE}/trades`) return { body: { symbol: CODE, venue: "combined", trades: [], skippedRows: 0 } };
    if (pathname === `/api/symbols/${CODE}`) {
      return { body: { code: CODE, name: "삼성전자", kind: "stock", market: "kospi", nxtEnabled: true } };
    }
    if (pathname === `/api/symbols/${CODE}/day-summary`) {
      return {
        body: {
          symbol: CODE,
          venue: url.searchParams.get("venue") ?? "combined",
          price: BASE,
          open: BASE,
          high: BASE + 500,
          low: BASE - 500,
          volume: 1000,
          tradeValueWon: 70_000_000,
          previousClose: BASE,
          t: unixKst("2026-11-09", "10:00:00"),
        },
      };
    }
    return { body: {} };
  });

  const view = renderWithProviders(<BookWindow id={windowId("book")} />);
  await screen.findByTestId("price-ladder");
  await waitFor(() => expect(env.socket.subsOf("book", CODE).length).toBeGreaterThan(0));

  await act(async () => {
    for (const sub of env.socket.subsOf("book", CODE)) {
      env.socket.emit({
        type: "feed_book",
        sub,
        book: {
          t: unixKst("2026-11-09", "09:59:55"),
          asks: [{ price: BASE + 100, qty: 99 }],
          bids: [{ price: BASE, qty: 88 }],
          totalAskQty: 99,
          totalBidQty: 88,
          expected: null,
        },
      });
    }
  });

  await act(async () => {
    useUiStore.getState().setBookReplay(true);
    useBookReplayStore.getState().point(CODE, barInterval(unixKst("2026-11-09", "09:00:00"), "5m"), 71_100);
  });
  await waitFor(() => expect(screen.getByTestId("book-window").getAttribute("data-replay")).toBe("past"));

  failOrderBook = true;
  await act(async () => {
    useUiStore.getState().setBookReplay(false);
    useBookReplayStore.getState().clear();
  });

  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("호가를 불러오지 못했습니다"));
  expect(screen.queryByTestId("price-ladder")).toBeNull();
  view.client.clear();
});
