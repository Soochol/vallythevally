// @vitest-environment happy-dom
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { BookReplayDay } from "../../api/generated/BookReplayDay";
import type { BookReplayMeta } from "../../api/generated/BookReplayMeta";
import { useServerModeStore } from "../../public-mode/serverMode";
import { useSelectionStore } from "../../stores/selection";
import { renderWithProviders, stubFetch } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { ReplayPage } from "./ReplayPage";

const CODE = "005930";
const DATE = "20261125";
const MIDNIGHT = Date.parse("2026-11-25T00:00:00+09:00") / 1000;

const MINUTE_META: BookReplayMeta = {
  symbol: CODE,
  date: DATE,
  coverage: "collected",
  resolution: "minute_only",
  spanMinutes: 5,
  covered: [[540, 542]],
  gapsMs: [[543 * 60_000, 544 * 60_000]],
  spans: [],
  minutes: [
    { minute: 540, open: 71_000, high: 71_100, low: 71_000, close: 71_100, volume: 900, cumVol: 0, cumVal: 0, cumBuyQty: 0, cumSellQty: 0, dayOpen: null, dayHigh: null, dayLow: null, totalAsk: 7_600, totalBid: 4_200, programNetQty: 1_200, programNetAmtMillion: 85, singlePrice: false },
  ],
};

const FALLBACK_DAY: BookReplayDay = {
  symbol: CODE,
  date: DATE,
  coverage: "collected",
  covered: [[540, 542]],
  books: [{ minute: 540, asks: [[71_100, 1000]], bids: [[71_000, 1400]], totalAsk: 7_600, totalBid: 4_200 }],
  trades: [[540, 32_410, 71_000, 100]],
};

beforeEach(() => {
  useServerModeStore.setState({ kind: "local" });
  useSelectionStore.setState({ dialog: null, toasts: [], toast: null });
});

resetDomAfterEach();

test("공개 모드에서는 book-replay API를 부르지 않고 안내를 표시한다", async () => {
  useServerModeStore.setState({ kind: "public" });
  const api = stubFetch(() => ({ body: {} }));

  const { client } = renderWithProviders(<ReplayPage />, { route: "/replay" });
  expect(await screen.findByText("공개 모드에서는 호가 복기를 지원하지 않습니다")).toBeTruthy();
  expect(api.calls.filter((c) => c.pathname.includes("book-replay"))).toHaveLength(0);
  client.clear();
});

test("minute_only 해상도 폴백, 종목 전환 대화상자, 블라인드·루프·북마크 토글이 동작한다", async () => {
  stubFetch(({ pathname }) => {
    if (pathname === "/api/book-replay/access") return { body: { available: true } };
    if (pathname === `/api/symbols/${CODE}/book-replay/days`) return { body: { days: [DATE] } };
    if (pathname === `/api/symbols/${CODE}/book-replay/meta`) return { body: MINUTE_META };
    if (pathname === `/api/symbols/${CODE}/book-replay`) return { body: FALLBACK_DAY };
    if (pathname === `/api/symbols/${CODE}/bars`) return { body: { symbol: CODE, period: "D", venue: "combined", bars: [{ t: MIDNIGHT - 86400 + 32400, o: 70_000, h: 70_500, l: 69_800, c: 70_000, v: 500_000 }], partial: null } };
    if (pathname === `/api/symbols/${CODE}/broker-day`) return { body: { symbol: CODE, date: DATE, source: "store", snapshots: [], gaps: [], live: false, cursor: "", reset: true } };
    if (pathname === `/api/symbols/${CODE}/program`) return { body: { symbol: CODE, period: "1m", state: "ready", points: [] } };
    if (pathname === "/api/symbols/search") return { body: { items: [{ code: "000660", name: "SK하이닉스", market: "kospi", listed: true, kind: "stock" }] } };
    return { body: {} };
  });

  const { client } = renderWithProviders(<ReplayPage />, { route: `/replay?symbol=${CODE}&date=${DATE}` });
  const badge = await screen.findByTestId("replay-resolution-badge");
  expect(badge.getAttribute("data-resolution")).toBe("minute_only");
  expect(badge.textContent).toContain("1분 요약");
  expect((await screen.findByTestId("replay-total-ask")).textContent).toBe("7,600");

  fireEvent.click(screen.getByTestId("replay-bookmark-btn"));
  expect(screen.getByTestId("replay-bookmark-btn").textContent).toContain("북마크 (1)");

  fireEvent.click(screen.getByTestId("replay-loop-btn"));
  expect(screen.getByTestId("replay-loop-btn").getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(screen.getByTestId("replay-blind-btn"));
  expect(screen.getByTestId("replay-blind-btn").getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(screen.getByTestId("replay-symbol-picker"));
  const dialog = await screen.findByTestId("replay-symbol-dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
  expect(screen.queryByTestId("replay-symbol-dialog")).toBeNull();

  fireEvent.click(screen.getByTestId("replay-date-trigger"));
  const popover = await screen.findByTestId("replay-date-popover");
  expect(within(popover).getByRole("button", { name: "25" }).getAttribute("data-available")).toBe("true");
  expect(within(popover).getByRole("button", { name: "24" }).getAttribute("data-available")).toBe("false");
  fireEvent.click(within(popover).getByRole("button", { name: "25" }));
  expect(screen.queryByTestId("replay-date-popover")).toBeNull();
  client.clear();
});
