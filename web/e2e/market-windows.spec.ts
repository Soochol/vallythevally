import type { Locator, Page } from "@playwright/test";
import type { FeedBrokers } from "../src/api/generated/FeedBrokers";
import type { FeedKind } from "../src/api/generated/FeedKind";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { OrderBook } from "../src/api/generated/OrderBook";
import type { ProgramTradePoint } from "../src/api/generated/ProgramTradePoint";
import type { TradePrint } from "../src/api/generated/TradePrint";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, test, pollSaved, windowTabs } from "./harness";
import { CONNECTED_KIWOOM } from "./fixtures/scenario";
import { FUNDAMENTAL_FIGURES, pinQuote } from "./order-window";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const CODE = "005930";
const NAME = "삼성전자";
const at = (clock: string) => Date.parse(`2026-11-09T${clock}+09:00`) / 1000;
const FAILURE = { status: 503, body: { error: { code: "internal", message: "서버가 응답하지 못했습니다", reason: null, retryAt: null, manualActionRequired: false } } };

const MENU = { trades: /^체결/, program: /^프로그램 체결/, brokers: /^거래원 입체분석/ } as const;
type MenuKind = keyof typeof MENU;

const BOOK: OrderBook = {
  symbol: CODE,
  asks: Array.from({ length: 10 }, (_, i) => ({ price: 70_000 + 100 * (i + 1), quantity: 1_234_567 + i })),
  bids: Array.from({ length: 10 }, (_, i) => ({ price: 70_000 - 100 * i, quantity: 987_654 + i })),
  totalAskQuantity: 12_345_678,
  totalBidQuantity: 23_456_789,
  afterHoursAskQuantity: null,
  afterHoursBidQuantity: null,
  bookTime: null,
};

const TAPE: TradePrint[] = [
  { time: "10:00:02", price: 71_200, quantity: 15, exchange: "krx" },
  { time: "10:00:01", price: 71_100, quantity: -700, exchange: "krx" },
];

const POINTS: ProgramTradePoint[] = ["09:00:00", "09:01:00", "09:02:00"].map((time, i) => ({ time, price: 70_000 + 100 * i, buyQuantity: 100, sellQuantity: 60, netQuantity: 10 * (i + 1) * (i % 2 === 0 ? 1 : -1), buyAmount: 0, sellAmount: 0, netAmount: 0 }));

const BROKERS: FeedBrokers = { t: at("09:30:00"), buys: [{ code: "151", name: "키움", qty: 400, qtyChange: 0 }], sells: [{ code: "141", name: "삼성", qty: 120, qtyChange: 0 }] };

function layoutWith(scenario: Scenario, extra: LayoutWindow[] = []) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS },
    ...layout.windows.filter((w) => w.kind !== "chart"),
    ...extra,
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
}

function serve(scenario: Scenario) {
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, { body: { symbol: CODE, upperLimit: 91_000, lowerLimit: 49_000, ...FUNDAMENTAL_FIGURES } });
  pinQuote(scenario, CODE, 70_000, 1_000);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, { body: BOOK });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/trades`, { body: { symbol: CODE, venue: "combined", trades: TAPE, skippedRows: 0 } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/program-trades`, { body: { symbol: CODE, points: POINTS, skippedRows: 0 } });
}

async function start(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function openBook(page: Page) {
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  await expect(page.getByTestId("book-window")).toBeVisible();
}

async function addWindow(page: Page, kind: MenuKind) {
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

const subscriptions = (scenario: Scenario, kind: FeedKind) => scenario.live.messages.filter((m) => m.type === "subscribe_feed" && m.kind === kind && m.symbol === CODE).length;
const requests = (scenario: Scenario, path: string) => scenario.requests.filter((r) => new URL(r.url()).pathname === path).length;

const rowMetrics = (rows: Locator, text: string) => rows.evaluateAll((elements, selector) => elements.map((row) => {
  const target = row.querySelector(selector) ?? row;
  return { height: Math.round(row.getBoundingClientRect().height * 10) / 10, fontSize: parseFloat(getComputedStyle(target).fontSize) };
}), text);

async function expectRows(rows: Locator, text: string) {
  await expect(rows.first()).toBeVisible();
  const metrics = await rowMetrics(rows, text);
  expect(metrics.length).toBeGreaterThan(0);
  for (const metric of metrics) {
    expect(metric.height, JSON.stringify(metric)).toBe(24);
    expect(metric.fontSize, JSON.stringify(metric)).toBeGreaterThanOrEqual(12);
  }
}

test("네 시세 창 모두 창 안에 종목 이름을 보이고 자료 줄은 24px에 12px 이상 글자다", async ({ page, scenario }) => {
  layoutWith(scenario, [{ id: "book", link: null, kind: "book" }]);
  serve(scenario);
  await start(page);

  await openBook(page);
  await expect(page.getByTestId("book-window").getByTestId("market-symbol-name")).toHaveText(NAME);
  await expectRows(page.getByTestId("price-ladder").locator(".mw-lr:not([data-empty])"), ".mw-qty-value");

  await addWindow(page, "trades");
  const trades = page.getByTestId("trades-window");
  await expect(trades.getByTestId("market-symbol-name")).toHaveText(NAME);
  await expect(trades.getByTestId("trade-row")).toHaveCount(2);
  await expectRows(trades.getByTestId("trade-row"), ".tr-qty");

  await addWindow(page, "program");
  const program = page.locator("[data-dock-group]").filter({ has: page.getByTestId("program-window") });
  await expect(program.getByTestId("market-symbol-name")).toHaveText(NAME);
  await expect(program.getByTestId("program-row")).toHaveCount(3);
  await expectRows(program.getByTestId("program-row"), ".pg-change em");

  await addWindow(page, "brokers");
  const brokers = page.getByTestId("brokers-window");
  await expect(brokers.getByTestId("market-symbol-name")).toHaveText(NAME);
  scenario.live.emit({ type: "feed_brokers", sub: await subOf(scenario, "brokers"), brokers: BROKERS });
  await expect(brokers.getByTestId("broker-card")).toHaveCount(2);
  await brokers.getByRole("group", { name: "보기" }).getByRole("button", { name: "거래원" }).click();
  await expect(brokers.getByTestId("broker-row")).toHaveCount(2);
  await expectRows(brokers.getByTestId("broker-row"), "[data-testid='broker-name']");
  await expectRows(brokers.getByTestId("broker-row"), "[data-testid='broker-cumulative']");
});

test("프로그램 체결 표의 숫자 열 머리와 값은 오른쪽 끝이 같고 현재가는 전일 대비 색이다", async ({ page, scenario }) => {
  layoutWith(scenario);
  serve(scenario);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/day-summary`, { body: { symbol: CODE, venue: "combined", price: 70_200, previousClose: 70_100, open: null, high: null, low: null, volume: null, tradeValueWon: null, t: null } });
  await start(page);
  await addWindow(page, "program");
  const window = page.getByTestId("program-window");
  await expect(window.getByTestId("program-row")).toHaveCount(3);
  const headers = window.getByRole("columnheader");
  const rightOf = async (locator: Locator) => locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return Math.round(range.getBoundingClientRect().right);
  });
  for (const [column, selector] of [[1, ".pg-price"], [2, ".pg-change em"]] as const) {
    const head = await rightOf(headers.nth(column));
    for (const value of await window.getByTestId("program-row").locator(selector).all()) expect(await rightOf(value), selector).toBe(head);
  }
  const prices = window.getByTestId("program-row").locator(".pg-price");
  await expect(prices.nth(0)).toHaveClass(/mw-up/);
  await expect(prices.nth(2)).toHaveClass(/mw-down/);
});

test("매수 체결과 매도 체결의 체결량 글자색이 다르다", async ({ page, scenario }) => {
  layoutWith(scenario);
  serve(scenario);
  await start(page);
  await addWindow(page, "trades");
  const rows = page.getByTestId("trade-row");
  await expect(rows).toHaveCount(2);
  const colorOf = (side: string) => page.locator(`[data-testid=trade-row][data-side=${side}] .tr-qty`).first().evaluate((element) => getComputedStyle(element).color);
  const buy = await colorOf("buy");
  const sell = await colorOf("sell");
  expect(buy).toBe("rgb(255, 107, 120)");
  expect(sell).toBe("rgb(91, 155, 255)");
});

test("폭 280px 10호가 창에는 잘린 숫자가 없다", async ({ page, scenario }) => {
  layoutWith(scenario, [{ id: "book", link: null, kind: "book" }]);
  serve(scenario);
  await start(page);
  await openBook(page);
  const handle = (await page.getByRole("separator", { name: "좌우 창 경계" }).first().boundingBox())!;
  const point = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await page.keyboard.down("Alt");
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(1440, point.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const group = page.locator("[data-dock-group]").filter({ has: page.getByTestId("book-window") });
  await expect.poll(async () => (await group.boundingBox())!.width).toBe(280);
  const sub = await subOf(scenario, "book");
  scenario.live.emit({ type: "feed_book", sub, book: { t: 1, asks: BOOK.asks.map((level) => ({ price: level.price, qty: level.quantity + 11_111 })), bids: BOOK.bids.map((level) => ({ price: level.price, qty: level.quantity - 11_111 })), totalAskQty: 12_345_679, totalBidQty: 23_456_788, expected: null } });
  await expect(page.locator(".mw-qty-value").first()).toHaveText("1,245,687");
  const clipped = await page.getByTestId("book-window").evaluate((root) => {
    const found: string[] = [];
    const ownText = (element: Element) => Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("");
    for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      if (element.offsetParent === null || !/\d/.test(ownText(element))) continue;
      const note = `${element.className}: ${element.textContent}`;
      if (element.clientWidth > 0 && element.scrollWidth > element.clientWidth) found.push(`넘침 ${note}`);
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      for (let clip = element.parentElement; clip !== null && root.contains(clip); clip = clip.parentElement) {
        if (getComputedStyle(clip).overflowX === "visible") continue;
        const box = clip.getBoundingClientRect();
        if (text.left < box.left - 0.5 || text.right > box.right + 0.5) found.push(`잘림 ${note}`);
      }
    }
    return found;
  });
  expect(clipped).toEqual([]);
});

test("호가 조회가 실패하면 다시 시도로 다시 조회한다", async ({ page, scenario }) => {
  layoutWith(scenario, [{ id: "book", link: null, kind: "book" }]);
  serve(scenario);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, FAILURE);
  await start(page);
  await openBook(page);
  const book = page.getByTestId("book-window");
  await expect(book.getByText("호가를 불러오지 못했습니다")).toBeVisible();
  const before = requests(scenario, `/api/symbols/${CODE}/order-book`);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, { body: BOOK });
  await book.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByTestId("price-ladder")).toBeVisible();
  expect(requests(scenario, `/api/symbols/${CODE}/order-book`)).toBe(before + 1);
});

test("체결 조회가 실패하면 알림 띠의 다시 시도로 다시 조회한다", async ({ page, scenario }) => {
  layoutWith(scenario);
  serve(scenario);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/trades`, FAILURE);
  await start(page);
  await addWindow(page, "trades");
  const trades = page.getByTestId("trades-window");
  const alert = trades.getByRole("alert").filter({ hasText: "당일 체결을 불러오지 못했습니다" });
  await expect(alert).toBeVisible();
  await expect(trades.getByText("체결이 아직 없습니다")).toHaveCount(0);
  const before = requests(scenario, `/api/symbols/${CODE}/trades`);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/trades`, { body: { symbol: CODE, venue: "combined", trades: TAPE, skippedRows: 0 } });
  await alert.getByRole("button", { name: "다시 시도" }).click();
  await expect(trades.getByTestId("trade-row")).toHaveCount(2);
  await expect(alert).toHaveCount(0);
  expect(requests(scenario, `/api/symbols/${CODE}/trades`)).toBeGreaterThan(before);
  expect(subscriptions(scenario, "trades")).toBe(1);
});

test("거래원 구독이 실패하면 다시 시도로 다시 구독한다", async ({ page, scenario }) => {
  layoutWith(scenario);
  serve(scenario);
  await start(page);
  await addWindow(page, "brokers");
  const brokers = page.getByTestId("brokers-window");
  scenario.live.emit({ type: "sub_error", sub: await subOf(scenario, "brokers"), code: "realtime_limit" });
  await expect(brokers.getByText("거래원을 받지 못했습니다")).toBeVisible();
  expect(subscriptions(scenario, "brokers")).toBe(1);
  await brokers.getByRole("button", { name: "다시 시도" }).click();
  await pollSaved(() => subscriptions(scenario, "brokers")).toBe(2);
  scenario.live.emit({ type: "feed_brokers", sub: await subOf(scenario, "brokers"), brokers: BROKERS });
  await expect(brokers.getByTestId("broker-card")).toHaveCount(2);
});

test("키움 연결 전 시세 창에는 연결 버튼이 있고 누르면 키움 설정을 연다", async ({ page, scenario }) => {
  layoutWith(scenario, [{ id: "book", link: null, kind: "book" }]);
  serve(scenario);
  scenario.live.kiwoomLink = { ...CONNECTED_KIWOOM, state: "disconnected", message: "키움에 연결하지 않았습니다" };
  await start(page);
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  const gate = page.getByTestId("market-window-gate");
  await expect(gate.getByText("키움 연결 전입니다")).toBeVisible();
  await gate.getByRole("button", { name: "연결" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
