import type { Locator, Page } from "@playwright/test";
import type { FeedKind } from "../src/api/generated/FeedKind";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { ProgramTradePoint } from "../src/api/generated/ProgramTradePoint";
import type { TradePrint } from "../src/api/generated/TradePrint";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pickDesktopVenue, pollSaved, test, windowTabs } from "./harness";
import { FUNDAMENTAL_FIGURES, openOrderWindow, ordersOn, pinQuote, snapshot, tradingApi, win } from "./order-window";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const CODE = "005930";
const NAME = "삼성전자";
const at = (clock: string) => Date.parse(`2026-11-09T${clock}+09:00`) / 1000;
const MENU = { trades: /^체결/, program: /^프로그램 체결/, brokers: /^거래원 입체분석/ } as const;

const point = (time: string, netQuantity: number): ProgramTradePoint => ({ time, price: 70_000, buyQuantity: 100, sellQuantity: 60, netQuantity, buyAmount: 0, sellAmount: 0, netAmount: 0 });
const POINTS = [point("09:00:00", 10), point("09:01:00", 10), point("09:02:00", 30)];
const TAPE: TradePrint[] = [
  { time: "10:00:02", price: 71_200, quantity: 15, exchange: "krx" },
  { time: "10:00:01", price: 71_100, quantity: -700, exchange: "krx" },
];

async function start(page: Page, scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS },
    ...layout.windows.filter((w) => w.kind !== "chart"),
    { id: "book", link: null, kind: "book" },
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, { body: { symbol: CODE, upperLimit: 91_000, lowerLimit: 49_000, ...FUNDAMENTAL_FIGURES } });
  pinQuote(scenario, CODE, 70_000, 1_000);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, { body: snapshot(70_000) });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/trades`, { body: { symbol: CODE, venue: "combined", trades: TAPE, skippedRows: 0 } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/program-trades`, { body: { symbol: CODE, points: POINTS, skippedRows: 0 } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function addWindow(page: Page, kind: keyof typeof MENU) {
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" }).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: MENU[kind] }).click();
  await page.mouse.move(2, 2);
}

async function subOf(scenario: Scenario, kind: FeedKind): Promise<string> {
  let sub = "";
  await pollSaved(() => {
    const message = scenario.live.messages.findLast((m) => m.type === "subscribe_feed" && m.kind === kind && m.symbol === CODE);
    sub = message?.type === "subscribe_feed" ? message.sub : "";
    return sub;
  }).not.toBe("");
  return sub;
}

async function expectNameWithoutCode(head: Locator, prefix: string) {
  await expect(head.getByTestId(`${prefix}-name`)).toHaveText(NAME);
  await expect(head.getByTestId(`${prefix}-price`)).toBeVisible();
  await expect(head).not.toContainText(CODE);
}

test("프로그램 체결 목록은 순매수 증감이 0인 행을 빼고 머리의 누적 값은 모든 행으로 계산한다", async ({ page, scenario }) => {
  await start(page, scenario);
  await addWindow(page, "program");
  const rows = page.getByTestId("program-row");
  await expect(rows.first()).toContainText("09:02:00");
  scenario.live.emit({ type: "feed_program", sub: await subOf(scenario, "program"), row: { t: at("09:03:00"), price: 70_100, sellQty: 3_000, sellAmount: 0, buyQty: 5_000, buyAmount: 0, netQty: 30, netQtyChange: 0, netAmount: 0, netAmountChange: 0 } });
  await expect(page.getByTestId("program-buy-qty")).toHaveText("5,000");
  await expect(page.getByTestId("program-sell-qty")).toHaveText("3,000");
  await expect(rows.locator(".pg-time")).toHaveText(["09:02:00", "09:00:00"]);
});

test("프로그램 체결 창은 앱 거래소가 KRX나 NXT여도 통합 표시를 붙이지 않는다", async ({ page, scenario }) => {
  await start(page, scenario);
  await addWindow(page, "program");
  await expect(page.getByTestId("program-row").first()).toBeVisible();
  const tab = page.getByRole("tab", { name: /^프로그램 체결/ });
  for (const venue of ["KRX", "NXT"] as const) {
    await pickDesktopVenue(page, venue);
    await expect(tab).toBeVisible();
    await expect(tab.locator(".mw-integrated")).toHaveCount(0);
  }
});

test("체결 행 왼쪽에 매수·매도 세로선이 없고 체결량 글자색은 남는다", async ({ page, scenario }) => {
  await start(page, scenario);
  await addWindow(page, "trades");
  const rows = page.getByTestId("trade-row");
  await expect(rows).toHaveCount(2);
  const styles = await rows.evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return { drawn: style.borderLeftWidth !== "0px" && style.borderLeftColor !== "rgba(0, 0, 0, 0)", shadow: style.boxShadow, before: getComputedStyle(element, "::before").content, quantity: getComputedStyle(element.querySelector(".tr-qty")!).color };
  }));
  expect(styles.map(({ drawn, shadow, before }) => ({ drawn, shadow, before }))).toEqual([{ drawn: false, shadow: "none", before: "none" }, { drawn: false, shadow: "none", before: "none" }]);
  expect(styles.map(({ quantity }) => quantity)).toEqual(["rgb(255, 114, 114)", "rgb(111, 171, 255)"]);
});

test("체결 목록에 마우스를 올려도 새 체결이 바로 맨 위에 붙고 멈춤 배지와 새 체결 단추가 없다", async ({ page, scenario }) => {
  await start(page, scenario);
  await addWindow(page, "trades");
  const rows = page.getByTestId("trade-row");
  await expect(rows).toHaveCount(2);
  const sub = await subOf(scenario, "trades");
  await page.getByTestId("trade-tape").hover();
  scenario.live.emit({ type: "feed_trades", sub, seq: 1, trades: [{ t: at("10:00:05"), price: 71_500, qty: 6, venue: "krx", strength: null }] });
  await expect(rows.first()).toContainText("10:00:05");
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId("trades-window").getByRole("columnheader").first()).toHaveText("시각");
  await expect(page.getByTestId("trades-window")).not.toContainText(/멈춤|새 체결/);
});

test("네 시세 창 머리에 종목코드가 없다", async ({ page, scenario }) => {
  await start(page, scenario);
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  await expectNameWithoutCode(page.getByTestId("book-window").getByTestId("market-symbol-head"), "market-symbol");
  await addWindow(page, "trades");
  await expectNameWithoutCode(page.getByTestId("trades-window").getByTestId("market-symbol-head"), "market-symbol");
  await addWindow(page, "program");
  await expectNameWithoutCode(page.locator("[data-dock-group]").filter({ has: page.getByTestId("program-window") }).getByTestId("market-symbol-head"), "market-symbol");
  await addWindow(page, "brokers");
  await expectNameWithoutCode(page.getByTestId("brokers-window").getByTestId("market-symbol-head"), "market-symbol");
});

test("호가주문 창 머리에 종목코드가 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await expectNameWithoutCode(win(page).getByTestId("order-symbol-head"), "order-symbol");
});
