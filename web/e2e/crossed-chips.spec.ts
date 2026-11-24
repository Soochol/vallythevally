import type { Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pollSaved, test, windowTabs } from "./harness";
import { type Api, BASE, center, CODE, dragChip, FUNDAMENTAL_FIGURES, openOrder, openOrderWindow, ordersOn, pinQuote, SETTINGS, snapshot, tradingApi, win, writesTo } from "./order-window";

const rows = (page: Page) => win(page).getByTestId("price-ladder").locator(".mw-lr");
const cellOf = (page: Page, row: number, side: "sell" | "buy") => rows(page).nth(row).locator(`[data-order-cell][data-side="${side}"]`);
const CROSSED = { ...snapshot(BASE), asks: Array.from({ length: 10 }, (_, i) => ({ price: BASE + 100 * i, quantity: 10 + i })) };

async function openCrossedWithOrders(page: Page, scenario: Scenario, orders: ReturnType<typeof openOrder>[]): Promise<Api> {
  ordersOn(scenario);
  const api = tradingApi(scenario, orders);
  await openOrderWindow(page, scenario, false, "krx", { upper: 91_000, lower: 49_000 }, false, CROSSED);
  return api;
}

test("교차 호가에서 같은 가격의 매도 주문 칩은 매도 줄에, 매수 주문 칩은 매수 줄에 붙는다", async ({ page, scenario }) => {
  const api = await openCrossedWithOrders(page, scenario, [
    openOrder("0000001", "sell", BASE, 20),
    openOrder("0000002", "buy", BASE, 30),
  ]);
  await expect(win(page).getByTestId("order-chip")).toHaveCount(2);
  await expect(cellOf(page, 9, "sell").getByTestId("order-chip")).toHaveText("20");
  await expect(cellOf(page, 9, "buy").getByTestId("order-chip")).toHaveCount(0);
  await expect(cellOf(page, 10, "buy").getByTestId("order-chip")).toHaveText("30");
  await expect(cellOf(page, 10, "sell").getByTestId("order-chip")).toHaveCount(0);
  await expect(win(page).locator(".mw-lr[data-current]")).toHaveCount(1);
  await expect(rows(page).nth(9)).toHaveAttribute("data-current", "");
  await expect(rows(page).nth(10)).not.toHaveAttribute("data-current", "");
  await expect(win(page).getByTestId("order-total-sell")).toHaveText("20 (1)");
  await expect(win(page).getByTestId("order-total-buy")).toHaveText("30 (1)");
  await dragChip(page, cellOf(page, 10, "buy").getByTestId("order-chip"), await center(cellOf(page, 11, "buy")));
  await pollSaved(() => writesTo(api, "modify")).toHaveLength(1);
  expect(writesTo(api, "modify")[0]!.body).toMatchObject({ orderNo: "0000002", price: 69_900 });
});

test("교차 호가에서 우클릭 취소는 한 번만 나가고 한 줄뿐인 가격과 교차 단일가 호가도 칩 규칙을 지킨다", async ({ page, scenario }) => {
  const api = await openCrossedWithOrders(page, scenario, [
    openOrder("0000001", "sell", BASE, 20),
    openOrder("0000002", "buy", BASE, 30),
    openOrder("0000003", "buy", 70_200, 5),
  ]);
  await expect(win(page).getByTestId("order-chip")).toHaveCount(3);
  await expect(cellOf(page, 7, "buy").getByTestId("order-chip")).toHaveText("5");
  await expect(win(page).getByTestId("order-total-sell")).toHaveText("20 (1)");
  await expect(win(page).getByTestId("order-total-buy")).toHaveText("35 (2)");

  let sub = "";
  await pollSaved(() => {
    const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
    sub = message?.type === "subscribe_feed" ? message.sub : "";
    return sub;
  }).not.toBe("");
  scenario.live.emit({
    type: "feed_book",
    sub,
    book: {
      t: 1,
      asks: [{ price: 70_000, qty: 5 }, { price: 70_100, qty: 6 }, { price: 70_200, qty: 7 }],
      bids: [{ price: 70_100, qty: 8 }, { price: 70_000, qty: 9 }, { price: 69_900, qty: 10 }],
      totalAskQty: 18,
      totalBidQty: 27,
      expected: null,
    },
  });
  await expect(rows(page).locator(".mw-px-num")).toHaveCount(6);
  await expect(win(page).getByTestId("order-chip")).toHaveCount(3);
  await expect(cellOf(page, 9, "sell").getByTestId("order-chip")).toHaveText("20");
  await expect(cellOf(page, 9, "buy").getByTestId("order-chip")).toHaveCount(0);
  await expect(cellOf(page, 11, "buy").getByTestId("order-chip")).toHaveText("30");
  await expect(cellOf(page, 11, "sell").getByTestId("order-chip")).toHaveCount(0);
  await expect(cellOf(page, 7, "buy").getByTestId("order-chip")).toHaveText("5");

  await cellOf(page, 11, "buy").getByTestId("order-chip").click({ button: "right" });
  await page.getByRole("menuitem", { name: "30 취소" }).click();
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(writesTo(api, "cancel")[0]!.body).toMatchObject({ orderNo: "0000002" });
});

test("교차 호가에서 다른 주문 칩을 같은 가격 칸 위로 끌면 그 줄의 칸 하나만 강조된다", async ({ page, scenario }) => {
  await openCrossedWithOrders(page, scenario, [openOrder("0000001", "buy", 69_800, 10)]);
  const sourceChip = cellOf(page, 12, "buy").getByTestId("order-chip");
  await expect(sourceChip).toBeVisible();
  await dragChip(page, sourceChip, await center(cellOf(page, 10, "buy")), false);
  await expect(win(page).locator("[data-order-cell][data-target]")).toHaveCount(1);
  await expect(cellOf(page, 10, "buy")).toHaveAttribute("data-target", "");
  await expect(cellOf(page, 9, "buy")).not.toHaveAttribute("data-target", "");
  await page.keyboard.press("Escape");
});

test.describe("낮은 10호가 창 동시호가", () => {
  test.use({ clockStart: "20261118085500" });

  test.beforeEach(async ({ page, scenario }) => {
    await page.clock.setFixedTime(new Date(scenario.now));
  });

  test("낮은 10호가 창에서 깊은 교차 호가의 현재가와 예상체결 강조는 보이는 줄에 하나씩 남는다", async ({ page, scenario }) => {
    const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
    const windows: LayoutWindow[] = [
      { id: "cell-0", link: null, kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS },
      ...layout.windows.filter((w) => w.kind !== "chart"),
      { id: "book", link: null, kind: "book" },
    ];
    scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
    pinQuote(scenario, CODE, 70_600, 600);
    scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, { body: { symbol: CODE, upperLimit: 91_000, lowerLimit: 49_000, ...FUNDAMENTAL_FIGURES } });
    scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, { body: {
      ...snapshot(70_000),
      asks: Array.from({ length: 10 }, (_, i) => ({ price: 70_100 + 100 * i, quantity: 10 + i })),
      bids: Array.from({ length: 10 }, (_, i) => ({ price: 70_600 - 100 * i, quantity: 20 + i })),
    } });
    scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/trades`, { body: { symbol: CODE, venue: "combined", trades: [], skippedRows: 0 } });
    await page.setViewportSize({ width: 1440, height: 520 });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
    const bookRows = page.getByTestId("book-window").getByTestId("price-ladder").locator(".mw-lr");
    await expect(bookRows).toHaveCount(10);

    let sub = "";
    await pollSaved(() => {
      const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
      sub = message?.type === "subscribe_feed" ? message.sub : "";
      return sub;
    }).not.toBe("");
    scenario.live.emit({
      type: "feed_book",
      sub,
      book: {
        t: scenario.now / 1000,
        asks: Array.from({ length: 10 }, (_, i) => ({ price: 70_100 + 100 * i, qty: 10 + i })),
        bids: Array.from({ length: 10 }, (_, i) => ({ price: 70_600 - 100 * i, qty: 20 + i })),
        totalAskQty: 145,
        totalBidQty: 245,
        expected: { price: 70_600, qty: 300 },
      },
    });
    await expect(page.getByTestId("book-window").locator(".mw-lr[data-current]")).toHaveCount(1);
    await expect(page.getByTestId("book-window").locator(".mw-lr[data-expected]")).toHaveCount(1);
    await expect(bookRows.nth(5)).toHaveAttribute("data-current", "");
    await expect(bookRows.nth(5)).toHaveAttribute("data-expected", "");
    await expect(bookRows.nth(5).locator(".mw-px-num")).toHaveText("70,600");
  });
});
