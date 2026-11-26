import type { Locator, Page } from "@playwright/test";
import type { TradingHolding } from "../src/api/generated/TradingHolding";
import { DEFAULT_ORDER_SETTINGS } from "../src/features/order/orderSettings";
import { CONNECTED_KIWOOM, DEFAULT_SYSTEM_SETTINGS } from "./fixtures/scenario";
import { type Scenario, expect, test } from "./harness";
import { ACCOUNT, BASE, CODE, openOrderWindow, ordersOn, otherAccount, tradingApi, win } from "./order-window";

const HYNIX = "000660";
const ONE_LINE_BAND_PX = 34;
const ONE_LINE_PX = 28;
const COMPACT_HEADER_TOTAL_PX = 96;
const LONG_ALIAS = "가".repeat(20);
const KINDS = ["open", "holdings", "fills"] as const;

const samsung: TradingHolding = { code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 120, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: -4_800, profitRateCenti: -57 };
const hynix: TradingHolding = { code: HYNIX, name: "SK하이닉스", quantity: 10, sellableQuantity: 10, averagePrice: 180_000, currentPrice: 180_000, evaluationProfit: 0, profitRateCenti: 0 };

const tab = (page: Page, kind: (typeof KINDS)[number]): Locator => page.getByTestId(`account-tab-${kind}`);
const label = (page: Page): Locator => page.getByTestId("account-label");
const shows = (locator: Locator, text: string): Promise<void> => expect(locator).toHaveText(text, { useInnerText: true });

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const boxOf = async (locator: Locator): Promise<Box> => (await locator.boundingBox())!;
const centerY = (box: Box): number => box.y + box.height / 2;

const sizeWindow = (page: Page, width: number): Promise<void> =>
  win(page).evaluate((element, size) => {
    const window = element as HTMLElement;
    window.style.flex = "none";
    window.style.width = `${size}px`;
  }, width);

interface Shown {
  readonly others?: boolean;
  readonly longAlias?: boolean;
  readonly allowMargin?: boolean;
  readonly rateOff?: boolean;
  readonly mock?: boolean;
}

async function openBand(page: Page, scenario: Scenario, { others = false, longAlias = false, allowMargin = false, rateOff = false, mock = false }: Shown = {}): Promise<void> {
  if (mock) {
    scenario.live.kiwoomLink = { ...CONNECTED_KIWOOM, environment: "mock" };
    scenario.reply((url) => url.pathname === "/api/system/settings", { body: { ...DEFAULT_SYSTEM_SETTINGS, environment: "mock" } });
  }
  ordersOn(scenario, others ? [otherAccount()] : []);
  if (longAlias) {
    scenario.live.orders = { ...scenario.live.orders, accounts: scenario.live.orders.accounts.map((account, index) => (index === 0 ? { ...account, alias: LONG_ALIAS } : account)) };
  }
  if (rateOff) scenario.documents.saveUiState({ ...scenario.documents.uiState(), orderSettings: { ...DEFAULT_ORDER_SETTINGS, rate: false } });
  tradingApi(scenario).policy = allowMargin ? "allow_margin" : "cash_only";
  scenario.reply("/api/trading/balance", { body: { accountRef: ACCOUNT, holdings: [samsung, hynix], creditHoldings: [], totalPurchase: 120_000_000, totalEvaluation: 0, totalProfit: 12_345_678 } });
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("margin-policy")).toHaveText(allowMargin ? "미수 허용" : "현금");
  await expect(tab(page, "holdings")).toContainText("2");
}

async function expectTabsWhole(page: Page): Promise<Box[]> {
  const bar = await boxOf(page.locator(".od-account-bar"));
  const boxes: Box[] = [];
  for (const kind of KINDS) {
    const box = await boxOf(tab(page, kind));
    expect(box.height).toBeLessThanOrEqual(ONE_LINE_PX);
    expect(box.x).toBeGreaterThanOrEqual(bar.x);
    expect(box.x + box.width).toBeLessThanOrEqual(bar.x + bar.width);
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height);
    expect(await tab(page, kind).evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    boxes.push(box);
  }
  return boxes;
}

async function expectOneLine(page: Page): Promise<void> {
  expect((await boxOf(page.getByTestId("order-account"))).height).toBeLessThanOrEqual(ONE_LINE_BAND_PX);
  const symbol = await boxOf(page.getByTestId("order-symbol-head"));
  const name = await boxOf(label(page));
  expect(name.height).toBeLessThanOrEqual(ONE_LINE_PX);
  const tabs = await expectTabsWhole(page);
  const environment = page.getByTestId("account-mock");
  const settings = await boxOf(page.getByTestId("order-settings-button"));
  const row = [symbol, name, ...(await environment.count() === 0 ? [] : [await boxOf(environment)]), ...tabs, settings];
  for (const box of row) expect(Math.abs(centerY(box) - centerY(name))).toBeLessThan(4);
  for (const [index, box] of row.entries()) {
    const next = row[index + 1];
    if (next !== undefined) expect(next.x).toBeGreaterThanOrEqual(box.x + box.width - 1);
  }
}

async function expectCompactHeaderHeight(page: Page): Promise<void> {
  const account = await boxOf(page.getByTestId("order-account"));
  const summary = await boxOf(page.getByTestId("order-summary"));
  const quantity = await boxOf(page.getByTestId("order-quantity-row"));
  expect(Math.round(account.height + summary.height + quantity.height)).toBe(COMPACT_HEADER_TOTAL_PX);
}

test("420px 창의 상단 1줄은 한 줄이고 단추는 미체결·보유·체결로 줄어든다", async ({ page, scenario }) => {
  await openBand(page, scenario, { others: true, longAlias: true, allowMargin: true });
  await sizeWindow(page, 420);
  await shows(tab(page, "open"), "미체결 0");
  await shows(tab(page, "holdings"), "보유 2");
  await shows(tab(page, "fills"), "체결 0");
  await expect(tab(page, "holdings")).toHaveAccessibleName("보유종목 2");
  await expectOneLine(page);
  await expectCompactHeaderHeight(page);
  expect((await boxOf(label(page))).width).toBeGreaterThan(40);
  const ellipsis = await label(page).locator(".od-account-text").evaluate((element) => ({ overflow: element.scrollWidth > element.clientWidth, textOverflow: getComputedStyle(element).textOverflow }));
  expect(ellipsis).toEqual({ overflow: true, textOverflow: "ellipsis" });
});

test("모의: 420px 창의 상단 1줄은 모의투자 배지가 있어도 한 줄이다", async ({ page, scenario }) => {
  await openBand(page, scenario, { others: true, longAlias: true, allowMargin: true, mock: true });
  await sizeWindow(page, 420);
  await expect(page.getByTestId("account-mock")).toHaveText("모의투자");
  await expectOneLine(page);
  await expectCompactHeaderHeight(page);
});

test("520px 창부터는 단추 이름을 줄이지 않는다", async ({ page, scenario }) => {
  await openBand(page, scenario);
  await sizeWindow(page, 520);
  await shows(tab(page, "open"), "미체결 주문 0");
  await shows(tab(page, "holdings"), "보유종목 2");
  await shows(tab(page, "fills"), "내 체결 0");
  await expectOneLine(page);
  await expectCompactHeaderHeight(page);

  await sizeWindow(page, 519);
  await shows(tab(page, "open"), "미체결 0");
  await shows(tab(page, "holdings"), "보유 2");
  await shows(tab(page, "fills"), "체결 0");
  await expectOneLine(page);
  await expectCompactHeaderHeight(page);
});

test("360px 좁은 창에서도 상단 3줄이 래핑 없이 96px 고정이고 단추는 미·보·체로 줄어든다", async ({ page, scenario }) => {
  await openBand(page, scenario, { allowMargin: true, rateOff: true });
  await sizeWindow(page, 360);
  await shows(tab(page, "open"), "미 0");
  await shows(tab(page, "holdings"), "보 2");
  await shows(tab(page, "fills"), "체 0");
  await expect(tab(page, "holdings")).toHaveAccessibleName("보유종목 2");
  await expectOneLine(page);
  await expectCompactHeaderHeight(page);
  expect(await label(page).evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
});
