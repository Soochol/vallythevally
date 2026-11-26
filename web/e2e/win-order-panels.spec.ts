import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { LinkColor } from "../src/api/generated/LinkColor";
import type { TradingExecution } from "../src/api/generated/TradingExecution";
import type { TradingHolding } from "../src/api/generated/TradingHolding";
import { DEFAULT_ORDER_SETTINGS } from "../src/features/order/orderSettings";
import { CONNECTED_KIWOOM } from "./fixtures/scenario";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pollSaved, test, windowTabs } from "./harness";
import { accountData, ACCOUNT, askAtLastSnapshot, SETTINGS, BASE, CODE, cellAt, center, chipAt, commandOf, dragChip, INFO_PAGE_1, INFO_PAGE_2, infoCard, infoLabels, infoTab, infoValues, KIS_ACCOUNT, kisAccount, nxtTraded, openOrder, openOrderWindow, ordersOn, otherAccount, pinQuote, FUNDAMENTAL_FIGURES, SECOND_ACCOUNT, status, tradingApi, win, writesTo } from "./order-window";

const HOLDING: TradingHolding = { code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 100, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: -4_800, profitRateCenti: -57 };
const FILL: TradingExecution = { orderNo: "0000010", code: CODE, name: "삼성전자", side: "buy", quantity: 5, price: 70_000, time: "093015", venue: "krx" };

const ladderRows = (page: Page) => page.getByTestId("price-ladder").locator(".mw-lr");

function lastTrade(scenario: Scenario, price: number, seq = 1, qty = 3, venue: "combined" | "krx" = "combined"): void {
  const requests = scenario.live.messages.filter((m) => m.type === "subscribe_feed" && m.kind === "trades" && m.venue === venue);
  if (requests.length === 0) throw new Error("체결 구독이 없습니다");
  for (const request of requests) {
    if (request.type !== "subscribe_feed") continue;
    scenario.live.emit({ type: "feed_trades", sub: request.sub, seq, trades: [{ t: scenario.now / 1000 + seq, price, qty, venue: "krx", strength: 101.5 }] });
  }
}

const tops = (locator: Locator) => locator.evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top * 10) / 10));
const topOf = async (locator: Locator) => (await locator.boundingBox())!.y;

const FIRST_LADDER_ROW = (page: Page) => ladderRows(page).first();

test("목록 popover가 단추에 붙어 사다리를 밀지 않고 Esc·바깥 누르기·같은 단추로 닫히며 다른 단추로 바뀐다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5)]);
  api.holdings = [HOLDING];
  api.executions = [FILL];
  await openOrderWindow(page, scenario);
  const before = await topOf(FIRST_LADDER_ROW(page));
  const panel = page.getByTestId("account-panel");
  const holdingsTab = page.getByTestId("account-tab-holdings");

  await holdingsTab.click();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("role", "dialog");
  await expect(page.getByTestId("account-holding")).toContainText("삼성전자");
  expect(await topOf(FIRST_LADDER_ROW(page))).toBe(before);
  const box = (await panel.boundingBox())!;
  const windowBox = (await win(page).boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(360);
  expect(box.height).toBeLessThanOrEqual(240);
  expect(box.x).toBeGreaterThanOrEqual(windowBox.x);
  expect(box.x + box.width).toBeLessThanOrEqual(windowBox.x + windowBox.width);
  expect((await holdingsTab.boundingBox())!.y + (await holdingsTab.boundingBox())!.height).toBeLessThanOrEqual(box.y);

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  await page.getByTestId("account-tab-fills").click();
  const fillsBox = (await panel.boundingBox())!;
  expect(fillsBox.x + fillsBox.width).toBeLessThanOrEqual(windowBox.x + windowBox.width);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  await holdingsTab.click();
  await expect(panel).toBeVisible();
  await holdingsTab.click();
  await expect(panel).toHaveCount(0);

  await holdingsTab.click();
  await expect(panel).toBeVisible();
  await page.getByTestId("account-tab-fills").click();
  await expect(panel).toHaveAttribute("data-panel", "fills");
  await expect(page.getByTestId("account-fill")).toContainText("09:30:15");
  await expect(page.getByTestId("account-holding")).toHaveCount(0);

  await page.getByTestId("order-account").click({ position: { x: 4, y: 4 } });
  await expect(panel).toHaveCount(0);
});

test("끝 2자리를 모르는 옛 켜짐 기록이면 계좌 줄이 키움 —를 보이고 가리기를 꺼도 조회하지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  scenario.live.orders = { ...scenario.live.orders, accountTail: null };
  tradingApi(scenario);
  let lookups = 0;
  scenario.on((url) => url.pathname === "/api/trading/account-number", () => { lookups += 1; return { body: { accountNumber: "1234567810" } }; });
  await openOrderWindow(page, scenario);
  const label = page.getByTestId("account-label");
  await expect(label).toHaveText("키움 —");
  await page.getByTestId("order-settings-button").click();
  await page.getByRole("checkbox", { name: "계좌번호 가리기" }).uncheck();
  await expect(label).toHaveText("키움 —");
  expect(lookups).toBe(0);
});

test("계좌번호 조회가 실패하면 가린 모양과 실패 title을 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  scenario.on((url) => url.pathname === "/api/trading/account-number", () => ({ status: 503, body: { error: { code: "internal", message: "계좌번호를 읽지 못했습니다", reason: null, retryAt: null, manualActionRequired: false } } }));
  await openOrderWindow(page, scenario);
  await page.getByTestId("order-settings-button").click();
  await page.getByRole("checkbox", { name: "계좌번호 가리기" }).uncheck();
  const label = page.getByTestId("account-label");
  await expect(label).toHaveAttribute("title", "계좌번호를 읽지 못했습니다");
  await expect(label).toHaveText("키움 ****-**01");
});

test("보유가 없는 종목의 매입수량 칸에는 툴팁이 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [];
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("summary-quantity")).toContainText("-");
  await expect(page.getByTestId("summary-quantity")).not.toHaveAttribute("title", /.+/);
});

const scrollLadder = (page: Page, top: number | "end") => page.getByTestId("order-ladder").evaluate((element, target) => { element.scrollTop = target === "end" ? element.scrollHeight : target; }, top);
const fullTickCount = 431;

test("전체 호가는 상한부터 하한까지 스크롤하고 다시 누르면 20행이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, BASE);
  await page.getByTestId("order-explorer").click();
  await expect(page.getByTestId("order-explorer")).toHaveAttribute("aria-pressed", "true");
  const ladder = page.getByTestId("order-ladder");
  const current = cellAt(page, "buy", BASE);
  await expect(current).toBeVisible();
  const area = (await ladder.boundingBox())!;
  const middle = (await current.boundingBox())!;
  expect(Math.abs(middle.y + middle.height / 2 - (area.y + area.height / 2))).toBeLessThan(30);
  const rendered = await ladderRows(page).count();
  expect(rendered).toBeGreaterThan(20);
  expect(rendered).toBeLessThan(fullTickCount);
  expect(await ladder.evaluate((element) => element.scrollHeight)).toBeGreaterThanOrEqual(fullTickCount * 24);

  await scrollLadder(page, "end");
  await expect(cellAt(page, "buy", 49_000)).toBeVisible();
  await scrollLadder(page, 0);
  await expect(cellAt(page, "sell", 91_000)).toBeVisible();

  await page.getByTestId("order-explorer").click();
  await expect(page.getByTestId("order-explorer")).toHaveAttribute("aria-pressed", "false");
  await expect(ladderRows(page)).toHaveCount(20);
  await expect(cellAt(page, "buy", BASE)).toBeVisible();
});

test("전체 호가에서 스크롤한 자리의 칸을 더블클릭하면 그 가격으로 신규가 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, BASE);
  await page.getByTestId("order-explorer").click();
  await expect(cellAt(page, "buy", BASE)).toBeVisible();
  const before = await page.getByTestId("order-ladder").evaluate((element) => element.scrollTop);
  await scrollLadder(page, before + 30 * 24);
  const target = cellAt(page, "buy", 67_000);
  await expect(target).toBeVisible();
  await target.dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ code: CODE, side: "buy", price: 67_000, quantity: 10 });
});

test("상·하한가를 받지 못하면 전체 호가 단추가 꺼지고 이유를 툴팁으로 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, false, "krx", { upper: null, lower: null });
  await expect(page.getByTestId("order-explorer")).toBeDisabled();
  await expect(page.getByTestId("order-explorer")).toHaveAttribute("title", "상·하한가를 아직 받지 못했습니다");
});

test("평단가 점은 평단가에 가장 가까운 가격 행의 가격 칸 안 가격 숫자 왼쪽에 하나 있고 숫자 x와 행 높이는 다른 행과 같다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [HOLDING];
  await openOrderWindow(page, scenario);
  const marks = page.getByTestId("ladder-mark");
  await expect(marks).toHaveCount(1);
  const marked = ladderRows(page).filter({ has: marks });
  await expect(marked).toHaveCount(1);
  await expect(marked.locator(".mw-px-num")).toHaveText("70,000");
  await expect(marked.locator(".mw-px").getByTestId("ladder-mark")).toHaveCount(1);
  const dot = (await marks.boundingBox())!;
  const markedNumber = (await marked.locator(".mw-px-num").boundingBox())!;
  expect(dot.x + dot.width).toBeLessThanOrEqual(markedNumber.x);
  const rights = await ladderRows(page).locator(".mw-px-num").evaluateAll((numbers) => numbers.map((number) => Math.round(number.getBoundingClientRect().right * 10) / 10));
  expect(rights).toEqual(Array(20).fill(rights[0]));
  const heights = await ladderRows(page).evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  expect(new Set(heights)).toEqual(new Set([24]));
});

test("칩을 끄는 동안 매도 1호가가 바뀌어도 행의 가격이 움직이지 않고 놓으면 새 매도 1호가 기준이 된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5)]);
  await openOrderWindow(page, scenario);
  const prices = () => ladderRows(page).locator(".mw-px-num").allTextContents();
  const before = await prices();
  expect(before[0]).toBe("71,000");
  await dragChip(page, chipAt(page, "buy", 70_000), await center(cellAt(page, "buy", 69_800)), false);
  await expect(page.getByTestId("order-ghost")).toBeVisible();
  const movedAsks = Array.from({ length: 10 }, (_, i) => ({ price: 70_300 + 100 * i, qty: 10 + i }));
  const movedBids = Array.from({ length: 10 }, (_, i) => ({ price: 70_200 - 100 * i, qty: 20 + i }));
  await emitSingleBook(scenario, movedAsks, movedBids);
  expect(await prices()).toEqual(before);
  await page.mouse.up();
  await pollSaved(() => writesTo(api, "modify")).toHaveLength(1);
  expect(writesTo(api, "modify")[0]!.body).toMatchObject({ orderNo: "0000001", price: 69_800 });
  await expect(ladderRows(page).locator(".mw-px-num").first()).toHaveText("71,200");
  await expect(ladderRows(page).locator(".mw-px-num").nth(9)).toHaveText("70,300");
});

test("설정 ⚙의 값이 창 설정으로 저장되고 새로고침해도 유지된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [HOLDING];
  await openOrderWindow(page, scenario);
  await expect(page.getByRole("group", { name: "금액 프리셋" }).getByRole("button")).toHaveText(["100만", "500만", "1,000만", "5,000만"]);
  await expect(page.getByTestId("order-ladder")).toHaveAttribute("data-divider", "");
  await expect(page.getByTestId("ladder-mark")).toHaveCount(1);
  await page.getByTestId("order-settings-button").click();
  const preset = page.getByRole("textbox", { name: "금액 프리셋 2", exact: true });
  await preset.fill("750");
  await preset.blur();
  await page.getByRole("checkbox", { name: "구분선" }).uncheck();
  await page.getByRole("checkbox", { name: "평단가 점" }).uncheck();
  await expect(page.getByRole("group", { name: "금액 프리셋" }).getByRole("button").nth(1)).toHaveText("750만");
  await expect(page.getByTestId("order-ladder")).not.toHaveAttribute("data-divider", "");
  await expect(page.getByTestId("ladder-mark")).toHaveCount(0);
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ amountPresets: [100, 750, 1000, 5000], averageDot: false, divider: false, rate: true, maskAccount: true });

  await page.reload();
  await expect(win(page)).toBeVisible();
  await expect(page.getByRole("group", { name: "금액 프리셋" }).getByRole("button").nth(1)).toHaveText("750만");
  await expect(page.getByTestId("order-ladder")).not.toHaveAttribute("data-divider", "");
  await expect(page.getByTestId("ladder-mark")).toHaveCount(0);
  expect(scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.some((w) => w.kind === "order")).toBe(true);
});

test("호가주문 설정에서 호가 간격을 바꾸면 행 높이·카드·전체호가 높이가 바뀌고 새로고침해도 유지된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const rowHeight = () => ladderRows(page).first().evaluate((row) => Math.round(row.getBoundingClientRect().height * 10) / 10);
  const cardHeight = () => infoCard(page).evaluate((card) => Math.round(card.getBoundingClientRect().height * 10) / 10);

  await expect(win(page)).toHaveAttribute("data-ladder-density", "normal");
  await expect.poll(rowHeight).toBe(24);
  await expect.poll(cardHeight).toBe(240);

  await openSettings(page);
  const density = page.getByTestId("order-settings").getByRole("group", { name: "호가 간격" });
  await expect(density.getByRole("button", { name: "보통" })).toHaveAttribute("aria-pressed", "true");

  await density.getByRole("button", { name: "촘촘" }).click();
  await expect(win(page)).toHaveAttribute("data-ladder-density", "compact");
  await expect.poll(rowHeight).toBe(20);
  await expect.poll(cardHeight).toBe(200);
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ ladderDensity: "compact" });

  await density.getByRole("button", { name: "여유" }).click();
  await expect(win(page)).toHaveAttribute("data-ladder-density", "spacious");
  await expect.poll(rowHeight).toBe(30);
  await expect.poll(cardHeight).toBe(300);
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ ladderDensity: "spacious" });

  await page.keyboard.press("Escape");
  lastTrade(scenario, BASE);
  await page.getByTestId("order-explorer").click();
  await expect(page.getByTestId("order-explorer")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.getByTestId("order-ladder").evaluate((el) => el.scrollHeight)).toBeGreaterThanOrEqual(fullTickCount * 30);

  await page.reload();
  await expect(win(page)).toBeVisible();
  await expect(win(page)).toHaveAttribute("data-ladder-density", "spacious");
  await expect.poll(rowHeight).toBe(30);
  await expect.poll(cardHeight).toBe(300);
});


const openSettings = async (page: Page) => {
  await page.getByTestId("order-settings-button").click();
  await expect(page.getByTestId("order-settings")).toBeVisible();
};

test("등락률 표시를 끄면 사다리 어느 행에도 등락률이 없고 켜면 가격이 있는 모든 행에 있다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const rates = ladderRows(page).locator(".mw-px small");
  await expect(ladderRows(page)).toHaveCount(20);
  await expect(rates).toHaveCount(20);
  await openSettings(page);
  await page.getByRole("checkbox", { name: "등락률 표시" }).uncheck();
  await expect(rates).toHaveCount(0);
  await page.getByRole("checkbox", { name: "등락률 표시" }).check();
  await expect(rates).toHaveCount(20);
});

async function cutTexts(area: Locator): Promise<string[]> {
  return area.evaluate((root) => {
    const cut: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const text = range.getBoundingClientRect();
      if (!node.textContent?.trim() || text.width === 0 || node.parentElement?.closest(".sr-only")) continue;
      for (let box: Element | null = node.parentElement; box && root.contains(box); box = box.parentElement) {
        const edge = box.getBoundingClientRect();
        if (getComputedStyle(box).overflowX !== "visible" && (text.right > edge.right + 1 || text.left < edge.left - 1)) cut.push(`${node.textContent} < ${box.className}`);
      }
    }
    return cut;
  });
}

async function overlappingChildren(row: Locator): Promise<string[]> {
  return row.evaluate((element) => {
    const boxes = [...element.children].map((child) => ({ name: child.className, box: child.getBoundingClientRect() }));
    return boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 1 && Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 1).map((b) => `${a.name} | ${b.name}`));
  });
}

async function openNarrowest(page: Page, scenario: Scenario): Promise<void> {
  const LARGE = 1_234_567;
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 69_900, 10)]);
  api.holdings = [{ ...HOLDING, quantity: LARGE, sellableQuantity: LARGE, evaluationProfit: -123_456_789, profitRateCenti: -1234 }];
  scenario.reply("/api/trading/balance", { body: { accountRef: ACCOUNT, holdings: api.holdings, creditHoldings: [], totalPurchase: 1_000_000_000, totalEvaluation: 876_543_211, totalProfit: -123_456_789 } });
  nxtTraded(scenario, true);
  pinQuote(scenario, CODE, BASE);
  const large = <T extends object>(levels: T[]): T[] => levels.map((level) => ({ ...level, quantity: LARGE }));
  const { asks, bids, ...rest } = askAtLastSnapshot();
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, { body: { symbol: CODE, upperLimit: 91_000, lowerLimit: 49_000, ...FUNDAMENTAL_FIGURES } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, { body: { ...rest, asks: large(asks), bids: large(bids), totalAskQuantity: 12_345_678, totalBidQuantity: 12_345_678 } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/trades`, { body: { symbol: CODE, venue: "combined", trades: [], skippedRows: 0 } });
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "order", link: null, kind: "order", venue: "krx" },
    { id: "book", link: null, kind: "book" },
  ];
  const canvas = { rects: { "cell-0": { x: 0.8, y: 0, w: 0.2, h: 0.2 }, order: { x: 0.01, y: 0.01, w: 0.1, h: 0.95 }, book: { x: 0.45, y: 0.01, w: 0.1, h: 0.95 } }, order: ["cell-0", "order", "book"] };
  scenario.documents.saveLayout({ ...layout, windows, placement: { v: 1, dock: null, canvas }, revision: layout.revision + 1 });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: "canvas", orderSettings: { ...DEFAULT_ORDER_SETTINGS, rate: false } });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.getByTestId("ladder-strength")).toHaveCount(2);
  await expect(page.getByTestId("summary-quantity")).toContainText("1,234,567");
  await expect(page.getByTestId("summary-buyable")).toContainText("500,000,000원");
  lastTrade(scenario, 70_000, 1, 123_456);
  for (const strength of await page.getByTestId("ladder-strength").all()) await expect(strength).toContainText("101.50%");
}

test("등락률을 끈 호가주문 창을 최소 폭 372px로 줄여도 글자가 잘리거나 겹치지 않고 금액 프리셋이 한 줄이다", async ({ page, scenario }) => {
  await openNarrowest(page, scenario);
  const quantityRow = page.getByTestId("order-quantity-row");
  expect((await page.locator('[data-canvas-window="order"]').boundingBox())!.width).toBeCloseTo(372, 0);
  expect(new Set(await quantityRow.locator(".od-presets, .od-qty-input, .od-preset-mode").evaluateAll((parts) => parts.map((part) => Math.round(part.getBoundingClientRect().top)))).size).toBe(1);
  expect(await cutTexts(win(page))).toEqual([]);
  for (const row of [quantityRow, page.getByTestId("order-summary"), page.locator(".od-account-bar")]) expect(await overlappingChildren(row)).toEqual([]);
});

test("등락률을 끈 10호가 창을 최소 폭 232px로 줄여도 잔량·체결·총잔량 글자가 잘리지 않는다", async ({ page, scenario }) => {
  await openNarrowest(page, scenario);
  const book = page.getByTestId("book-window");
  expect((await page.locator('[data-canvas-window="book"]').boundingBox())!.width).toBeCloseTo(232, 0);
  expect(await cutTexts(book)).toEqual([]);
});

test("보유가 없으면 평단가 점 옆에 안내가 보이고 보유가 있으면 점이 가격 숫자 왼쪽에 있으며 끄면 사라진다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [];
  await openOrderWindow(page, scenario);
  await openSettings(page);
  await expect(page.getByTestId("order-settings")).toContainText("보유 종목일 때 보입니다");
  await expect(page.getByTestId("ladder-mark")).toHaveCount(0);
});

test("보유가 있으면 안내가 없고 평단가 점이 가격 칸 안 가격 숫자 왼쪽에 있으며 끄면 점이 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [HOLDING];
  await openOrderWindow(page, scenario);
  await openSettings(page);
  await expect(page.getByTestId("order-settings")).not.toContainText("보유 종목일 때 보입니다");
  const mark = page.getByTestId("price-ladder").locator(".mw-px").getByTestId("ladder-mark");
  await expect(mark).toHaveCount(1);
  const dot = (await mark.boundingBox())!;
  const number = (await ladderRows(page).filter({ has: page.getByTestId("ladder-mark") }).locator(".mw-px-num").boundingBox())!;
  expect(dot.x + dot.width).toBeLessThanOrEqual(number.x);
  await page.getByRole("checkbox", { name: "평단가 점" }).uncheck();
  await expect(page.getByTestId("ladder-mark")).toHaveCount(0);
});

const stripAt = (page: Page, box: { x: number; y: number; width: number }, down: number) => page.screenshot({ clip: { x: Math.round(box.x) + 2, y: Math.round(box.y) + down, width: Math.max(1, Math.round(box.width) - 4), height: 1 } });
const hasLineOnTop = async (page: Page, box: { x: number; y: number; width: number }) => !(await stripAt(page, box, 0)).equals(await stripAt(page, box, 1));
const boxOfCell = async (locator: Locator) => (await locator.boundingBox())!;

test("구분선을 켜도 상세 정보 카드와 체결 상자 안에는 가로줄이 없고 주문·가격 칸 사이에는 있으며 끄면 어디에도 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const rowShadows = () => ladderRows(page).evaluateAll((rows) => rows.map((row) => {
    const shadow = getComputedStyle(row).boxShadow;
    return shadow === "none" ? null : shadow;
  }));
  const heights = () => ladderRows(page).evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  const infoCell = (row: number) => ladderRows(page).nth(row).locator(".mw-qty[data-side=bid]");
  const askCell = (row: number) => ladderRows(page).nth(row).locator(".mw-qty[data-side=ask]");
  const priceCell = (row: number) => ladderRows(page).nth(row).locator(".mw-px");
  const orderCell = (row: number) => ladderRows(page).nth(row).locator(".od-cell").first();
  const boxLayer = page.getByTestId("ladder-box-layer").locator(".mw-box");
  const underRowTop = async (cellLocator: Locator, row: number) => ({ ...(await boxOfCell(cellLocator)), y: (await boxOfCell(ladderRows(page).nth(row))).y });
  await expect(ladderRows(page)).toHaveCount(20);
  await expect(page.getByTestId("ladder-info")).toHaveCount(6);
  await scrollLadder(page, 0);

  const on = await rowShadows();
  expect(on[0]).toBeNull();
  const lines = on.slice(1);
  expect(lines.every((line) => line !== null)).toBe(true);
  const middle = on[10]!;
  expect(lines.filter((line) => line !== middle)).toHaveLength(18);
  expect(new Set(await heights())).toEqual(new Set([24]));

  const card = await boxOfCell(infoCard(page));
  for (const row of [1, 3, 6]) {
    const cell = await boxOfCell(infoCell(row));
    expect(cell.y).toBeGreaterThanOrEqual(card.y);
    expect(cell.y + cell.height).toBeLessThanOrEqual(card.y + card.height);
    expect(await hasLineOnTop(page, cell), `카드 ${row}행`).toBe(false);
    expect(await hasLineOnTop(page, await boxOfCell(askCell(row))), `매도 잔량 칸 ${row}행`).toBe(true);
    expect(await hasLineOnTop(page, await underRowTop(priceCell(row), row)), `가격 칸 ${row}행`).toBe(true);
    expect(await hasLineOnTop(page, await underRowTop(orderCell(row), row)), `주문 칸 ${row}행`).toBe(true);
  }
  await scrollLadder(page, "end");
  expect(await hasLineOnTop(page, await boxOfCell(infoCell(12))), "정보 칸이 없는 행의 매수 잔량 칸").toBe(true);
  const layer = await boxOfCell(boxLayer);
  expect(await hasLineOnTop(page, layer), "체결 상자 위 가장자리의 가운데 선").toBe(true);
  for (const row of [11, 13, 17]) {
    const rowTop = (await boxOfCell(ladderRows(page).nth(row))).y;
    expect(await hasLineOnTop(page, { x: layer.x, y: rowTop, width: layer.width }), `체결 상자 안 ${row}행 위`).toBe(false);
    expect(await hasLineOnTop(page, await underRowTop(priceCell(row), row)), `${row}행 가격 칸`).toBe(true);
  }

  await openSettings(page);
  await page.getByRole("checkbox", { name: "구분선" }).uncheck();
  expect((await rowShadows()).every((line) => line === null)).toBe(true);
  expect(new Set(await heights())).toEqual(new Set([24]));
  await page.keyboard.press("Escape");
  await scrollLadder(page, 0);
  for (const row of [1, 3, 6]) {
    expect(await hasLineOnTop(page, await boxOfCell(infoCell(row))), `끈 뒤 매수 잔량 칸 ${row}행`).toBe(false);
    expect(await hasLineOnTop(page, await boxOfCell(askCell(row))), `끈 뒤 매도 잔량 칸 ${row}행`).toBe(false);
    expect(await hasLineOnTop(page, await underRowTop(priceCell(row), row)), `끈 뒤 가격 칸 ${row}행`).toBe(false);
  }
  await scrollLadder(page, "end");
  expect(await hasLineOnTop(page, await underRowTop(priceCell(13), 13)), "끈 뒤 가격 칸 13행").toBe(false);
  expect(await hasLineOnTop(page, await boxOfCell(boxLayer)), "끈 뒤 체결 상자 위").toBe(false);
});

test("호가주문창도 매도 1호가가 현재가와 같으면 매도 10단·매수 10단이 가운데 선 양쪽에 모두 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, false, "krx", undefined, false, askAtLastSnapshot());
  const prices = ladderRows(page).locator(".mw-px-num");
  await expect(prices.nth(0)).toHaveText("70,900");
  await expect(prices.nth(9)).toHaveText("70,000");
  await expect(prices.nth(10)).toHaveText("69,900");
  await expect(prices.nth(19)).toHaveText("69,000");
  await expect(ladderRows(page).locator(".mw-qty[data-side=ask] .mw-qty-value")).toHaveCount(10);
  await expect(ladderRows(page).locator(".mw-qty[data-side=bid] .mw-qty-value")).toHaveCount(10);
  for (let row = 0; row < 10; row++) await expect(ladderRows(page).nth(row).locator(".mw-qty[data-side=ask] .mw-qty-value")).toHaveCount(1);
  for (let row = 10; row < 20; row++) await expect(ladderRows(page).nth(row).locator(".mw-qty[data-side=bid] .mw-qty-value")).toHaveCount(1);
  await expect(page.locator(".mw-lr[data-current]")).toContainText("70,000");
});

test("호가 사이 빈 가격 건너뛰기를 켜면 벌어진 호가에서도 매도 10단·매수 10단이 모두 보이고 설정이 저장되며 끄면 빈 가격 행이 돌아온다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, false, "krx", undefined, false, askAtLastSnapshot(200));
  const prices = ladderRows(page).locator(".mw-px-num");
  const bids = ladderRows(page).locator(".mw-qty[data-side=bid] .mw-qty-value");
  await expect(prices.nth(10)).toHaveText("69,900");
  await expect(bids).toHaveCount(8);
  await openSettings(page);
  const option = page.getByRole("checkbox", { name: "호가 사이 빈 가격 건너뛰기" });
  await expect(option).not.toBeChecked();
  await expect(option.locator("xpath=..")).toHaveAttribute("title", /10호가창에도 적용/);
  await option.check();
  await expect(prices.nth(9)).toHaveText("70,000");
  await expect(prices.nth(10)).toHaveText("69,700");
  await expect(prices.nth(19)).toHaveText("68,800");
  await expect(bids).toHaveCount(10);
  await expect(ladderRows(page).locator(".mw-qty[data-side=ask] .mw-qty-value")).toHaveCount(10);
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ skipSpreadGap: true });
  await option.uncheck();
  await expect(prices.nth(10)).toHaveText("69,900");
  await expect(bids).toHaveCount(8);
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ skipSpreadGap: false });
});

test("호가 사이 빈 가격 건너뛰기를 켜면 1호가가 붙어 있어도 매도·매수 단 사이의 빈 가격 행을 건너뛰고 새로고침 뒤에도 유지된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  const gappedSnapshot = {
    ...askAtLastSnapshot(),
    asks: [0, 2, 5, 6, 9, 11, 14, 15, 18, 22].map((step, i) => ({ price: 70_000 + 100 * step, quantity: 10 + i })),
    bids: [0, 2, 4, 7, 10, 12, 15, 17, 20, 25].map((step, i) => ({ price: 69_900 - 100 * step, quantity: 20 + i })),
  };
  await openOrderWindow(page, scenario, false, "krx", undefined, false, gappedSnapshot);
  const prices = ladderRows(page).locator(".mw-px-num");
  const asks = ladderRows(page).locator(".mw-qty[data-side=ask] .mw-qty-value");
  const bids = ladderRows(page).locator(".mw-qty[data-side=bid] .mw-qty-value");
  await expect(prices.nth(8)).toHaveText("70,100");
  await expect(asks).toHaveCount(5);
  await expect(bids).toHaveCount(4);

  await openSettings(page);
  await page.getByRole("checkbox", { name: "호가 사이 빈 가격 건너뛰기" }).check();
  await expect(prices.nth(9)).toHaveText("70,000");
  await expect(prices.nth(8)).toHaveText("70,200");
  await expect(prices.nth(7)).toHaveText("70,500");
  await expect(prices.nth(0)).toHaveText("72,200");
  await expect(prices.nth(10)).toHaveText("69,900");
  await expect(prices.nth(11)).toHaveText("69,700");
  await expect(prices.nth(19)).toHaveText("67,400");
  await expect(asks).toHaveCount(10);
  await expect(bids).toHaveCount(10);
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ skipSpreadGap: true });

  await page.reload();
  await expect(win(page)).toBeVisible();
  await expect(prices.nth(8)).toHaveText("70,200");
  await expect(prices.nth(11)).toHaveText("69,700");
  await expect(asks).toHaveCount(10);
  await expect(bids).toHaveCount(10);
});

test("금액 프리셋 2에 750을 입력하고 Enter를 누르면 단추가 바로 750만이 되고 새로고침해도 유지되며 틀린 값은 되돌린다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await openSettings(page);
  const preset = page.getByRole("textbox", { name: "금액 프리셋 2", exact: true });
  const buttons = page.getByRole("group", { name: "금액 프리셋" }).getByRole("button");
  await preset.fill("750");
  await expect(buttons.nth(1)).toHaveText("750만");
  await preset.press("Enter");
  await page.reload();
  await expect(win(page)).toBeVisible();
  await expect(buttons.nth(1)).toHaveText("750만");
  await openSettings(page);
  await preset.fill("0");
  await expect(buttons.nth(1)).toHaveText("750만");
  await preset.blur();
  await expect(preset).toHaveValue("750");
});

test("주문 입력은 한 줄로 사다리 위에, 총잔량 띠와 그 위 접수 합계 줄은 사다리 아래에 있다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await win(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "421px"; });
  const ladder = page.getByTestId("order-ladder");
  const ladderTop = await topOf(ladder);
  const ladderBottom = ladderTop + (await ladder.boundingBox())!.height;
  const inputLine = [page.getByRole("textbox", { name: "수량" }), ...(await page.getByRole("group", { name: "금액 프리셋" }).getByRole("button").all())];
  expect(inputLine).toHaveLength(5);
  const topsInLine = await Promise.all(inputLine.map(topOf));
  expect(new Set(topsInLine.map(Math.round)).size).toBe(1);
  expect(Math.round(await topOf(page.getByTestId("order-settings-button")))).toBeLessThan(Math.round(topsInLine[0]!));
  const firstRow = ladderRows(page).first();
  await expect(page.getByTestId("order-status")).toHaveCount(0);
  await expect(win(page)).not.toContainText("호가 칸을 더블클릭해 주문합니다");
  const quantityBottom = await page.getByRole("textbox", { name: "수량" }).evaluate((element) => element.getBoundingClientRect().bottom);
  const columnHead = (await page.getByTestId("order-colhead").boundingBox())!;
  expect(columnHead.y - quantityBottom).toBeLessThan(16);
  expect((await topOf(firstRow)) - (columnHead.y + columnHead.height)).toBeLessThan(8);
  expect(await topOf(page.getByTestId("order-total-ask"))).toBeGreaterThanOrEqual(ladderBottom);
  expect(await topOf(page.getByTestId("order-total-sell"))).toBeGreaterThanOrEqual(ladderBottom);
  expect(await topOf(page.getByTestId("order-total-sell"))).toBeLessThan(await topOf(page.getByTestId("order-total-ask")));
  await expect(page.getByTestId("order-tape")).toHaveCount(0);
  await expect(page.getByTestId("order-quote")).toHaveCount(0);
});

test("기본 프리셋은 같은 줄에 100만·500만·1000만·5000만이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await win(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "421px"; });
  const presets = page.getByRole("group", { name: "금액 프리셋" }).getByRole("button");
  await expect(presets).toHaveText(["100만", "500만", "1,000만", "5,000만"]);
  const input = Math.round(await topOf(page.getByRole("textbox", { name: "수량" })));
  expect((await tops(presets)).map(Math.round)).toEqual([input, input, input, input]);
});

test("금액 프리셋 4개는 모두 5,000만이 들어가는 최소 48px이고 더 긴 값도 잘리지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await win(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "421px"; });
  const row = page.getByTestId("order-quantity-row");
  const presets = row.getByRole("group", { name: "금액 프리셋" }).getByRole("button");
  const sizes = () => presets.evaluateAll((buttons) => buttons.map((button) => { const box = button.getBoundingClientRect(); return { width: Math.round(box.width * 2) / 2, height: Math.round(box.height), cut: button.scrollWidth > button.clientWidth }; }));
  await page.evaluate(() => document.fonts.ready);
  const initial = await sizes();
  for (const item of initial) {
    expect(item.width).toBeGreaterThanOrEqual(48);
    expect(item.height).toBe(24);
    expect(item.cut).toBe(false);
  }
  await openSettings(page);
  await page.getByRole("textbox", { name: "금액 프리셋 4" }).fill("99999");
  await page.keyboard.press("Escape");
  await expect(presets.last()).toHaveText("99,999만");
  const widened = await sizes();
  expect(widened[3]!.width).toBeGreaterThan(widened[0]!.width);
  expect(widened[3]!.cut).toBe(false);
});

const quantityField = (page: Page) => page.getByRole("textbox", { name: "수량" });
const amountPresetButtons = (page: Page) => page.getByRole("group", { name: "금액 프리셋" }).getByRole("button");

test("수량 칸 가운데에 숫자 아닌 글자를 쳐도 커서가 제자리에 있고 싼 종목의 큰 수량도 칸 안에 다 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, 1_000);
  const field = quantityField(page);
  await field.fill("1234");
  await field.evaluate((element: HTMLInputElement) => element.setSelectionRange(2, 2));
  await page.keyboard.type("a");
  await page.keyboard.type("5");
  await expect(field).toHaveValue("12534");
  await field.fill("1234");
  await field.evaluate((element: HTMLInputElement) => element.setSelectionRange(1, 3));
  await page.keyboard.type("a");
  await expect(field).toHaveValue("14");
  expect(await field.evaluate((element: HTMLInputElement) => element.selectionStart)).toBe(1);
  await amountPresetButtons(page).last().click();
  await expect(field).toHaveValue("50000");
  expect(await field.evaluate((element: HTMLInputElement) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("폭 420px에서 6·7자리 수량이 잘리지 않고 창이 넓으면 수량 칸이 84px까지 넓어진다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const field = quantityField(page);
  await win(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "420px"; });
  const width = (await field.boundingBox())!.width;
  expect(width).toBeGreaterThanOrEqual(60);
  expect(width).toBeLessThanOrEqual(84);
  for (const digits of ["100000", "1000000"]) {
    await field.fill(digits);
    await expect(field).toHaveValue(digits);
    expect(await field.evaluate((element: HTMLInputElement) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await win(page).evaluate((element) => { element.style.width = "340px"; });
  await expect.poll(async () => (await field.boundingBox())!.width).toBeLessThan(84);
  expect((await field.boundingBox())!.width).toBeGreaterThanOrEqual(60);
  await win(page).evaluate((element) => { element.style.width = "600px"; });
  await expect.poll(async () => Math.round((await field.boundingBox())!.width)).toBe(84);
});

test("수량 칸을 클릭하면 기존 값이 모두 선택되어 바로 덮어쓸 수 있다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const field = quantityField(page);
  await expect(field).toHaveValue("10");

  await field.click();
  expect(await field.evaluate((element: HTMLInputElement) => ({ start: element.selectionStart, end: element.selectionEnd }))).toEqual({ start: 0, end: 2 });
  await page.keyboard.type("250");
  await expect(field).toHaveValue("250");

  await field.click();
  expect(await field.evaluate((element: HTMLInputElement) => ({ start: element.selectionStart, end: element.selectionEnd }))).toEqual({ start: 0, end: 3 });
  await page.keyboard.type("75");
  await expect(field).toHaveValue("75");
});

test("상세 정보 카드가 사다리 1~10행 자리에 있고 시세 쪽에 시가·고가·저가·기준가·거래량·거래대금 값이 맞다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const info = page.getByTestId("ladder-info");
  await expect(info).toHaveCount(6);
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
  await expect(infoValues(page)).toHaveText(["69,900", "70,400", "69,400", "70,000", "123만", "864억"]);
  const rowTops = await tops(ladderRows(page));
  expect(await tops(info)).toEqual([0, 1, 2, 3, 4, 5].map((row) => rowTops[row]));
  const card = (await infoCard(page).boundingBox())!;
  const price = (await ladderRows(page).first().locator(".mw-px").boundingBox())!;
  expect(card.y).toBeCloseTo(rowTops[0]!, 0);
  expect(card.height).toBe(10 * 24);
  expect(card.x).toBeGreaterThanOrEqual(price.x + price.width - 1);
});

test("쪽을 넘겨도 정보란 높이와 점 좌표가 같아 같은 자리를 눌러 왕복한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
  await expect(infoTab(page, "시세")).toHaveAttribute("title", "시세");
  await expect(infoTab(page, "종목")).toHaveAttribute("title", "종목");
  const beforeHeight = (await infoCard(page).boundingBox())!.height;
  const quoteDot = await center(infoTab(page, "시세"));
  const stockDot = await center(infoTab(page, "종목"));
  await page.mouse.click(stockDot.x, stockDot.y);
  await expect(infoTab(page, "종목")).toHaveAttribute("aria-selected", "true");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_2);
  expect((await infoCard(page).boundingBox())!.height).toBe(beforeHeight);
  expect(await center(infoTab(page, "시세"))).toEqual(quoteDot);
  expect(await center(infoTab(page, "종목"))).toEqual(stockDot);
  await page.mouse.click(quoteDot.x, quoteDot.y);
  await expect(infoTab(page, "시세")).toHaveAttribute("aria-selected", "true");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
});

test("탭은 초점이 가면 화살표·Enter·Space로 바뀐다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await infoTab(page, "시세").focus();
  await page.keyboard.press("ArrowRight");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_2);
  await expect(infoTab(page, "종목")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
  await infoTab(page, "종목").focus();
  await page.keyboard.press("Enter");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_2);
  await infoTab(page, "시세").focus();
  await page.keyboard.press("Space");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
});

test("호가주문창에서 카드를 더블클릭해도 주문 요청이 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const info = page.getByTestId("ladder-info");
  await info.first().dblclick();
  await info.last().dblclick();
  await infoCard(page).dblclick({ position: { x: 3, y: 3 } });
  await infoTab(page, "시세").dblclick();
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
  await expect(page.getByTestId("order-ladder")).not.toHaveAttribute("data-dragging", "");
  expect(scenario.requests.filter((request) => request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/trading/"))).toEqual([]);
  expect(writesTo(api, "place")).toHaveLength(0);
});

test("체결강도는 11행, 체결은 12행부터 같은 top에 있고 새 체결이 맨 위이며 왼쪽 테두리와 대량 글자·막대가 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const before = await tops(ladderRows(page));
  lastTrade(scenario, 70_000, 1, 3);
  lastTrade(scenario, 70_100, 2, 1_200_000);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(2);
  await expect(page.getByTestId("ladder-strength")).toContainText("101.50%");
  const rowTops = await tops(ladderRows(page));
  expect(rowTops).toEqual(before);
  expect(await tops(page.getByTestId("ladder-strength"))).toEqual([rowTops[10]]);
  expect(await tops(page.getByTestId("ladder-trade"))).toEqual(rowTops.slice(11, 13));
  await expect(page.getByTestId("ladder-trade").first()).toHaveAttribute("data-price", "70100");
  const tradeParts = await page.getByTestId("ladder-trade").evaluateAll((rows) => rows.map((row) => ({ count: row.children.length, text: row.textContent ?? "", border: getComputedStyle(row).borderLeftWidth, priceRight: row.children[0]!.getBoundingClientRect().right, qtyLeft: row.children[1]!.getBoundingClientRect().left })));
  for (const part of tradeParts) {
    expect(part.count).toBe(2);
    expect(part.border).toBe("0px");
    expect(part.text).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(part.priceRight).toBeLessThanOrEqual(part.qtyLeft);
  }
  const columns = await page.getByTestId("ladder-trade").evaluateAll((rows) => rows.map((row) => [row.children[0]!.getBoundingClientRect().left, row.children[1]!.getBoundingClientRect().right].map((x) => Math.round(x * 10) / 10)));
  expect(columns[0]).toEqual(columns[1]);
  lastTrade(scenario, 70_200, 3, 3);
  await expect(page.getByTestId("ladder-trade").first()).toHaveAttribute("data-price", "70200");
  await expect(win(page)).not.toContainText("대량");
  await expect(page.locator(".mw-trade i")).toHaveCount(0);
});

type TradePart = { gapToScrollbar: number; price: string | null; shown: string | null; fontSize: string; qtyScrollWidth: number; qtyClientWidth: number; qtyLeft: number; qtyRight: number; boxLeft: number; boxRight: number; priceLeft: number; priceRight: number; qtyZ: string; priceZ: string; qtyBackground: string; topAtOverlap: string | null };

const readTradeParts = (page: Page): Promise<TradePart[]> => page.getByTestId("ladder-trade").evaluateAll((rows) => rows.map((row) => {
  const [price, qty] = [row.children[0]!, row.children[1]!];
  const box = row.parentElement!.getBoundingClientRect();
  const [priceRect, qtyRect] = [price.getBoundingClientRect(), qty.getBoundingClientRect()];
  const priceText = document.createRange();
  priceText.selectNodeContents(price.firstChild!);
  const priceRight = priceText.getBoundingClientRect().right;
  const overlaps = priceRight > qtyRect.left;
  const point = [qtyRect.left + 1, qtyRect.top + qtyRect.height / 2] as const;
  const stack = overlaps ? document.elementsFromPoint(point[0], point[1]) : [];
  const topAtOverlap = !overlaps ? null : !stack.includes(row) ? "offscreen" : stack[0] === qty ? "qty" : "other";
  return { gapToScrollbar: box.left + row.parentElement!.clientWidth - qtyRect.right, price: price.textContent, shown: qty.textContent, fontSize: getComputedStyle(qty).fontSize, qtyScrollWidth: qty.scrollWidth, qtyClientWidth: qty.clientWidth, qtyLeft: qtyRect.left, qtyRight: qtyRect.right, boxLeft: box.left, boxRight: box.right, priceLeft: priceRect.left, priceRight, qtyZ: getComputedStyle(qty).zIndex, priceZ: getComputedStyle(price).zIndex, qtyBackground: getComputedStyle(qty).backgroundColor, topAtOverlap };
}));

const OVERLAP_TRADES: [number, number][] = [[70_000, 7], [70_100, 600], [70_200, 9_999], [70_300, 12_345], [70_400, 999_999], [70_500, 9_999_999]];

test("470px 호가주문창에서 수량은 쉼표 숫자 그대로 끝까지 상자 안에 보이고 겹친 가격 위에 불투명 배경으로 놓이며 열이 정렬된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await win(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "470px"; });
  OVERLAP_TRADES.forEach(([price, qty], index) => lastTrade(scenario, price, index + 1, qty));
  await expect(page.getByTestId("ladder-trade")).toHaveCount(OVERLAP_TRADES.length);
  const parts = await readTradeParts(page);
  expect(parts.map((part) => part.shown)).toEqual(["9,999,999", "999,999", "12,345", "9,999", "600", "7"]);
  for (const part of parts) {
    const note = JSON.stringify(part);
    expect(part.fontSize).toBe("11px");
    expect(part.qtyScrollWidth, note).toBeLessThanOrEqual(part.qtyClientWidth);
    expect(part.qtyLeft, note).toBeGreaterThanOrEqual(part.boxLeft);
    expect(part.qtyRight, note).toBeLessThanOrEqual(part.boxRight);
    expect(part.gapToScrollbar, note).toBeGreaterThanOrEqual(5.99);
    expect(Number(part.qtyZ), note).toBeGreaterThan(Number(part.priceZ === "auto" ? 0 : part.priceZ));
    expect(part.qtyBackground, note).toBe("rgb(11, 11, 11)");
    if (part.topAtOverlap !== null && part.topAtOverlap !== "offscreen") expect(part.topAtOverlap, note).toBe("qty");
  }
  expect(parts.filter((part) => part.topAtOverlap === "qty").length).toBeGreaterThan(0);
  expect(new Set(parts.map((part) => Math.round(part.priceLeft * 10))).size).toBe(1);
  expect(new Set(parts.map((part) => Math.round(part.qtyRight * 10))).size).toBe(1);
  if (process.env.VALLY_E2E_SCREENSHOTS === "1") await page.screenshot({ path: "../target/ux-screens/order-470.png" });
});

test("421px 호가주문창에서는 체결 상자가 가격을 빼고 수량만 상자 안에 쉼표 숫자 그대로 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await win(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "421px"; });
  OVERLAP_TRADES.forEach(([price, qty], index) => lastTrade(scenario, price, index + 1, qty));
  await expect(page.getByTestId("ladder-trade")).toHaveCount(OVERLAP_TRADES.length);
  await expect(page.locator(".mw-trade-price").first()).toBeHidden();
  const parts = await readTradeParts(page);
  expect(parts.map((part) => part.shown)).toEqual(["9,999,999", "999,999", "12,345", "9,999", "600", "7"]);
  for (const part of parts) {
    const note = JSON.stringify(part);
    expect(part.fontSize).toBe("11px");
    expect(part.qtyScrollWidth, note).toBeLessThanOrEqual(part.qtyClientWidth);
    expect(part.qtyLeft, note).toBeGreaterThanOrEqual(part.boxLeft);
    expect(part.qtyRight, note).toBeLessThanOrEqual(part.boxRight);
    expect(part.gapToScrollbar, note).toBeGreaterThanOrEqual(5.99);
  }
  expect(new Set(parts.map((part) => Math.round(part.qtyRight * 10))).size).toBe(1);
});

test("호가주문창 체결이 8건보다 많아 스크롤바가 보일 때 체결량 오른쪽 끝과 스크롤바 왼쪽 사이가 6px 이상이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  for (let i = 0; i < 14; i++) lastTrade(scenario, 70_000 + i, i + 1, 1_000 + i);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(14);
  const gaps = await page.getByTestId("ladder-trade").evaluateAll((rows) => rows.map((row) => {
    const scroller = row.parentElement!;
    return scroller.getBoundingClientRect().left + scroller.clientWidth - row.children[1]!.getBoundingClientRect().right;
  }));
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(5.99);
});

test("호가주문창 체결 가격 왼쪽 끝과 같은 행 매도 주문 칸 오른쪽 끝 사이가 6px 이상이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  lastTrade(scenario, 70_000, 1, 3);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(1);
  const gap = await page.evaluate(() => {
    const price = document.querySelector("[data-testid=ladder-trade]")!.children[0]!.getBoundingClientRect();
    const cells = [...document.querySelectorAll("[data-order-cell][data-side=sell]")].map((cell) => cell.getBoundingClientRect()).filter((rect) => rect.top < price.bottom && rect.bottom > price.top);
    return price.left - Math.max(...cells.map((rect) => rect.right));
  });
  expect(gap).toBeGreaterThanOrEqual(5.99);
});

test("체결 상자 아래 10행에서도 매도 주문 칸 더블클릭은 주문을 보낸다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await win(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "421px"; });
  lastTrade(scenario, 70_000, 1, 3);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(1);
  const lowest = ladderRows(page).nth(19).locator('[data-order-cell][data-side="sell"]');
  const lowestPrice = Number(await lowest.getAttribute("data-price"));
  await lowest.dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ code: CODE, side: "sell", price: lowestPrice });
});

test("호가주문창이 넓으면 가격과 수량이 겹치지 않고 둘 다 쉼표 숫자 전체로 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await win(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "900px"; });
  lastTrade(scenario, 70_000, 1, 999_999);
  lastTrade(scenario, 70_100, 2, 12_345);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(2);
  const parts = await readTradeParts(page);
  expect(parts.map((part) => part.shown)).toEqual(["12,345", "999,999"]);
  for (const part of parts) {
    expect(part.priceRight).toBeLessThan(part.qtyLeft);
    expect(part.topAtOverlap).toBeNull();
  }
});

test("창을 열면 지난 체결을 pages=1로 받아 보이고 종목을 바꾸면 새 종목으로 같은 요청을 한 번 하고 그 체결을 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, true);
  const tradeRequests = (code: string) => scenario.requests.map((r) => new URL(r.url())).filter((url) => url.pathname === `/api/symbols/${code}/trades`);
  expect(tradeRequests(CODE).map((url) => url.searchParams.get("pages"))).toEqual(["1"]);
  scenario.on((url) => url.pathname === "/api/symbols/000660/trades", () => ({ body: { symbol: "000660", venue: "krx", trades: [{ time: "09:31:02", price: 110_000, quantity: 5, exchange: "krx" }, { time: "09:31:01", price: 109_900, quantity: -2, exchange: "krx" }], skippedRows: 0 } }));
  await cell(page, 2).click();
  await expect(win(page)).toHaveAttribute("data-symbol", "000660");
  await expect(page.getByTestId("ladder-trade")).toHaveCount(2);
  await expect(page.getByTestId("ladder-trade").first()).toHaveAttribute("data-price", "110000");
  expect(tradeRequests("000660").map((url) => url.searchParams.get("pages"))).toEqual(["1"]);
});

const SINGLE_PRICE_ASKS = [{ price: 69_600, qty: 50 }, { price: 69_700, qty: 40 }, { price: 69_800, qty: 30 }];
const SINGLE_PRICE_BIDS = [{ price: 69_500, qty: 80 }, { price: 69_400, qty: 60 }, { price: 69_300, qty: 40 }];

async function emitSingleBook(scenario: Scenario, asks: typeof SINGLE_PRICE_ASKS, bids: typeof SINGLE_PRICE_BIDS): Promise<void> {
  let sub = "";
  await pollSaved(() => {
    const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
    sub = message?.type === "subscribe_feed" ? message.sub : "";
    return sub;
  }).not.toBe("");
  scenario.live.emit({ type: "feed_book", sub, book: { t: 1, asks, bids, totalAskQty: 0, totalBidQty: 0, expected: null } });
}

test("단일가 호가에서 호가주문창은 6호가만 가운데 선 위·아래에 그리고 가격 있는 행의 주문 칸만 더블클릭 주문이 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await emitSingleBook(scenario, SINGLE_PRICE_ASKS, SINGLE_PRICE_BIDS);
  await expect(ladderRows(page).locator(".mw-px-num")).toHaveCount(6);
  await expect(ladderRows(page).nth(7).locator(".mw-px-num")).toHaveText("69,800");
  await expect(ladderRows(page).nth(9).locator(".mw-px-num")).toHaveText("69,600");
  await expect(ladderRows(page).nth(10).locator(".mw-px-num")).toHaveText("69,500");
  await expect(ladderRows(page).nth(12).locator(".mw-px-num")).toHaveText("69,300");
  await expect(page.getByTestId("ladder-info")).toHaveCount(6);

  await ladderRows(page).nth(0).locator("[data-empty]").first().dblclick();
  await ladderRows(page).nth(19).locator("[data-empty]").first().dblclick();
  await cellAt(page, "buy", 69_500).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ code: CODE, side: "buy", price: 69_500 });
});

test("단일가 호가에서 칩을 끄는 도중 단 가격이 바뀌어도 놓은 행의 정정 가격은 끌기 시작 때 그 행의 가격이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 69_500, 5)]);
  await openOrderWindow(page, scenario);
  await emitSingleBook(scenario, SINGLE_PRICE_ASKS, SINGLE_PRICE_BIDS);
  await expect(ladderRows(page).nth(10).locator(".mw-px-num")).toHaveText("69,500");
  await expect(chipAt(page, "buy", 69_500)).toBeVisible();
  await dragChip(page, chipAt(page, "buy", 69_500), await center(cellAt(page, "buy", 69_400)), false);
  await expect(page.getByTestId("order-ghost")).toContainText("→ 69,400원");
  await emitSingleBook(scenario, SINGLE_PRICE_ASKS.map((l) => ({ ...l, price: l.price + 100 })), [{ price: 69_600, qty: 11 }, { price: 69_500, qty: 777 }, { price: 69_400, qty: 22 }]);
  await expect(ladderRows(page).nth(10).locator(".mw-qty[data-side=bid] .mw-qty-value")).toHaveText("777");
  await expect(ladderRows(page).nth(10).locator(".mw-px-num")).toHaveText("69,500");
  await expect(ladderRows(page).nth(11).locator(".mw-px-num")).toHaveText("69,400");
  await page.mouse.up();
  await pollSaved(() => writesTo(api, "modify")).toHaveLength(1);
  expect(writesTo(api, "modify")[0]!.body).toMatchObject({ orderNo: "0000001", price: 69_400 });
});

test("교차 단일가 호가에서 같은 가격이 두 행에 있어도 주문 하나는 칩 하나이고 두 행 모두 그 가격으로 주문 칸이 열린다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "sell", 70_000, 5)]);
  await openOrderWindow(page, scenario);
  await emitSingleBook(scenario, [{ price: 70_000, qty: 5 }, { price: 70_100, qty: 6 }, { price: 70_200, qty: 7 }], [{ price: 70_100, qty: 8 }, { price: 70_000, qty: 9 }, { price: 69_900, qty: 10 }]);
  await expect(ladderRows(page).locator(".mw-px-num")).toHaveCount(6);
  await expect(page.getByTestId("order-chip")).toHaveCount(1);
  await expect(page.getByTestId("order-chip")).toHaveAttribute("data-price", "70000");
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  await cellAt(page, "buy", 70_100).last().dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ side: "buy", price: 70_100 });
});

test("교차 호가에서도 매수 잔량은 아래 열 줄에 놓여 정보란에 가려지지 않고 같은 가격 올림 미리보기는 한 줄에만 뜬다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const beforeHeight = (await infoCard(page).boundingBox())!.height;
  let sub = "";
  await pollSaved(() => {
    const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
    sub = message?.type === "subscribe_feed" ? message.sub : "";
    return sub;
  }).not.toBe("");
  scenario.live.emit({ type: "feed_book", sub, book: { t: 1, asks: [{ price: 70_100, qty: 50 }, { price: 70_200, qty: 40 }, { price: 70_300, qty: 30 }, { price: 70_400, qty: 20 }], bids: [{ price: 70_700, qty: 33 }, { price: 70_000, qty: 80 }], totalAskQty: 140, totalBidQty: 113, expected: null } });
  const bestBidRow = ladderRows(page).nth(10);
  await expect(bestBidRow.locator(".mw-px-num")).toHaveText("70,700");
  await expect(bestBidRow.locator(".mw-qty[data-side=bid] .mw-qty-value")).toHaveText("33");
  const rowTop = (await bestBidRow.boundingBox())!.y;
  const card = (await infoCard(page).boundingBox())!;
  expect(card.y + card.height).toBeLessThanOrEqual(rowTop + 0.5);
  expect(card.height).toBe(beforeHeight);
  await bestBidRow.locator('[data-order-cell][data-side="buy"]').hover();
  await expect(page.getByTestId("order-preview")).toHaveCount(1);
});

test.describe("수요일 08:55 동시호가", () => {
  test.use({ clockStart: "20261118085500" });

  test.beforeEach(async ({ page, scenario }) => {
    await page.clock.setFixedTime(new Date(scenario.now));
  });

  test("호가주문창 상세 정보 카드에 예상체결 두 항목이 보이고 70,000원 행이 강조된다", async ({ page, scenario }) => {
    ordersOn(scenario);
    tradingApi(scenario);
    await openOrderWindow(page, scenario);
    let sub = "";
    await pollSaved(() => {
      const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
      sub = message?.type === "subscribe_feed" ? message.sub : "";
      return sub;
    }).not.toBe("");
    scenario.live.emit({ type: "feed_book", sub, book: { t: scenario.now / 1000, asks: [{ price: 70_100, qty: 50 }, { price: 70_200, qty: 40 }, { price: 70_300, qty: 30 }, { price: 70_400, qty: 20 }], bids: [{ price: 70_000, qty: 80 }], totalAskQty: 140, totalBidQty: 80, expected: { price: 70_000, qty: 300 } } });
    const info = page.getByTestId("ladder-info");
    await expect(info.and(page.locator('[data-label="예상체결가"]')).locator("b")).toHaveText("70,000");
    await expect(info.and(page.locator('[data-label="예상체결량"]')).locator("b")).toHaveText("300");
    await expect(ladderRows(page).locator(".mw-px-num")).toHaveCount(20);
    await expect(page.locator(".mw-lr[data-expected]")).toHaveCount(1);
    await expect(page.locator(".mw-lr[data-expected]")).toContainText("70,000");
  });
});

test.describe("수요일 15:35 NXT 동시호가", () => {
  test.use({ clockStart: "20261118153500" });

  test.beforeEach(async ({ page, scenario }) => {
    await page.clock.setFixedTime(new Date(scenario.now));
  });

  test("NXT 가능 종목의 호가주문창은 통합·NXT에서 6호가와 예상체결을 표시한다", async ({ page, scenario }) => {
    nxtTraded(scenario, true);
    ordersOn(scenario);
    tradingApi(scenario);
    await openOrderWindow(page, scenario, false, "combined");
    let sub = "";
    await pollSaved(() => {
      const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE && m.venue === "combined");
      sub = message?.type === "subscribe_feed" ? message.sub : "";
      return sub;
    }).not.toBe("");
    const asks = Array.from({ length: 10 }, (_, i) => ({ price: 70_100 + 100 * i, qty: 50 + i }));
    const bids = Array.from({ length: 10 }, (_, i) => ({ price: 70_000 - 100 * i, qty: 80 + i }));
    scenario.live.emit({ type: "feed_book", sub, book: { t: scenario.now / 1000, asks, bids, totalAskQty: 545, totalBidQty: 845, expected: { price: 70_000, qty: 320 } } });
    const info = page.getByTestId("ladder-info");
    await expect(ladderRows(page).locator(".mw-px-num")).toHaveText(["70,300", "70,200", "70,100", "70,000", "69,900", "69,800"]);
    await expect(info.and(page.locator('[data-label="예상체결가"]')).locator("b")).toHaveText("70,000");
    await expect(info.and(page.locator('[data-label="예상체결량"]')).locator("b")).toHaveText("320");
    await expect(page.locator(".mw-lr[data-expected]")).toHaveCount(1);
    await expect(page.locator(".mw-lr[data-expected]")).toContainText("70,000");
  });
});

test.describe("수요일 08:35 시간외 종가 잔량", () => {
  test.use({ clockStart: "20261118083500" });

  test.beforeEach(async ({ page, scenario }) => {
    await page.clock.setFixedTime(new Date(scenario.now));
  });

  test("호가주문창 총잔량 띠는 시간외 잔량이어도 시간외 글자 없이 숫자만 보인다", async ({ page, scenario }) => {
    ordersOn(scenario);
    tradingApi(scenario);
    await openOrderWindow(page, scenario);
    let sub = "";
    await pollSaved(() => {
      const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
      sub = message?.type === "subscribe_feed" ? message.sub : "";
      return sub;
    }).not.toBe("");
    await expect(page.getByTestId("order-total-ask")).toHaveAttribute("data-source", "regular");
    scenario.live.emit({ type: "feed_after_hours", sub, totals: { t: scenario.now / 1000, askQty: 13_770, bidQty: 0 } });
    await expect(page.getByTestId("order-total-ask")).toHaveAttribute("data-source", "after-hours");
    await expect(page.getByTestId("order-total-ask")).toHaveText("13,770");
    await expect(page.getByTestId("order-total-bid")).toHaveAttribute("data-source", "after-hours");
    await expect(page.getByTestId("order-total-bid")).toHaveText("0");
    await expect(page.getByTestId("order-total-ask").locator("..")).not.toContainText("시간외");
  });
});

const OTHER = "000660";
const OTHER_HOLDING: TradingHolding = { ...HOLDING, code: OTHER, name: "SK하이닉스" };
const OTHER_FILL: TradingExecution = { ...FILL, orderNo: "0000011", code: OTHER, name: "SK하이닉스", time: "101500" };

const chartWindow = (id: string, link: LinkColor | null, symbol: string): LayoutWindow => ({ id, link, kind: "chart", symbol, venue: "combined", period: "D", chartSettings: SETTINGS });
const savedSymbols = (scenario: Scenario) => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.flatMap((w) => (w.kind === "chart" ? [[w.id, w.symbol]] : []));

function linkedArrangement(orderLink: LinkColor | null, orderSymbol?: string): (windows: LayoutWindow[]) => LayoutWindow[] {
  return (windows) => [
    chartWindow("cell-0", "a", CODE),
    chartWindow("cell-1", "a", CODE),
    chartWindow("cell-2", "b", "035420"),
    ...windows.filter((w) => w.kind !== "chart" && w.kind !== "order"),
    { id: "book", link: orderLink, kind: "book" },
    { id: "order", link: orderLink, kind: "order", venue: "krx", ...(orderSymbol ? { symbol: orderSymbol } : {}) },
  ];
}

test("보유종목 이름을 누르면 같은 연동 색의 차트와 따르는 창이 모두 그 종목으로 바뀐다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.holdings = [HOLDING, OTHER_HOLDING];
  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, linkedArrangement("a"));
  await page.getByTestId("account-tab-holdings").click();
  await page.getByRole("button", { name: "SK하이닉스로 이동" }).click();
  await expect(page.getByTestId("account-panel")).toHaveCount(0);
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await pollSaved(() => savedSymbols(scenario)).toEqual([["cell-0", OTHER], ["cell-1", OTHER], ["cell-2", "035420"]]);
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  await expect(page.getByTestId("book-window")).toHaveAttribute("data-symbol", OTHER);
  await expect(page.getByRole("status").filter({ hasText: "SK하이닉스" })).toHaveCount(0);
});

test("내 체결과 미체결의 종목명도 같은 방식으로 이동한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [{ ...openOrder("0000002", "sell", 71_000, 7), code: OTHER, name: "SK하이닉스" }]);
  api.executions = [OTHER_FILL];
  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, linkedArrangement("a"));
  await page.getByTestId("account-tab-fills").click();
  await page.getByRole("button", { name: "SK하이닉스로 이동" }).click();
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await pollSaved(() => savedSymbols(scenario)).toEqual([["cell-0", OTHER], ["cell-1", OTHER], ["cell-2", "035420"]]);

  await page.getByTestId("account-tab-open").click();
  await page.getByRole("button", { name: "취소" }).waitFor();
  await page.getByRole("button", { name: "SK하이닉스로 이동" }).click();
  await expect(page.getByTestId("account-panel")).toHaveCount(0);
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await expect(page.getByTestId("account-tab-open")).toBeVisible();
  expect(writesTo(api, "cancel")).toHaveLength(0);
});

test("연동 끔인 호가주문창에서 누르면 활성 칸 차트와 이 창이 그 종목으로 바뀐다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.holdings = [HOLDING, OTHER_HOLDING];
  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, (windows) => [
    chartWindow("cell-0", null, CODE),
    chartWindow("cell-1", null, "035420"),
    ...windows.filter((w) => w.kind !== "chart"),
  ]);
  await page.getByTestId("account-tab-holdings").click();
  await page.getByRole("button", { name: "SK하이닉스로 이동" }).click();
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await pollSaved(() => savedSymbols(scenario)).toEqual([["cell-0", OTHER], ["cell-1", "035420"]]);
});

test("고정 종목이 있는 호가주문창에서 누르면 고정이 풀리고 그 종목으로 바뀐다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.holdings = [HOLDING, OTHER_HOLDING];
  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, linkedArrangement(null, CODE));
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
  await page.getByTestId("account-tab-holdings").click();
  await page.getByRole("button", { name: "SK하이닉스로 이동" }).click();
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await pollSaved(() => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.find((w) => w.id === "order")).not.toHaveProperty("symbol");
});

test("종목명은 키보드로 누를 수 있고 이름이 \"…로 이동\"이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.holdings = [HOLDING, OTHER_HOLDING];
  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, linkedArrangement("a"));
  await page.getByTestId("account-tab-holdings").click();
  const name = page.getByRole("button", { name: "SK하이닉스로 이동" });
  await expect(page.getByRole("button", { name: "삼성전자로 이동" })).toBeVisible();
  await name.focus();
  await expect(name).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await page.getByTestId("account-tab-holdings").click();
  await page.getByRole("button", { name: "삼성전자로 이동" }).focus();
  await page.keyboard.press("Space");
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
});

const orderTab = (page: Page, id: string) => page.locator(`[role=tab][data-window-id="${id}"]`);
const keptEntries = (scenario: Scenario) => scenario.documents.uiState()["orderEntries"];
const entryKeyOf = (windowId: string, code = CODE) => `${DEFAULT_LAYOUT_ID}|${windowId}|${code}`;

async function expectStart(page: Page, quantity: string) {
  await expect(quantityField(page)).toHaveValue(quantity);
}

async function placeKept(page: Page, api: ReturnType<typeof tradingApi>, quantity: string, count: number) {
  await quantityField(page).fill(quantity);
  await cellAt(page, "buy", BASE).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(count);
}

test("수량 줄에 수량·유지 라벨과 수량 방식 선택이 없고 마지막 주문 수량 유지 설정은 그대로 켜고 끈다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const row = page.getByTestId("order-quantity-row");
  await expect(row.getByRole("textbox", { name: "수량", exact: true })).toBeVisible();
  await expect(row.locator("label")).toHaveCount(0);
  await expect(row.getByRole("group", { name: "수량 방식" })).toHaveCount(0);
  await expect(row).not.toContainText("유지");
  await openSettings(page);
  const keep = page.getByRole("checkbox", { name: /마지막 주문 수량 유지/ });
  await expect(keep).toBeChecked();
  await expect(page.getByTestId("order-settings")).not.toContainText("창·종목마다 따로 기억합니다");
  await expect(page.getByTestId("order-settings")).not.toContainText("매수·매도 접수, 체결 시 소리");
  const order = await page.getByTestId("order-settings").locator("input").evaluateAll((inputs) => inputs.map((input) => input.closest("label")?.textContent ?? input.getAttribute("aria-label")));
  expect(order.slice(0, 5)).toEqual(["금액 프리셋 1", "금액 프리셋 2", "금액 프리셋 3", "금액 프리셋 4", expect.stringContaining("마지막 주문 수량 유지")]);
  await keep.uncheck();
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ keepLastEntry: false });
});

test("유지가 켜져 있으면 A 종목에서 수량 37로 주문하고 B 종목으로 바꾸면 B는 10으로 시작하고, A로 돌아오거나 새로 고치면 37이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario, true);
  await expectStart(page, "10");
  await placeKept(page, api, "37", 1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ quantity: 37 });
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order")]: { quantity: 37 } });
  await cell(page, 2).click();
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await expectStart(page, "10");
  await cell(page, 1).click();
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
  await expectStart(page, "37");
  await page.reload();
  await expect(win(page)).toBeVisible();
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
  await expectStart(page, "37");
});

test("호가주문창 둘에서 같은 종목: 1번 창에서 37로 주문해도 2번 창은 10으로 시작한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await orderTab(page, "order").click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "복제" }).click();
  await expect(orderTab(page, "order-2")).toHaveAttribute("aria-selected", "true");
  await pollSaved(() => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.some((w) => w.id === "order-2")).toBe(true);
  await orderTab(page, "order").click();
  await expect(win(page)).toBeVisible();
  await placeKept(page, api, "37", 1);
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order")]: { quantity: 37 } });
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await orderTab(page, "order-2").click();
  await expect(win(page)).toBeVisible();
  await expectStart(page, "10");
  await orderTab(page, "order").click();
  await expectStart(page, "37");
});

test("복제한 호가주문창은 원본의 기억 없이 10으로 시작한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await placeKept(page, api, "37", 1);
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order")]: { quantity: 37 } });
  await orderTab(page, "order").click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "복제" }).click();
  await expect(orderTab(page, "order-2")).toHaveAttribute("aria-selected", "true");
  await expect(win(page)).toBeVisible();
  await expectStart(page, "10");
});

test("유지가 켜져 있으면 주문 없이 금액 프리셋을 누르기만 해도 창·종목별로 유지된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario, true);
  lastTrade(scenario, BASE);
  await expectStart(page, "10");
  await amountPresetButtons(page).first().click();
  await expectStart(page, "14");
  expect(writesTo(api, "place")).toHaveLength(0);
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order")]: { quantity: 14 } });

  await cell(page, 2).click();
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await expectStart(page, "10");
  await quantityField(page).fill("50");
  await expectStart(page, "50");
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order", OTHER)]: { quantity: 50 } });

  await cell(page, 1).click();
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
  await expectStart(page, "14");

  await page.reload();
  await expect(win(page)).toBeVisible();
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
  await expectStart(page, "14");
  await cell(page, 2).click();
  await expect(win(page)).toHaveAttribute("data-symbol", OTHER);
  await expectStart(page, "50");
});

test("정정·취소는 유지 값을 바꾸지 않고 막힌 주문 뒤 줄여 보내기는 줄인 수량을 남긴다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 69_800, 5)]);
  api.orderable = { cashAmount: 700_000, cashQuantity: 10 };
  await openOrderWindow(page, scenario);
  await placeKept(page, api, "7", 1);
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order")]: { quantity: 7 } });

  await dragChip(page, chipAt(page, "buy", 69_800), await center(cellAt(page, "buy", 69_900)));
  await pollSaved(() => writesTo(api, "modify")).toHaveLength(1);
  await page.getByTestId("account-tab-open").click();
  await page.getByTestId("account-open-order").first().getByRole("button", { name: "취소" }).click();
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(keptEntries(scenario)).toEqual({ [entryKeyOf("order")]: expect.objectContaining({ quantity: 7 }) });

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("account-panel")).toHaveCount(0);
  await quantityField(page).fill("11");
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order")]: { quantity: 11 } });
  await cellAt(page, "buy", BASE).dblclick();
  await expect(status(page)).toContainText("최대 10");
  expect(writesTo(api, "place")).toHaveLength(1);

  await page.getByTestId("order-status-action").click();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(2);
  expect(writesTo(api, "place")[1]!.body).toMatchObject({ quantity: 10 });
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order")]: { quantity: 10 } });
});

const SELL_HOLDING: TradingHolding = { ...HOLDING, quantity: 120, sellableQuantity: 120 };

test("보내는 중 매도도 뺀다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "sell", 70_800, 50)]);
  api.holdings = [SELL_HOLDING];
  await openOrderWindow(page, scenario);
  const held = scenario.hold((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST");
  await quantityField(page).fill("10");
  await cellAt(page, "sell", 70_900).dblclick();
  await held.received;
  await expect(page.getByTestId("summary-remaining")).toHaveText("남은 60");
  await page.getByTestId("summary-quantity").click();
  await expect(quantityField(page)).toHaveValue("60");
  held.reply({ body: commandOf("sell", { price: 70_900, quantity: 10 }) });
});

test("모두 매도 주문 중이면 칸이 꺼지고 툴팁을 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "sell", 70_800, 120)]);
  api.holdings = [SELL_HOLDING];
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("summary-remaining")).toHaveText("남은 0");
  await expect(page.getByTestId("summary-quantity")).toBeDisabled();
  await expect(page.getByTestId("summary-quantity")).toHaveAttribute("title", "모두 매도 주문 중입니다");
});

test("설정 단추의 아이콘이 톱니바퀴이고 단추 이름은 호가주문 설정 · 주문 경로 SOR이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, false, "combined");
  const button = page.getByTestId("order-settings-button");
  await expect(button).toHaveAccessibleName("호가주문 설정 · 주문 경로 SOR");
  await expect(button.locator(".od-gear-route")).toHaveText("SOR");
  const teeth = await button.locator("svg path").evaluate((path) => (path.getAttribute("d")?.match(/L/g)?.length ?? 0) + 1);
  expect(teeth).toBe(24);
  await expect(button.locator("svg circle")).toHaveCount(1);
  await expect(button.locator("svg")).toHaveAttribute("width", "14");
});

test("접수된 매도와 같은 가격에 보내는 중인 매도도 남은 수량에서 뺀다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "sell", 70_800, 50)]);
  api.holdings = [SELL_HOLDING];
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("summary-remaining")).toHaveText("남은 70");
  const held = scenario.hold((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST");
  await quantityField(page).fill("30");
  await cellAt(page, "sell", 70_800).dblclick();
  await held.received;
  await expect(page.getByTestId("summary-remaining")).toHaveText("남은 40");
  await page.getByTestId("summary-quantity").click();
  await expect(quantityField(page)).toHaveValue("40");
  held.reply({ body: commandOf("sell", { price: 70_800, quantity: 30 }) });
});

test("응답 전에 미체결 목록에 오른 보내는 중 매도는 남은 수량에서 두 번 빼지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "sell", 70_800, 50)]);
  api.holdings = [SELL_HOLDING];
  await openOrderWindow(page, scenario);
  const held = scenario.hold((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST");
  await quantityField(page).fill("30");
  await cellAt(page, "sell", 70_800).dblclick();
  await held.received;
  await expect(page.getByTestId("summary-remaining")).toHaveText("남은 40");
  api.open = [openOrder("0000001", "sell", 70_800, 50), openOrder("0000002", "sell", 70_800, 30)];
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await expect(chipAt(page, "sell", 70_800)).toHaveText("80");
  await expect(page.getByTestId("summary-remaining")).toHaveText("남은 40");
  held.reply({ body: commandOf("sell", { price: 70_800, quantity: 30 }) });
});

const accountButton = (page: Page) => page.locator('button[data-testid="account-label"]');
const accountOptions = (page: Page) => page.getByTestId("account-option");
const accountMenu = (page: Page) => page.getByTestId("account-menu");
const bAccount = () => accountData({ open: [openOrder("B-0001", "sell", 71_000, 3)], holdings: [{ ...HOLDING, quantity: 777 }], executions: [{ ...FILL, orderNo: "B-0010", quantity: 9 }], orderable: { cashAmount: 12_000_000 } });
const savedAccount = (scenario: Scenario) => scenario.documents.uiPrefs().orderSettings.account;

async function pickAccount(page: Page, text: RegExp | string): Promise<void> {
  await accountButton(page).click();
  await accountOptions(page).filter({ hasText: text }).click();
}

test("계좌가 하나면 계좌 글자는 단추가 아니고 지금과 같다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const label = page.getByTestId("account-label");
  await expect(label).toHaveText("키움 ****-**01");
  await expect(accountButton(page)).toHaveCount(0);
  await label.click();
  await expect(accountMenu(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /키움 \*\*\*\*-\*\*01/ })).toHaveCount(0);
});

test("계좌 둘이면 계좌 단추로 목록을 열어 B를 고르면 미체결·보유·주문가능 조회와 주문이 B 참조로 나가고 다른 호가주문창도 B를 보인다; 새로 고쳐도 B다", async ({ page, scenario }) => {
  ordersOn(scenario, [otherAccount()]);
  const api = tradingApi(scenario, [openOrder("A-0001", "buy", 70_000, 5)]);
  api.accounts[SECOND_ACCOUNT] = bAccount();
  await openOrderWindow(page, scenario);
  await expect(accountButton(page)).toHaveText("키 1 · 키움 ****-**01");
  await expect(page.getByTestId("account-tab-open")).toContainText("1");

  await accountButton(page).click();
  await expect(accountOptions(page)).toHaveText(["키 1 · 키움 ****-**01시세", "위탁 2 · 키움 ****-**05"]);
  await expect(accountOptions(page).first()).toHaveAttribute("aria-checked", "true");
  await accountOptions(page).nth(1).click();
  await expect(accountMenu(page)).toHaveCount(0);
  await expect(accountButton(page)).toHaveText("위탁 2 · 키움 ****-**05");
  await expect(page.getByTestId("summary-quantity")).toContainText("777");
  await expect(page.getByTestId("account-tab-open")).toContainText("1");
  await expect(page.getByTestId("account-tab-fills")).toContainText("1");
  await expect(cellAt(page, "sell", 71_000)).toBeVisible();
  const forB = (path: string) => api.seen.filter((request) => request.path === path && request.account === SECOND_ACCOUNT);
  await pollSaved(() => ["/api/trading/open-orders", "/api/trading/balance", "/api/trading/executions", "/api/trading/orderable"].map((path) => forB(path).length > 0)).toEqual([true, true, true, true]);
  await pollSaved(() => savedAccount(scenario)).toBe(SECOND_ACCOUNT);

  await cellAt(page, "buy", 70_000).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body.account).toBe(SECOND_ACCOUNT);

  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, windows: [...layout.windows, { id: "order-2", link: null, kind: "order", venue: "krx" }], revision: layout.revision + 1 });
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  for (const name of [/^호가주문 2/, /^호가주문 1/]) {
    await windowTabs(page).getByRole("tab", { name }).click();
    await expect(accountButton(page)).toHaveText(["위탁 2 · 키움 ****-**05"]);
    await expect(page.getByTestId("summary-quantity")).toHaveText([/777/]);
  }
});

test("주문 꺼진 계좌는 목록에서 고를 수 없고 시스템 설정에서 계좌 관리 이어가기가 증권사 · 계좌 메뉴를 연다", async ({ page, scenario }) => {
  ordersOn(scenario, [otherAccount(), otherAccount({ keyId: "k3", alias: "연금계좌", state: "off", accountRef: null, accountTail: null })]);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await accountButton(page).click();
  const off = accountOptions(page).filter({ hasText: "연금계좌" });
  await expect(off).toHaveText("연금계좌 · 계좌 미확인주문 꺼짐");
  await expect(off).toHaveAttribute("aria-disabled", "true");
  await off.click({ force: true });
  await expect(accountMenu(page)).toBeVisible();
  await expect(accountButton(page)).toHaveText("키 1 · 키움 ****-**01");
  expect(savedAccount(scenario)).toBeNull();
  expect(api.seen.every((request) => request.account === ACCOUNT)).toBe(true);

  await page.getByTestId("account-manage").click();
  await expect(accountMenu(page)).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: "시스템 설정", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: /^증권사 · 계좌/ })).toHaveAttribute("aria-selected", "true");
});

test("고른 계좌가 없어지면 시세 키 계좌로 돌아가고 상태줄이 한 번 알린다", async ({ page, scenario }) => {
  ordersOn(scenario, [otherAccount()]);
  const api = tradingApi(scenario);
  api.accounts[SECOND_ACCOUNT] = bAccount();
  const first = { keyId: "k1", alias: "키 1", broker: "kiwoom" as const, source: "file" as const, appKeyTail: "1234", market: true, link: CONNECTED_KIWOOM, kisAccount: null };
  const second = { ...first, keyId: "k2", alias: "위탁 2", market: false };
  scenario.live.kiwoomKeys = { limit: 5, keys: [first, second], keyFileProblem: null };
  scenario.on((url, request) => url.pathname === "/api/system/kiwoom/keys/k2" && request.method() === "DELETE", () => {
    ordersOn(scenario);
    scenario.live.kiwoomKeys = { limit: 5, keys: [first], keyFileProblem: null };
    return { body: scenario.live.kiwoomKeys };
  });
  await openOrderWindow(page, scenario);
  await pickAccount(page, "위탁 2");
  await expect(accountButton(page)).toHaveText("위탁 2 · 키움 ****-**05");
  await pollSaved(() => savedAccount(scenario)).toBe(SECOND_ACCOUNT);

  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "시스템 설정", exact: true });
  await dialog.getByRole("button", { name: "위탁 2", exact: false }).first().click();
  await dialog.getByRole("button", { name: "지우기" }).click();
  await page.getByRole("dialog", { name: /‘위탁 2’ 키를 지웁니다/ }).getByRole("button", { name: "키 지우기" }).click();

  await expect(page.getByTestId("account-label")).toHaveText("키움 ****-**01");
  await expect(accountButton(page)).toHaveCount(0);
  await expect(status(page)).toHaveText("고른 계좌가 꺼져 시세 키 계좌로 돌아갑니다");
  await expect(page.getByTestId("summary-quantity")).not.toContainText("777");
  await pollSaved(() => savedAccount(scenario)).toBeNull();
  await expect(status(page)).toHaveCount(0);
});

test("계좌를 바꾸면 보내는 중 칩이 사라진다", async ({ page, scenario }) => {
  ordersOn(scenario, [otherAccount()]);
  const api = tradingApi(scenario);
  api.accounts[SECOND_ACCOUNT] = bAccount();
  await openOrderWindow(page, scenario);
  const place = scenario.hold((url) => url.pathname === "/api/trading/commands/place");
  await cellAt(page, "buy", BASE).dblclick();
  await place.received;
  await expect(chipAt(page, "buy", BASE)).toHaveAttribute("data-pending", "sending");
  await pickAccount(page, "위탁 2");
  await expect(accountButton(page)).toHaveText("위탁 2 · 키움 ****-**05");
  await expect(chipAt(page, "buy", BASE)).toHaveCount(0);
  place.reply({ body: commandOf("buy") });
});

test("키움·한투 계좌가 있으면 계좌 목록에 키움 ****-**12와 한투 ****-**34가 함께 보이고, 한투를 고르면 조회와 주문이 한투 참조로 나간다", async ({ page, scenario }) => {
  ordersOn(scenario, [kisAccount()], "12");
  const api = tradingApi(scenario, [openOrder("A-0001", "buy", 70_000, 5)]);
  api.accounts[KIS_ACCOUNT] = bAccount();
  await openOrderWindow(page, scenario);
  await expect(accountButton(page)).toHaveText("키 1 · 키움 ****-**12");

  await accountButton(page).click();
  await expect(accountOptions(page)).toHaveText(["키 1 · 키움 ****-**12시세", "한투 1 · 한투 ****-**34"]);
  await accountOptions(page).nth(1).click();
  await expect(accountButton(page)).toHaveText("한투 1 · 한투 ****-**34");
  await expect(page.getByTestId("summary-quantity")).toContainText("777");
  const forKis = (path: string) => api.seen.filter((request) => request.path === path && request.account === KIS_ACCOUNT);
  await pollSaved(() => ["/api/trading/open-orders", "/api/trading/balance", "/api/trading/executions", "/api/trading/orderable"].map((path) => forKis(path).length > 0)).toEqual([true, true, true, true]);
  await pollSaved(() => savedAccount(scenario)).toBe(KIS_ACCOUNT);

  await cellAt(page, "buy", 70_000).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body.account).toBe(KIS_ACCOUNT);
});

test("한투 계좌를 고르면 주문 경로 고르기에 KRX·NXT·SOR가 모두 있고, NXT를 고른 주문이 NXT 경로로 나간다", async ({ page, scenario }) => {
  ordersOn(scenario, [kisAccount()]);
  const api = tradingApi(scenario);
  api.accounts[KIS_ACCOUNT] = bAccount();
  nxtTraded(scenario, true);
  await openOrderWindow(page, scenario);
  await pickAccount(page, "한투 1");
  await expect(accountButton(page)).toHaveText("한투 1 · 한투 ****-**34");
  await page.getByTestId("order-settings-button").click();
  const routes = page.getByTestId("order-settings").getByRole("group", { name: "주문 경로" });
  for (const route of ["KRX", "NXT", "SOR"]) await expect(routes.getByRole("button", { name: route })).toBeEnabled();
  await routes.getByRole("button", { name: "NXT" }).click();
  await page.keyboard.press("Escape");
  await cellAt(page, "buy", 70_000).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ venue: "nxt", account: KIS_ACCOUNT });
});

test("보내는 중에 미체결을 다시 읽어도 같은 가격 보내는 중 매도가 남은 수량에서 빠진다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "sell", 70_800, 50)]);
  api.holdings = [SELL_HOLDING];
  await openOrderWindow(page, scenario);
  const held = scenario.hold((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST");
  await quantityField(page).fill("30");
  await cellAt(page, "sell", 70_800).dblclick();
  await held.received;
  await expect(page.getByTestId("summary-remaining")).toHaveText("남은 40");
  api.open = [openOrder("0000001", "sell", 70_800, 50), openOrder("0000003", "buy", 69_800, 7)];
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await expect(chipAt(page, "buy", 69_800)).toHaveText("7");
  await expect(page.getByTestId("summary-remaining")).toHaveText("남은 40");
  held.reply({ body: commandOf("sell", { price: 70_800, quantity: 30 }) });
});
