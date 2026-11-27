// @vitest-environment happy-dom
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { whaleBook } from "../../stores/realtime";
import { useLayoutStore } from "../../stores/layout";
import { renderWithProviders, stubFetch } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { WhaleWindow } from "./WhaleWindow";

const SNAPSHOT = {
  watchedCount: 2,
  events: [
    { id: 1, at: 1_764_205_210, symbol: "000660", side: "buy" as const, price: 196_000, quantity: 1_200, amountWon: 235_200_000 },
  ],
  summaries: new Map([
    ["000660", { symbol: "000660", buyCount: 1, sellCount: 0, buyWon: 235_200_000, sellWon: 0, netWon: 235_200_000, lastPrice: 196_000, lastAt: 1_764_205_210 }],
  ]),
};

beforeEach(() => {
  vi.spyOn(whaleBook, "subscribe").mockReturnValue(() => {});
  vi.spyOn(whaleBook, "getSnapshot").mockReturnValue(SNAPSHOT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

resetDomAfterEach();

test("WhaleWindow 행과 정렬 헤더는 키보드와 ARIA 속성으로 조작할 수 있다", async () => {
  stubFetch(() => ({ body: { items: [{ code: "000660", name: "SK하이닉스", market: "kospi", listed: true, kind: "stock" }] } }));
  const windowId = useLayoutStore.getState().layout.windows[0]!.id;
  const { client } = renderWithProviders(<WhaleWindow id={windowId} />);

  const streamRow = screen.getByTestId("whale-stream-table").querySelector('tbody tr[data-symbol="000660"]') as HTMLElement;
  expect(streamRow.tabIndex).toBe(0);
  fireEvent.keyDown(streamRow, { key: "Enter" });

  fireEvent.click(screen.getByTestId("whale-view-rank"));
  const netBtn = screen.getByTestId("whale-sort-net");
  expect(netBtn.tagName).toBe("BUTTON");
  expect(netBtn.closest("th")?.getAttribute("aria-sort")).toBe("none");

  fireEvent.click(netBtn);
  expect(netBtn.closest("th")?.getAttribute("aria-sort")).toBe("descending");

  const rankRow = screen.getByTestId("whale-rank-table").querySelector('tbody tr[data-symbol="000660"]') as HTMLElement;
  expect(rankRow.tabIndex).toBe(0);
  client.clear();
});
