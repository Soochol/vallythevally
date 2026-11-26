// @vitest-environment happy-dom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { ClientMessage } from "../../api/generated/ClientMessage";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import { windowId } from "../../layout/kinds";
import { useLayoutStore } from "../../stores/layout";
import { marketSocket } from "../../stores/realtime";
import { useWatchlistStore } from "../../stores/watchlist";
import { renderWithProviders } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { OrderWindow } from "./OrderWindow";
import { ACCOUNT, BASE, CODE, SETTINGS_CHART, setupOrderEnv } from "./orderTestHarness";

const SAMSUNG: TradingHolding = { code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 120, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: -4_800, profitRateCenti: -57 };
const HYNIX: TradingHolding = { code: "000660", name: "SK하이닉스", quantity: 10, sellableQuantity: 10, averagePrice: 180_000, currentPrice: 180_000, evaluationProfit: 0, profitRateCenti: 0 };
const NAVER_CREDIT: TradingHolding = { code: "035420", name: "NAVER", quantity: 5, sellableQuantity: 5, averagePrice: 200_000, currentPrice: 200_000, evaluationProfit: 0, profitRateCenti: 0 };

const lastWatch = (sent: readonly ClientMessage[]) =>
  sent.filter((m): m is Extract<ClientMessage, { type: "watch" }> => m.type === "watch").at(-1)?.symbols;

afterEach(() => {
  marketSocket.stop();
});

resetDomAfterEach();

test("보유종목은 실시간 구독되고 신용 종목은 제외되며 예상체결가는 손익에 반영하지 않는다", async () => {
  useWatchlistStore.setState({ revision: 1, lists: [{ id: "L", name: "기본", symbols: ["035420"], groups: [] }] });
  const env = setupOrderEnv({ holdings: [SAMSUNG, HYNIX], creditHoldings: [NAVER_CREDIT] });
  const { client, unmount } = renderWithProviders(<OrderWindow id={windowId("order")} />);

  await waitFor(() => expect(lastWatch(env.socket.sent)).toEqual([CODE, "000660"]));
  expect(lastWatch(env.socket.sent)).not.toContain("035420");

  const tab = screen.getByTestId("account-tab-holdings");
  expect(tab.textContent).toBe("보유종목 2");
  expect(screen.queryByTestId("account-total-profit")).toBeNull();

  fireEvent.click(tab);
  expect(await screen.findAllByTestId("account-holding")).toHaveLength(2);

  await act(async () => {
    env.socket.emit({
      type: "quotes",
      venue: "combined",
      quotes: [{ symbol: "000660", price: 185_000, change: 5_000, changeRate: 2.86, volume: 100, t: 100, source: "realtime", venue: "combined" }],
    });
  });
  const hynixRow = screen.getAllByTestId("account-holding").find((el) => el.textContent?.includes("SK하이닉스"))!;
  expect(hynixRow.textContent).toContain("+50,000원");

  await act(async () => {
    env.socket.emit({
      type: "quotes",
      venue: "combined",
      quotes: [{ symbol: "000660", price: 190_000, change: 10_000, changeRate: 5.5, volume: 100, t: 101, source: "expected", venue: "combined" }],
    });
  });
  expect(hynixRow.textContent).toContain("0원");

  unmount();
  await waitFor(() => expect(lastWatch(env.socket.sent)).toEqual([]));
  client.clear();
});

test("계좌 변경 신호·웹소켓 재연결 시 창 둘이 같은 계좌여도 잔고 조회는 한 번만 나가고 늦은 응답은 덮지 않는다", async () => {
  const env = setupOrderEnv({ holdings: [SAMSUNG] });
  useLayoutStore.setState((s) => ({
    ...s,
    layout: {
      ...s.layout,
      windows: [
        { id: windowId("cell-0"), link: "a", kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS_CHART },
        { id: windowId("order"), link: "a", kind: "order", venue: "krx" },
        { id: windowId("order-2"), link: "a", kind: "order", venue: "krx" },
      ],
    },
  }));

  const { client } = renderWithProviders(
    <>
      <OrderWindow id={windowId("order")} />
      <OrderWindow id={windowId("order-2")} />
    </>,
  );

  await waitFor(() => expect(env.balanceCalls()).toBeGreaterThanOrEqual(1));
  const afterMount = env.balanceCalls();

  await act(async () => {
    env.socket.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  });
  await waitFor(() => expect(env.balanceCalls()).toBe(afterMount + 1));

  const beforeReconnect = env.balanceCalls();
  await act(async () => {
    env.socket.close();
    env.socket.emit({ type: "hello", protocol: 1, serverTime: 1_794_186_010, status: { realtime: "live", since: 1_794_186_010, backfilling: false } });
  });
  await waitFor(() => expect(env.balanceCalls()).toBeGreaterThan(beforeReconnect));
  expect(env.balanceCalls()).toBe(beforeReconnect + 1);

  let releaseStale!: (value: { body: unknown }) => void;
  let holdFirst = true;
  env.customBalanceHandler = () => {
    if (holdFirst) {
      holdFirst = false;
      return new Promise((resolve) => { releaseStale = resolve; });
    }
    return {
      body: { accountRef: ACCOUNT, holdings: [{ ...SAMSUNG, quantity: 200, sellableQuantity: 200 }], totalPurchase: 0, totalEvaluation: 0, totalProfit: 0 },
    };
  };

  await act(async () => {
    void client.refetchQueries({ queryKey: ["order", ACCOUNT, "balance"] });
    await Promise.resolve();
    env.socket.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  });
  await waitFor(() => expect(screen.getAllByTestId("summary-quantity")[0]!.textContent).toContain("200"));

  await act(async () => {
    releaseStale({ body: { accountRef: ACCOUNT, holdings: [SAMSUNG], totalPurchase: 0, totalEvaluation: 0, totalProfit: 0 } });
    await Promise.resolve();
  });
  expect(within(screen.getAllByTestId("order-window")[0]!).getByTestId("summary-quantity").textContent).toContain("200");
  client.clear();
});
