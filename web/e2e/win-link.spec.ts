import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { LinkColor } from "../src/api/generated/LinkColor";
import type { Venue } from "../src/api/generated/Venue";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, SEARCH_BUTTON_TITLE, test, windowTabs, expectDesktopVenue } from "./harness";

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

test("관심종목의 연동 색에 따라 종목을 그 색의 차트, 활성 칸으로 보내고 따르는 차트가 없으면 알린다", async ({ page, scenario }) => {
  linkedCharts(scenario);
  await ready(page);
  const watchDot = dotOf(page, "watchlist");
  await expect(watchDot).toHaveAccessibleName("연동 색: 끔");
  await expect(dotOf(page, "cell-0")).toHaveAccessibleName("연동 색: A");
  await expect(dotOf(page, "cell-2")).toHaveAccessibleName("연동 색: 끔");
  await expect(dotOf(page, "objects")).toHaveCount(0);

  await tabOf(page, "watchlist").focus();
  await page.keyboard.press("Tab");
  await expect(watchDot).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(watchDot).toHaveAccessibleName("연동 색: A");
  await expect(watchDot).toHaveText("A");
  await page.keyboard.press("Tab");
  await expect(dotOf(page, "screener")).not.toBeFocused();
  await expect(page.locator(":focus")).not.toHaveClass("link-dot");

  await row(page, "035420").click();
  await expect(tabOf(page, "cell-0").locator(".dock-tab-flash")).toBeAttached();
  await expect(tabOf(page, "cell-1").locator(".dock-tab-flash")).toBeAttached();
  await expect(toast(page, "연동 A: 차트 2개가 NAVER로 바뀌었습니다")).toBeVisible();
  await drawn(cell(page, 1), /^칸 1: NAVER .* 일$/);
  await drawn(cell(page, 2), /^칸 2: NAVER .* 주$/);
  await expect(cell(page, 3)).toHaveAttribute("aria-label", /^칸 3: SK하이닉스 .* 일$/);
  await expect(tabOf(page, "cell-2").locator(".dock-tab-flash")).toHaveCount(0);
  await expect(row(page, "035420")).toHaveAttribute("aria-current", "true");
  await expect(tabOf(page, "cell-0").locator(".dock-tab-flash")).toHaveCount(0);
  await mkdir(SCREENS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENS, "win-link-1440x900.png") });

  await watchDot.press("Space");
  await expect(watchDot).toHaveAccessibleName("연동 색: B");
  await expect(row(page, "035420")).not.toHaveAttribute("aria-current", "true");
  await row(page, "051910").click();
  await expect(toast(page, "연동 B를 따르는 차트가 없습니다. 차트의 연동 색을 B로 맞추세요")).toBeVisible();
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: NAVER /);
  await expect(cell(page, 2)).toHaveAttribute("aria-label", /^칸 2: NAVER /);
  await expect(cell(page, 3)).toHaveAttribute("aria-label", /^칸 3: SK하이닉스 /);

  await watchDot.click();
  await watchDot.click();
  await expect(watchDot).toHaveAccessibleName("연동 색: 끔");
  const third = await cell(page, 3).boundingBox();
  await page.mouse.click(third!.x + third!.width / 2, third!.y + third!.height / 2);
  await expect(tabOf(page, "cell-2")).toHaveAttribute("data-active-cell", "");
  await row(page, "051910").click();
  await drawn(cell(page, 3), /^칸 3: LG화학 .* 일$/);
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
  await expect(toast(page, "연동 A: 차트 2개가 카카오로 바뀌었습니다")).toBeVisible();
  await drawn(cell(page, 1), /^칸 1: 카카오 .* 일$/);
  await drawn(cell(page, 2), /^칸 2: 카카오 .* 주$/);
  await expect(cell(page, 3)).toHaveAttribute("aria-label", /^칸 3: SK하이닉스 .* 일$/);

  const thirdDot = dotOf(page, "cell-2");
  await thirdDot.focus();
  await page.keyboard.press("Enter");
  await expect(thirdDot).toHaveAccessibleName("연동 색: A");
  await drawn(cell(page, 3), /^칸 3: 카카오 .* 일$/);
  await expect(tabOf(page, "cell-2").locator(".dock-tab-flash")).toBeAttached();

  await dotOf(page, "screener").click();
  await expect(dotOf(page, "screener")).toHaveAccessibleName("연동 색: A");
  await expect.poll(() => [savedWindow(scenario, "cell-2"), savedWindow(scenario, "screener")?.link]).toEqual([
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

test("주소로 연 종목은 같은 색의 차트로 퍼지고, venue는 앱 전체 거래소를 바꾸며 연동 알림만 보인다", async ({ page, scenario }) => {
  linkedCharts(scenario, "nxt");
  await page.goto("/?symbol=000660");
  await expect(toast(page, "연동 A: 차트 2개가 SK하이닉스로 바뀌었습니다")).toBeVisible();
  await drawn(cell(page, 1), /^칸 1: SK하이닉스 통합 일$/);
  await drawn(cell(page, 2), /^칸 2: SK하이닉스 통합 주$/);

  await page.goto("/?symbol=005935&venue=nxt");
  await expect(toast(page, "연동 A: 차트 2개가 삼성전자우로 바뀌었습니다")).toBeVisible();
  await expectDesktopVenue(page, "NXT");
  await drawn(cell(page, 1), /^칸 1: 삼성전자우 통합 일$/);
  await drawn(cell(page, 2), /^칸 2: 삼성전자우 통합 주$/);
  await expect(cell(page, 3)).toHaveAttribute("aria-label", /^칸 3: SK하이닉스 /);
});
