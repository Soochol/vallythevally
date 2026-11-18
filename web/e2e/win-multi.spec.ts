import type { Locator, Page } from "@playwright/test";
import type { FeedBook } from "../src/api/generated/FeedBook";
import type { Quote } from "../src/api/generated/Quote";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pollSaved, test } from "./harness";
import { BASE, CODE, ordersOn, pinQuote, snapshot, tradingApi, win } from "./order-window";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const WINDOW_LIMIT = "창은 50개까지 둘 수 있습니다";

const groups = (page: Page) => page.locator("[data-dock-group]");
const allTabs = (page: Page) => groups(page).locator(".dock-tabs").getByRole("tab");
const tabOf = (page: Page, id: string) => page.locator(`[role=tab][data-window-id="${id}"]`);
const dotOf = (page: Page, id: string) => page.locator(`[role=tab][data-window-id="${id}"] + .link-dot`);
const addButton = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" });
const menu = (page: Page) => page.getByRole("menu", { name: "창 더하기" });
const kindItem = (page: Page, name: string) => menu(page).getByRole("menuitem", { name: new RegExp(`^${name}`) });
const closeButton = (page: Page, name: string) => page.getByRole("button", { name: `${name} 닫기`, exact: true });
const saved = (scenario: Scenario) => scenario.documents.layout(DEFAULT_LAYOUT_ID);
const savedWindows = (scenario: Scenario, kind: string) => saved(scenario).windows.filter((w) => w.kind === kind);

const charts: LayoutWindow[] = [
  { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
  { id: "cell-1", link: "b", kind: "chart", symbol: "000660", venue: "combined", period: "D", chartSettings: SETTINGS },
];

function saveWindows(scenario: Scenario, others: LayoutWindow[], mode: "dock" | "canvas" = "dock") {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, windows: [...charts, ...others], placement: {}, revision: layout.revision + 1 });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: mode });
}

async function open(page: Page) {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function addWindow(page: Page, name: string) {
  await addButton(page).click();
  await kindItem(page, name).click();
}

async function chooseLink(page: Page, id: string, letter: string) {
  await dotOf(page, id).click();
  await page.getByRole("menu", { name: "연동 색" }).getByRole("menuitemradio", { name: new RegExp(`^${letter}`) }).click();
}

const duplicateIds = (page: Page) => page.evaluate(() => {
  const seen = new Set<string>();
  return Array.from(document.querySelectorAll("[id]"), (element) => element.id).filter((id) => seen.size === seen.add(id).size);
});

function liveBook(price: number, qty: number): FeedBook {
  return { t: 1, asks: [{ price: price + 100, qty }], bids: [{ price, qty: qty * 2 }], totalAskQty: qty, totalBidQty: qty * 2, expected: null };
}

const bookSubs = (scenario: Scenario) => scenario.live.messages.flatMap((m) => (m.type === "subscribe_feed" && m.kind === "book" ? [{ sub: m.sub, symbol: m.symbol }] : []));
const unsubscribed = (scenario: Scenario) => scenario.live.messages.flatMap((m) => (m.type === "unsubscribe" ? [m.sub] : []));

test.beforeEach(async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const code of ["005930", "000660"]) {
    scenario.reply((url) => url.pathname === `/api/symbols/${code}/order-book`, { body: { ...snapshot(BASE), symbol: code } });
    scenario.reply((url) => url.pathname === `/api/symbols/${code}/fundamentals`, { body: { symbol: code, upperLimit: null, lowerLimit: null } });
    scenario.reply((url) => url.pathname === `/api/symbols/${code}/trades`, { body: { symbol: code, venue: "combined", trades: [], skippedRows: 0 } });
  }
});

test("10호가 창 둘을 연동 A·B로 두면 각자 그 색 차트의 종목을 보이고 종목마다 구독이 하나씩 나간다", async ({ page, scenario }) => {
  saveWindows(scenario, [{ id: "book", link: "a", kind: "book" }, { id: "book-2", link: "b", kind: "book" }], "canvas");
  await open(page);
  const books = page.getByTestId("book-window");
  await expect(books).toHaveCount(2);
  await expect(books.nth(0)).toHaveAttribute("data-symbol", "005930");
  await expect(books.nth(1)).toHaveAttribute("data-symbol", "000660");
  await pollSaved(() => bookSubs(scenario).map((s) => s.symbol).sort()).toEqual(["000660", "005930"]);
  expect(new Set(bookSubs(scenario).map((s) => s.sub)).size).toBe(2);
});

test("같은 종목을 보는 10호가 창 둘 가운데 하나를 닫으면 그 창의 구독만 풀리고 남은 창은 다음 호가를 그린다", async ({ page, scenario }) => {
  saveWindows(scenario, [{ id: "book", link: "a", kind: "book" }, { id: "book-2", link: "a", kind: "book" }], "canvas");
  await open(page);
  await expect(page.getByTestId("book-window")).toHaveCount(2);
  await pollSaved(() => bookSubs(scenario).length).toBe(2);
  const subs = bookSubs(scenario).map((s) => s.sub);

  await closeButton(page, "10호가 2").dispatchEvent("click");
  await expect(page.getByTestId("book-window")).toHaveCount(1);
  await pollSaved(() => unsubscribed(scenario).filter((sub) => subs.includes(sub)).length).toBe(1);
  const gone = unsubscribed(scenario).find((sub) => subs.includes(sub))!;
  const kept = subs.find((sub) => sub !== gone)!;

  scenario.live.emit({ type: "feed_book", sub: kept, book: liveBook(70_000, 50) });
  await expect(page.getByTestId("book-total-bid")).toHaveText("100주");
  expect(unsubscribed(scenario).filter((sub) => subs.includes(sub))).toEqual([gone]);
});

test("같은 종류 둘을 저장하고 새로 고침하면 둘 다 같은 연동 색으로 돌아온다", async ({ page, scenario }) => {
  await open(page);
  await addWindow(page, "체결");
  await addWindow(page, "체결");
  await expect(allTabs(page).filter({ hasText: /^체결 \d/ })).toHaveCount(2);
  await chooseLink(page, "trades", "B");
  await chooseLink(page, "trades-2", "B");
  await pollSaved(() => savedWindows(scenario, "trades").map((w) => [w.id, w.link])).toEqual([["trades", "b"], ["trades-2", "b"]]);

  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(tabOf(page, "trades")).toHaveAccessibleName(/^체결 1/);
  await expect(tabOf(page, "trades-2")).toHaveAccessibleName(/^체결 2/);
  await expect(dotOf(page, "trades")).toHaveAccessibleName("연동 색: B");
  await expect(dotOf(page, "trades-2")).toHaveAccessibleName("연동 색: B");
});

test("탭 메뉴의 복제는 연동 색을 옮긴 둘째 탭을 그 탭 바로 오른쪽에 만들고 고르며 되돌릴 수 있다", async ({ page, scenario }) => {
  await open(page);
  await addWindow(page, "체결");
  await addWindow(page, "10호가");
  await chooseLink(page, "trades", "B");
  const side = groups(page).filter({ has: tabOf(page, "trades") }).locator(".dock-tabs").getByRole("tab");
  await expect(side).toHaveText([/^관심종목/, /^스크리너/, /^체결/, /^10호가/]);

  await tabOf(page, "trades").click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "복제" }).click();
  await expect(side).toHaveText([/^관심종목/, /^스크리너/, /^체결 1/, /^체결 2/, /^10호가/]);
  await expect(tabOf(page, "trades-2")).toHaveAttribute("aria-selected", "true");
  await expect(dotOf(page, "trades-2")).toHaveAccessibleName("연동 색: B");
  await pollSaved(() => savedWindows(scenario, "trades").map((w) => [w.id, w.link])).toEqual([["trades", "b"], ["trades-2", "b"]]);

  await tabOf(page, "trades-2").click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "배치 되돌리기" }).click();
  await expect(side).toHaveText([/^관심종목/, /^스크리너/, /^체결/, /^10호가/]);
  await pollSaved(() => savedWindows(scenario, "trades")).toHaveLength(1);
});

test("닫기 단추 접근성 이름은 번호가 붙고 하나를 닫으면 남은 창 이름이 번호 없이 돌아온다", async ({ page }) => {
  await open(page);
  await addWindow(page, "체결");
  await addWindow(page, "체결");
  await expect(closeButton(page, "체결 1")).toBeVisible();
  await expect(closeButton(page, "체결 2")).toBeVisible();
  await expect(closeButton(page, "체결")).toHaveCount(0);

  await closeButton(page, "체결 2").click();
  await expect(page.getByRole("status").filter({ hasText: "체결 2 창을 닫았습니다" })).toBeVisible();
  await expect(closeButton(page, "체결")).toBeVisible();
  await expect(closeButton(page, "체결 1")).toHaveCount(0);
  await expect(allTabs(page).filter({ hasText: /^체결/ })).toHaveCount(1);
});

test("지표는 메뉴에서 열려 있음이고 다시 골라도 하나다", async ({ page, scenario }) => {
  await open(page);
  await addWindow(page, "지표");
  await addButton(page).click();
  await expect(kindItem(page, "지표")).toContainText("열려 있음");
  await kindItem(page, "지표").click();
  await expect(allTabs(page).filter({ hasText: /^지표/ })).toHaveCount(1);
  await pollSaved(() => savedWindows(scenario, "indicators")).toHaveLength(1);
});

test("호가주문 창 둘에서 수량 칸 이름표는 각자 자기 입력칸을 가리키고 화면 안에 겹치는 id가 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  pinQuote(scenario, CODE, BASE);
  saveWindows(scenario, [{ id: "order", link: "a", kind: "order", venue: "krx" }, { id: "order-2", link: "a", kind: "order", venue: "krx" }], "canvas");
  await page.setViewportSize({ width: 1440, height: 1500 });
  await open(page);
  await expect(win(page)).toHaveCount(2);
  const quantity = (index: number): Locator => win(page).nth(index).getByLabel("수량", { exact: true });
  await quantity(0).fill("7");
  await quantity(1).fill("9");
  await expect(quantity(0)).toHaveValue("7");
  await expect(quantity(1)).toHaveValue("9");
  await win(page).nth(1).locator("label.od-qty-label").dispatchEvent("click");
  await expect(quantity(1)).toBeFocused();
  await win(page).nth(0).locator("label.od-qty-label").dispatchEvent("click");
  await expect(quantity(0)).toBeFocused();
  expect(await duplicateIds(page)).toEqual([]);
});

test("관심종목 창 둘을 열 수 있고 저장한 뒤 새로 고쳐도 둘이다", async ({ page, scenario }) => {
  await open(page);
  await addButton(page).click();
  await expect(kindItem(page, "관심종목")).toContainText("1개 열림");
  await kindItem(page, "관심종목").click();
  await expect(allTabs(page).filter({ hasText: /^관심종목 \d/ })).toHaveText([/^관심종목 1/, /^관심종목 2/]);
  await pollSaved(() => savedWindows(scenario, "watchlist").map((w) => w.id)).toEqual(["watchlist", "watchlist-2"]);
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(allTabs(page).filter({ hasText: /^관심종목 \d/ })).toHaveCount(2);
  expect(await duplicateIds(page)).toEqual([]);
});

test("창 49개가 든 레이아웃에서 하나를 더하면 50개가 되고 메뉴 항목이 모두 막히며 새로 고쳐도 50개가 돌아온다", async ({ page, scenario }) => {
  const others: LayoutWindow[] = Array.from({ length: 46 }, (_, n) => ({ id: `trades-${n + 1}`, link: null, kind: "trades" }));
  saveWindows(scenario, [...others, { id: "watchlist", link: null, kind: "watchlist" }]);
  expect(saved(scenario).windows).toHaveLength(49);
  await open(page);
  await expect(allTabs(page)).toHaveCount(49);

  await addWindow(page, "체결");
  await expect(allTabs(page)).toHaveCount(50);
  await pollSaved(() => saved(scenario).windows.length).toBe(50);

  await addButton(page).click();
  await expect(menu(page).getByRole("menuitem")).toHaveCount(10);
  for (const item of await menu(page).getByRole("menuitem").all()) await expect(item).toBeDisabled();
  await expect(kindItem(page, "체결")).toContainText(WINDOW_LIMIT);
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(allTabs(page)).toHaveCount(50);
  expect(saved(scenario).windows).toHaveLength(50);
});

test("한 묶음에 탭 20개가 있을 때 마지막 탭을 단축키나 복제로 고르면 그 탭이 탭 줄 안에 보인다", async ({ page, scenario }) => {
  const trades: LayoutWindow[] = Array.from({ length: 19 }, (_, n) => ({ id: n === 0 ? "trades" : `trades-${n + 1}`, link: null, kind: "trades" }));
  saveWindows(scenario, [...trades, { id: "watchlist", link: null, kind: "watchlist" }]);
  await open(page);
  const strip = page.locator(".dock-tabs").filter({ has: tabOf(page, "watchlist") });
  await expect(strip.getByRole("tab")).toHaveCount(20);
  const overflow = () => strip.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(await overflow()).toBe(true);
  await expect(tabOf(page, "watchlist")).not.toBeInViewport();

  await page.keyboard.press("Alt+W");
  await expect(tabOf(page, "watchlist")).toHaveAttribute("aria-selected", "true");
  await expect(tabOf(page, "watchlist")).toBeInViewport({ ratio: 1 });

  await tabOf(page, "trades").click();
  await expect(tabOf(page, "watchlist")).not.toBeInViewport();
  await tabOf(page, "trades-19").click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "복제" }).click();
  await expect(tabOf(page, "trades-20")).toHaveAttribute("aria-selected", "true");
  await expect(tabOf(page, "trades-20")).toBeInViewport({ ratio: 1 });
});

const watchPanels = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const watchListButton = (page: Page, index: number) => watchPanels(page).nth(index).getByRole("button", { name: /^관심종목 목록:/ });
const watchRow = (page: Page, index: number, code: string) => watchPanels(page).nth(index).locator(`li[data-code="${code}"]`);
const savedLists = (scenario: Scenario) => scenario.documents.watchlists().lists.map((l) => [l.id, l.symbols]);
const watchWindowLists = (scenario: Scenario) => savedWindows(scenario, "watchlist").map((w) => (w.kind === "watchlist" ? w.list ?? null : null));

function seedWatch(scenario: Scenario, windows: { id: string; list?: string }[], active: string) {
  scenario.documents.saveWatchlists({
    revision: 100,
    lists: [
      { id: "A", name: "가", symbols: ["005930"], groups: [] },
      { id: "B", name: "나", symbols: ["000660"], groups: [] },
      { id: "C", name: "다", symbols: [], groups: [] },
    ],
  });
  saveWindows(scenario, windows.map((w) => ({ id: w.id, link: null, kind: "watchlist" as const, ...(w.list === undefined ? {} : { list: w.list }) })), "canvas");
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: "canvas", activeWatchlistId: active });
}

async function chooseWatchList(page: Page, index: number, name: string) {
  await watchListButton(page, index).dispatchEvent("click");
  await page.getByRole("menu", { name: "관심종목 목록" }).getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).dispatchEvent("click");
}

test("관심종목 창 둘에서 각자 다른 목록을 고르면 둘이 다른 목록을 보이고 창마다 그 목록이 저장되며 새로 고쳐도 그대로다", async ({ page, scenario }) => {
  seedWatch(scenario, [{ id: "watchlist" }, { id: "watchlist-2" }], "A");
  await open(page);
  await chooseWatchList(page, 1, "나");
  await chooseWatchList(page, 0, "가");
  await expect(watchListButton(page, 0)).toHaveAccessibleName("관심종목 목록: 가");
  await expect(watchListButton(page, 1)).toHaveAccessibleName("관심종목 목록: 나");
  await expect(watchRow(page, 0, "005930")).toHaveCount(1);
  await expect(watchRow(page, 1, "000660")).toHaveCount(1);
  await expect(watchRow(page, 0, "000660")).toHaveCount(0);
  await pollSaved(() => watchWindowLists(scenario)).toEqual(["A", "B"]);
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(watchListButton(page, 0)).toHaveAccessibleName("관심종목 목록: 가");
  await expect(watchListButton(page, 1)).toHaveAccessibleName("관심종목 목록: 나");
});

test("list가 없는 옛 레이아웃의 관심종목 창은 앱 전체 마지막 목록을 보인다", async ({ page, scenario }) => {
  seedWatch(scenario, [{ id: "watchlist" }, { id: "watchlist-2" }], "B");
  await open(page);
  await expect(watchListButton(page, 0)).toHaveAccessibleName("관심종목 목록: 나");
  await expect(watchListButton(page, 1)).toHaveAccessibleName("관심종목 목록: 나");
});

test("둘째 창의 ＋ 검색으로 고른 종목은 둘째 창의 목록에만 들어간다", async ({ page, scenario }) => {
  seedWatch(scenario, [{ id: "watchlist", list: "A" }, { id: "watchlist-2", list: "B" }], "A");
  await open(page);
  await watchPanels(page).nth(1).getByRole("button", { name: "관심종목에 넣기" }).dispatchEvent("click");
  const dialog = page.getByRole("dialog", { name: "관심종목에 넣을 종목 검색" });
  await expect(dialog.getByRole("button", { name: "넣을 곳: 그룹 없음" })).toBeVisible();
  const input = dialog.getByRole("combobox", { name: "종목 검색" });
  await input.fill("035420");
  await expect(dialog.getByRole("option").filter({ hasText: "035420" })).toHaveAttribute("aria-disabled", "false");
  await input.press("Enter");
  await expect(page.locator(".ui-toast")).toContainText("나에 넣었습니다");
  await pollSaved(() => savedLists(scenario)).toEqual([["A", ["005930"]], ["B", ["000660", "035420"]], ["C", []]]);
  await dialog.getByRole("button", { name: "검색 닫기" }).click();
  await expect(watchRow(page, 1, "035420")).toHaveCount(1);
  await expect(watchRow(page, 0, "035420")).toHaveCount(0);
});

test("한 창이 보던 목록을 다른 창이 지우면 그 창은 앱 전체 마지막 목록을 보인다", async ({ page, scenario }) => {
  seedWatch(scenario, [{ id: "watchlist", list: "A" }, { id: "watchlist-2", list: "B" }], "A");
  await open(page);
  await chooseWatchList(page, 0, "나");
  await watchListButton(page, 0).dispatchEvent("click");
  await page.getByRole("menu", { name: "관심종목 목록" }).getByRole("menuitem", { name: "목록 지우기" }).dispatchEvent("click");
  await page.getByRole("button", { name: "목록 지우기", exact: true }).last().click();
  await pollSaved(() => savedLists(scenario).map(([id]) => id)).toEqual(["A", "C"]);
  await expect(watchListButton(page, 0)).toHaveAccessibleName("관심종목 목록: 가");
  await expect(watchListButton(page, 1)).toHaveAccessibleName("관심종목 목록: 가");
});

test("두 창의 목록에 있는 종목이 모두 구독되고 각 창의 현재가가 실시간으로 바뀐다", async ({ page, scenario }) => {
  seedWatch(scenario, [{ id: "watchlist", list: "A" }, { id: "watchlist-2", list: "B" }], "A");
  await open(page);
  const watched = () => scenario.live.messages.flatMap((m) => (m.type === "watch" ? [[...m.symbols].sort()] : [])).at(-1);
  await pollSaved(watched).toEqual(["000660", "005930"]);
  const quote = (symbol: string, price: number): Quote => ({ symbol, price, change: 500, changeRate: 0.5, volume: 1_000, t: 1794186000, source: "realtime", venue: "combined" });
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quote("005930", 51_500), quote("000660", 201_500)] });
  await expect(watchRow(page, 0, "005930")).toContainText("51,500");
  await expect(watchRow(page, 1, "000660")).toContainText("201,500");
});
