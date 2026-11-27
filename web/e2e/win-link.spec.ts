import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { LinkColor } from "../src/api/generated/LinkColor";
import type { Venue } from "../src/api/generated/Venue";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, SEARCH_BUTTON_TITLE, test, windowTabs, expectDesktopVenue, pollSaved } from "./harness";

const SCREENS = path.resolve("../target/ux-screens");
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };

const chart = (id: string, link: LinkColor | null, symbol: string, period: "D" | "W", venue: Venue = "combined"): LayoutWindow =>
  ({ id, link, kind: "chart", symbol, venue, period, chartSettings: SETTINGS });

function linkedCharts(scenario: Scenario, secondVenue: Venue = "combined") {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows = [chart("cell-0", "a", "005930", "D"), chart("cell-1", "a", "005930", "W", secondVenue), chart("cell-2", null, "000660", "D"), ...layout.windows.filter((w) => w.kind !== "chart")];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  const lists = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ lists: lists.lists.map((list, i) => (i === 0 ? { ...list, symbols: ["035420", "051910", "000270"] } : list)), revision: lists.revision + 1 });
}

const tabOf = (page: Page, id: string) => windowTabs(page).locator(`[role=tab][data-window-id="${id}"]`);
const dotOf = (page: Page, id: string) => windowTabs(page).locator(`[role=tab][data-window-id="${id}"] + .link-dot`);
const row = (page: Page, code: string) => page.getByRole("complementary", { name: "관심종목" }).locator(`li[data-code="${code}"] [data-main]`);
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });
async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소의 자리를 찾았습니다");
  return box;
}
const savedWindow = (scenario: Scenario, id: string) => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.find((w) => w.id === id);

async function drawn(chartCell: Locator, label: RegExp) {
  await expect(chartCell).toHaveAttribute("aria-label", label);
  await expect(chartCell).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => Number(await chartOf(chartCell).getAttribute("data-bar-count"))).toBeGreaterThan(0);
}

async function ready(page: Page) {
  await page.goto("/");
  await drawn(cell(page, 1), /^칸 1: 삼성전자 .* 일$/);
  await drawn(cell(page, 2), /^칸 2: 삼성전자 .* 주$/);
  await drawn(cell(page, 3), /^칸 3: SK하이닉스 .* 일$/);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("관심종목의 연동 색에 따라 종목을 그 색의 차트, 활성 칸으로 보내고 따르는 차트가 없으면 아무것도 바꾸지 않는다", async ({ page, scenario }) => {
  linkedCharts(scenario);
  await ready(page);
  const watchDot = dotOf(page, "watchlist");
  await expect(watchDot).toHaveAccessibleName("연동 색: 끔");
  await expect(dotOf(page, "cell-0")).toHaveAccessibleName("연동 색: A");
  await expect(dotOf(page, "cell-2")).toHaveAccessibleName("연동 색: 끔");
  await expect(dotOf(page, "screener")).toHaveAccessibleName("연동 색: 끔");

  await watchDot.focus();
  await expect(watchDot).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitemradio", { name: /^A/ }).click();
  await expect(watchDot).toHaveAccessibleName("연동 색: A");
  await expect(watchDot).toHaveText("A");
  await expect(dotOf(page, "screener")).toHaveAttribute("tabindex", "-1");

  await row(page, "035420").click();
  await expect(tabOf(page, "cell-0").locator(".dock-tab-flash")).toBeAttached();
  await expect(tabOf(page, "cell-1").locator(".dock-tab-flash")).toBeAttached();
  await drawn(cell(page, 1), /^칸 1: NAVER .* 일$/);
  await drawn(cell(page, 2), /^칸 2: NAVER .* 주$/);
  await expect(toast(page, "연동")).toHaveCount(0);
  await expect(cell(page, 3)).toHaveAttribute("aria-label", /^칸 3: SK하이닉스 .* 일$/);
  await expect(tabOf(page, "cell-2").locator(".dock-tab-flash")).toHaveCount(0);
  await expect(row(page, "035420")).toHaveAttribute("aria-current", "true");
  await expect(tabOf(page, "cell-0").locator(".dock-tab-flash")).toHaveCount(0);
  if (process.env.VALLY_E2E_SCREENSHOTS === "1") { await mkdir(SCREENS, { recursive: true }); await page.screenshot({ path: path.join(SCREENS, "win-link-1440x900.png") }); }

  await watchDot.press("Space");
  await page.getByRole("menuitemradio", { name: /^B/ }).click();
  await expect(watchDot).toHaveAccessibleName("연동 색: B");
  await expect(row(page, "035420")).not.toHaveAttribute("aria-current", "true");
  await row(page, "051910").click();
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: NAVER /);
  await expect(cell(page, 2)).toHaveAttribute("aria-label", /^칸 2: NAVER /);
  await expect(cell(page, 3)).toHaveAttribute("aria-label", /^칸 3: SK하이닉스 /);
  await expect(toast(page, "연동")).toHaveCount(0);

  await chooseLink(page, watchDot, "끔");
  await expect(watchDot).toHaveAccessibleName("연동 색: 끔");
  const third = await cell(page, 3).boundingBox();
  await page.mouse.click(third!.x + third!.width / 2, third!.y + third!.height / 2);
  await expect(tabOf(page, "cell-2")).toHaveAttribute("data-active-cell", "");
  await row(page, "051910").click();
  await expect(cell(page, 3)).toHaveAttribute("aria-label", /^칸 3: SK하이닉스 /);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: NAVER /);
  await expect(cell(page, 2)).toHaveAttribute("aria-label", /^칸 2: NAVER /);
  await expect(row(page, "051910")).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("status").filter({ hasText: "LG화학" })).toHaveCount(0);
});

test("위 막대 검색으로 바꾼 종목은 같은 색의 차트로 퍼지고, 색을 맞춘 차트는 그 종목을 따르며 새로고침 뒤에도 남는다", async ({ page, scenario }) => {
  linkedCharts(scenario);
  await ready(page);
  await page.getByTitle(SEARCH_BUTTON_TITLE).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill("035720");
  const kakao = dialog.getByRole("option").filter({ hasText: "035720" });
  await expect(kakao).toHaveAttribute("aria-disabled", "false");
  await kakao.click();
  await drawn(cell(page, 1), /^칸 1: 카카오 .* 일$/);
  await drawn(cell(page, 2), /^칸 2: 카카오 .* 주$/);
  await expect(toast(page, "연동")).toHaveCount(0);
  await expect(cell(page, 3)).toHaveAttribute("aria-label", /^칸 3: SK하이닉스 .* 일$/);

  const thirdDot = dotOf(page, "cell-2");
  await thirdDot.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitemradio", { name: /^A/ }).click();
  await expect(thirdDot).toHaveAccessibleName("연동 색: A");
  await drawn(cell(page, 3), /^칸 3: 카카오 .* 일$/);
  await expect(tabOf(page, "cell-2").locator(".dock-tab-flash")).toBeAttached();

  await chooseLink(page, dotOf(page, "screener"), "A");
  await expect(dotOf(page, "screener")).toHaveAccessibleName("연동 색: A");
  await pollSaved(() => [savedWindow(scenario, "cell-2"), savedWindow(scenario, "screener")?.link]).toEqual([
    expect.objectContaining({ link: "a", symbol: "035720", period: "D" }),
    "a",
  ]);
  await page.reload();
  await drawn(cell(page, 1), /^칸 1: 카카오 .* 일$/);
  await drawn(cell(page, 2), /^칸 2: 카카오 .* 주$/);
  await drawn(cell(page, 3), /^칸 3: 카카오 .* 일$/);
  await expect(dotOf(page, "cell-2")).toHaveAccessibleName("연동 색: A");
  await expect(dotOf(page, "screener")).toHaveAccessibleName("연동 색: A");
  await expect(dotOf(page, "watchlist")).toHaveAccessibleName("연동 색: 끔");
  await expect(tabOf(page, "cell-2").locator(".dock-tab-flash")).toHaveCount(0);
});

test("주소로 연 종목은 같은 색의 차트로 퍼지고, venue는 앱 전체 거래소를 바꾼다", async ({ page, scenario }) => {
  linkedCharts(scenario, "nxt");
  await page.goto("/?symbol=000660");
  await drawn(cell(page, 1), /^칸 1: SK하이닉스 통합 일$/);
  await drawn(cell(page, 2), /^칸 2: SK하이닉스 통합 주$/);
  await expect(toast(page, "연동")).toHaveCount(0);

  await page.goto("/?symbol=005935&venue=nxt");
  await expectDesktopVenue(page, "NXT");
  await drawn(cell(page, 1), /^칸 1: 삼성전자우 통합 일$/);
  await drawn(cell(page, 2), /^칸 2: 삼성전자우 통합 주$/);
  await expect(toast(page, "연동")).toHaveCount(0);
  await expect(cell(page, 3)).toHaveAttribute("aria-label", /^칸 3: SK하이닉스 /);
});

async function chooseLink(page: Page, dot: Locator, name: string) {
  await dot.click();
  await page.getByRole("menu", { name: "연동 색" }).getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).click();
}

const LINKS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] as const;

const swatchMenu = (page: Page) => page.getByRole("menu", { name: "연동 색" });
const swatchNamed = (page: Page, name: string) => swatchMenu(page).getByRole("menuitemradio", { name, exact: true });
const swatchNote = (page: Page) => swatchMenu(page).locator(".link-swatch-note");

test("연동 색 점은 끔·A~J 견본을 열어 같은 색 창 수를 이름에 보이고, 색과 지금 값을 표시한다", async ({ page, scenario }) => {
  linkedCharts(scenario);
  await ready(page);
  const dot = dotOf(page, "watchlist");
  await expect(dot).toHaveAttribute("aria-haspopup", "menu");
  await expect(dot).toHaveAttribute("aria-expanded", "false");
  await dot.click();
  await expect(dot).toHaveAttribute("aria-expanded", "true");
  const menu = swatchMenu(page);
  await expect(menu).toHaveAttribute("aria-orientation", "horizontal");
  await expect(menu.getByRole("menuitemradio")).toHaveCount(11);
  const names = ["끔", "A · 창 2개", ...LINKS.slice(1).map((link) => `${link.toUpperCase()} · 없음`)];
  for (const [index, name] of names.entries()) await expect(menu.getByRole("menuitemradio").nth(index)).toHaveAccessibleName(name);
  await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveAccessibleName("끔");

  const fills = await page.evaluate((links) => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const expected = links.map((link) => { probe.style.background = `var(--link-${link})`; return getComputedStyle(probe).backgroundColor; });
    probe.remove();
    const swatches = [...document.querySelectorAll<HTMLElement>(".link-swatch")];
    return { expected, off: swatches.slice(0, 1).map((swatch) => getComputedStyle(swatch).backgroundColor)[0], actual: swatches.slice(1).map((swatch) => getComputedStyle(swatch).backgroundColor) };
  }, LINKS);
  expect(fills.actual).toEqual(fills.expected);
  expect(new Set(fills.actual).size).toBe(10);
  expect(fills.off).toBe("rgba(0, 0, 0, 0)");
  expect(await swatchNamed(page, "끔").evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");

  const boxNamed = (name: string) => boxOf(swatchNamed(page, name));
  const [off, a, e, f, jj] = [await boxNamed("끔"), await boxNamed("A · 창 2개"), await boxNamed("E · 없음"), await boxNamed("F · 없음"), await boxNamed("J · 없음")];
  expect(off.x).toBeLessThan(a.x);
  expect(e.y).toBe(a.y);
  expect(f.y).toBeGreaterThan(a.y);
  expect(f.x).toBe(a.x);
  expect(jj.x).toBe(e.x);
  expect(a.width).toBe(28);
});

test("견본 키보드: 열면 지금 값에 초점, 화살표·Home·End·글자로 초점만 옮기고 Enter로 고르면 점으로 돌아오며 Esc는 바꾸지 않는다", async ({ page, scenario }) => {
  linkedCharts(scenario);
  await ready(page);
  const dot = dotOf(page, "cell-0");
  const menu = swatchMenu(page);
  await expect(dot).toHaveAccessibleName("연동 색: A");
  await dot.focus();
  await page.keyboard.press("Enter");
  await expect(swatchNamed(page, "A · 창 1개")).toBeFocused();
  await expect(swatchNamed(page, "A · 창 1개")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowRight");
  await expect(swatchNamed(page, "B · 없음")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(swatchNamed(page, "G · 없음")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(swatchNamed(page, "B · 없음")).toBeFocused();
  await page.keyboard.press("End");
  await expect(swatchNamed(page, "J · 없음")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(swatchNamed(page, "J · 없음")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(swatchNamed(page, "끔")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(swatchNamed(page, "끔")).toBeFocused();
  await page.keyboard.press("D");
  await expect(swatchNamed(page, "D · 없음")).toBeFocused();
  await expect(swatchNote(page)).toHaveText("D · 아직 이 색을 쓰는 창이 없습니다");
  await expect(dot).toHaveAccessibleName("연동 색: A");

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(dot).toBeFocused();
  await expect(dot).toHaveAccessibleName("연동 색: A");
  expect(savedWindow(scenario, "cell-0")?.link).toBe("a");

  await page.keyboard.press("Space");
  await page.keyboard.press("d");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(dot).toBeFocused();
  await expect(dot).toHaveAccessibleName("연동 색: D");
  await pollSaved(() => savedWindow(scenario, "cell-0")?.link).toBe("d");

  await page.keyboard.press("Enter");
  await expect(swatchNamed(page, "D · 없음")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
});

test("가리킨 견본의 설명 줄이 바뀌고 팝오버 폭은 그대로다", async ({ page, scenario }) => {
  linkedCharts(scenario);
  await ready(page);
  const dot = dotOf(page, "watchlist");
  await dot.click();
  const menu = swatchMenu(page);
  await expect(swatchNote(page)).toHaveText("끔 · 이 창만 따로 봅니다");
  const width = (await boxOf(menu)).width;
  await swatchNamed(page, "A · 창 2개").hover();
  await expect(swatchNote(page)).toHaveText("A · 창 2개와 종목을 맞춥니다");
  await swatchNamed(page, "J · 없음").hover();
  await expect(swatchNote(page)).toHaveText("J · 아직 이 색을 쓰는 창이 없습니다");
  expect((await boxOf(menu)).width).toBe(width);
  await swatchNamed(page, "끔").hover();
  await expect(swatchNote(page)).toHaveText("끔 · 이 창만 따로 봅니다");
  expect((await boxOf(menu)).width).toBe(width);
});

for (const id of ["watchlist", "cell-0"]) {
  test(`도킹 탭 ${id}: 점에 포인터를 올리거나 견본이 열려 있거나 Esc로 닫아도 점과 닫기 버튼이 제자리에 있다`, async ({ page, scenario }) => {
    linkedCharts(scenario);
    await ready(page);
    const dot = dotOf(page, id);
    const close = windowTabs(page).locator(`.dock-tab-group:has([data-window-id="${id}"]) .dock-tab-close`);
    const placed = async () => ({ dot: await boxOf(dot), close: await boxOf(close) });
    const before = await placed();
    await dot.hover();
    expect(await placed()).toEqual(before);
    await dot.click();
    await expect(swatchMenu(page)).toBeVisible();
    expect(await placed()).toEqual(before);
    await page.keyboard.press("Escape");
    await expect(swatchMenu(page)).toHaveCount(0);
    expect(await placed()).toEqual(before);
  });
}

for (const link of [null, "a"] as const) {
  test(`도킹 탭 10호가·호가주문: 연동 ${link ?? "끔"}이어도 고정 점이 연동 색 점과 겹치지 않고 탭 단추 밖에 놓인다`, async ({ page, scenario }) => {
    const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
    const windows: LayoutWindow[] = [
      chart("cell-0", "a", "005930", "D"),
      ...layout.windows.filter((w) => w.kind !== "chart"),
      { id: "book", link, kind: "book", symbol: "005930" },
      { id: "order", link, kind: "order", venue: "combined", symbol: "005930" },
    ];
    scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
    scenario.reply((url) => url.pathname === "/api/symbols/005930/order-book", { status: 503, body: { error: { code: "internal", message: "호가 없음", reason: null, retryAt: null, manualActionRequired: false } } });
    scenario.reply((url) => url.pathname === "/api/symbols/005930/fundamentals", { body: { symbol: "005930", upperLimit: null, lowerLimit: null } });
    scenario.reply((url) => url.pathname === "/api/symbols/005930/trades", { body: { symbol: "005930", venue: "combined", trades: [], skippedRows: 0 } });
    await page.goto("/");
    for (const id of ["book", "order"]) {
      await tabOf(page, id).click();
      const dot = dotOf(page, id);
      await expect(dot).toHaveAttribute("data-locked", "");
      await expect(dot.locator(".link-dot-lock")).toBeVisible();
    }
  });
}

test("가장 좁은 데스크톱 폭 768px에서도 견본 팝오버가 화면 안에 든다", async ({ page, scenario }) => {
  linkedCharts(scenario);
  await page.setViewportSize({ width: 768, height: 740 });
  await page.goto("/");
  const dot = dotOf(page, "watchlist");
  await dot.click();
  const menu = swatchMenu(page);
  await expect(menu).toBeVisible();
  const box = await boxOf(menu);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(768);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(740);
});
