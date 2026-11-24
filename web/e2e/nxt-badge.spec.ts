import type { Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, expect, pickDesktopVenue, test, windowTabs } from "./harness";
import { nxtTraded, openOrderWindow, ordersOn, tradingApi, win } from "./order-window";

const withMarketWindows = (windows: LayoutWindow[]): LayoutWindow[] => [...windows, { id: "book", link: null, kind: "book" }, { id: "trades", link: null, kind: "trades" }];
const book = (page: Page) => page.getByTestId("book-window");
const trades = (page: Page) => page.getByTestId("trades-window");

async function openAll(page: Page, scenario: Scenario, nxtEnabled: boolean): Promise<void> {
  ordersOn(scenario);
  tradingApi(scenario);
  nxtTraded(scenario, nxtEnabled);
  await openOrderWindow(page, scenario, false, "krx", { upper: 91_000, lower: 49_000 }, false, undefined, withMarketWindows);
}

const openTab = async (page: Page, name: RegExp) => windowTabs(page).getByRole("tab", { name }).click();

test("10호가와 호가주문 창 머리는 NXT 거래 종목의 이름 바로 뒤에 NXT 배지를 붙인다", async ({ page, scenario }) => {
  await openAll(page, scenario, true);
  await openTab(page, /^10호가/);
  for (const [area, prefix] of [[book(page), "market-symbol"], [win(page), "order-symbol"]] as const) {
    const badge = area.getByTestId(`${prefix}-nxt`);
    await expect(badge).toHaveText("NXT");
    const name = (await area.getByTestId(`${prefix}-name`).boundingBox())!;
    const price = (await area.getByTestId(`${prefix}-price`).boundingBox())!;
    const box = (await badge.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(name.x + name.width - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(price.x + 1);
  }
  await openTab(page, /^체결/);
  await expect(trades(page).getByTestId("market-symbol-name")).toBeVisible();
  await expect(trades(page).getByTestId("market-symbol-nxt")).toHaveCount(0);
});

test("NXT 거래 종목이 아니면 앱 거래소가 NXT여도 10호가와 호가주문 창 머리에 NXT 배지가 없다", async ({ page, scenario }) => {
  await openAll(page, scenario, true);
  await openTab(page, /^10호가/);
  await expect(book(page).getByTestId("market-symbol-nxt")).toBeVisible();
  nxtTraded(scenario, false);
  await page.reload();
  await openTab(page, /^10호가/);
  await pickDesktopVenue(page, "NXT");
  await expect(win(page)).toHaveAttribute("data-quote-venue", "combined");
  await expect(book(page).getByTestId("market-symbol-name")).toBeVisible();
  await expect(book(page).getByTestId("market-symbol-nxt")).toHaveCount(0);
  await expect(win(page).getByTestId("order-symbol-nxt")).toHaveCount(0);
});

async function expectNoMarketBadge(page: Page, scenario: Scenario): Promise<void> {
  await openAll(page, scenario, true);
  await openTab(page, /^10호가/);
  for (const [area, prefix] of [[book(page), "market-symbol"], [win(page), "order-symbol"]] as const) {
    const head = area.getByTestId(`${prefix}-head`);
    await expect(head.getByTestId(`${prefix}-price`)).toBeVisible();
    await expect(head).not.toContainText(/장중|장 마감/);
  }
  await openTab(page, /^체결/);
  await expect(trades(page).getByTestId("market-symbol-head")).not.toContainText(/장중|장 마감/);
}

test.describe("월요일 10:00", () => {
  test.use({ clockStart: "20261109100000" });
  test("장중 시각에 시세 창 머리에 장중 배지가 없다", async ({ page, scenario }) => {
    await expectNoMarketBadge(page, scenario);
  });
});

test.describe("월요일 22:00", () => {
  test.use({ clockStart: "20261109220000" });
  test("장 마감 시각에 시세 창 머리에 장 마감 배지가 없다", async ({ page, scenario }) => {
    await expectNoMarketBadge(page, scenario);
  });
});
