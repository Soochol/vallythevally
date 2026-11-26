import type { Locator, Page } from "@playwright/test";
import { selectOption } from "./select-option";
import { cell, chartOf, expect, SEARCH_BUTTON_TITLE, test, windowTabs } from "./harness";

test.use({ clockStart: "20261109100030", viewport: { width: 1440, height: 900 } });

const GAP = 6;
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const workspace = (page: Page) => page.getByRole("main", { name: "작업 영역" });
const axisMode = (page: Page) => cell(page).getByRole("combobox", { name: "가격축 방식" });
const boxOf = async (locator: Locator) => (await locator.boundingBox())!;
const overflow = (page: Page) => page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight]);

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

test("위 막대 섬은 창 폭을 쓰고 작업 영역은 그 아래에서 6px 띄우며 상태 줄은 화면 바닥의 얇은 줄이다", async ({ page }, info) => {
  await open(page);
  const bar = await boxOf(toolbar(page));
  const area = await boxOf(workspace(page));
  const status = page.getByRole("contentinfo");
  const strip = await boxOf(status);
  const chart = await boxOf(cell(page));
  const chartGroup = await boxOf(page.locator("[data-dock-group]").nth(0));
  const sideGroup = await boxOf(page.locator("[data-dock-group]").nth(1));
  expect(bar).toMatchObject({ x: GAP, y: GAP, width: 1440 - GAP * 2, height: 48 });
  const rail = await boxOf(page.getByRole("navigation", { name: "드로잉 도구" }));
  expect(rail).toMatchObject({ x: GAP, y: area.y, height: area.height });
  const pages = await boxOf(page.getByRole("navigation", { name: "페이지 메뉴" }));
  expect(pages).toMatchObject({ x: 1440 - GAP - pages.width, y: area.y, height: area.height });
  expect(area).toMatchObject({ x: rail.x + rail.width + GAP, y: GAP * 2 + 48, width: 1440 - GAP * 2 - rail.width - GAP - pages.width - GAP });
  expect(area.x + area.width + GAP).toBe(pages.x);
  expect(strip).toMatchObject({ x: 0, width: 1440, height: 28 });
  expect(strip.y + strip.height).toBe(900);
  expect(area.y + area.height).toBe(strip.y - GAP);
  expect(chartGroup).toMatchObject({ x: area.x, y: area.y, height: area.height });
  expect(sideGroup).toMatchObject({ y: area.y, height: area.height });
  expect(sideGroup.x - chartGroup.x - chartGroup.width).toBe(6);
  expect(sideGroup.x + sideGroup.width).toBe(area.x + area.width);
  expect(chart).toEqual({ x: chartGroup.x + 1, y: chartGroup.y + 35, width: chartGroup.width - 2, height: chartGroup.height - 36 });
  const attribution = status.getByRole("link", { name: "Charts by TradingView", exact: true });
  await expect(attribution).toBeVisible();
  await expect(attribution).toHaveAttribute("href", "https://www.tradingview.com/");
  await expect(status).not.toContainText("Charts by TradingView Lightweight Charts™");
  await expect(status.getByLabel("장 상태와 서버 시계")).toBeVisible();
  await expect(page.locator("footer")).toHaveCount(1);
  expect(await overflow(page)).toEqual([0, 0]);
  await page.screenshot({ path: info.outputPath("1440-shell.png") });
  for (const name of [/^스크리너/, /^관심종목$/]) {
    await windowTabs(page).getByRole("tab", { name }).click();
    await expect(windowTabs(page).getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
    expect(await boxOf(cell(page))).toEqual(chart);
  }
});

test("가격축 방식은 가격축과 시간축이 만나는 모서리의 콤보박스로 바꾸고 위 막대에는 없다", async ({ page }) => {
  await open(page);
  await expect(toolbar(page).getByRole("button", { name: "로그", exact: true })).toHaveCount(0);
  const axis = axisMode(page);
  await expect(axis).toHaveText("일반");
  await selectOption(axis, "log");
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "log");
  await expect(axis).toHaveText("로그");
  await selectOption(axis, "percent");
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "percent");
  await expect(axis).toHaveText("%");
  await selectOption(axis, "normal");
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "normal");
  await axis.click();
  await expect(page.getByRole("menuitemradio", { name: /^일반/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menuitemradio", { name: /^로그/ })).toContainText("L");
  await expect(page.getByRole("menuitemradio", { name: /^일반/ })).toContainText("가격 그대로");
  await expect(page.getByRole("menuitemradio", { name: /^%/ })).toContainText("왼쪽 끝 봉 기준");
  const menu = await boxOf(page.getByRole("menu", { name: "가격축 방식" }));
  const box = await boxOf(axis);
  expect(menu.y + menu.height).toBeLessThanOrEqual(box.y);
  await page.keyboard.press("Escape");
  const corner = await boxOf(chartOf(cell(page)));
  const right = corner.x + corner.width;
  const bottom = corner.y + corner.height;
  expect(box.x).toBeGreaterThanOrEqual(right - 72);
  expect(box.x + box.width).toBeLessThanOrEqual(right);
  expect(box.y).toBeGreaterThanOrEqual(bottom - 40);
  expect(box.y + box.height).toBeLessThanOrEqual(bottom);
});

test("1024px 창에서도 위 막대가 창 폭을 쓰고 작업 영역이 그 아래에 있으며 넘치지 않는다", async ({ page }, info) => {
  await open(page);
  await windowTabs(page).getByRole("tab", { name: /^스크리너/ }).click();
  await page.setViewportSize({ width: 1024, height: 768 });
  const bar = await boxOf(toolbar(page));
  expect(bar).toMatchObject({ x: GAP, width: 1024 - GAP * 2 });
  expect((await boxOf(workspace(page))).y).toBe(GAP * 2 + 48);
  expect(await toolbar(page).evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
  expect(await overflow(page)).toEqual([0, 0]);
  await page.screenshot({ path: info.outputPath("1024-shell.png") });

  await page.setViewportSize({ width: 1280, height: 300 });
  expect(await overflow(page)).toEqual([0, 0]);
});

test("종목을 바꾸는 동안 차트 칸은 뼈대 막대 없이 차트 배경만 보이고 0.4초 뒤에 가운데 글자가 나타난다", async ({ page, scenario }) => {
  await open(page);
  const chart = await boxOf(cell(page));
  const probe = { x: Math.round(chart.x + chart.width * 0.85), y: Math.round(chart.y + chart.height * 0.3) };
  const pixelAt = async (at: { x: number; y: number }) => (await page.screenshot({ clip: { ...at, width: 1, height: 1 } })).toString("base64");
  const pixelAtProbe = () => pixelAt(probe);

  const held = scenario.hold((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "086520");
  await page.getByTitle(SEARCH_BUTTON_TITLE).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill("ㅇㅋㅍㄹ");
  await dialog.getByRole("option").filter({ hasText: "086520" }).click();
  await held.received;

  await expect(cell(page)).toHaveAttribute("aria-busy", "true");
  await expect(cell(page).locator(".ui-skeleton")).toHaveCount(0);
  const background = await pixelAt({ x: probe.x, y: Math.round(chart.y + chart.height * 0.6) });
  expect(await pixelAtProbe()).toBe(background);
  await expect(cell(page).getByRole("status", { name: "차트 불러오는 중" })).toHaveCount(1);

  const label = cell(page).getByText("차트 불러오는 중", { exact: true });
  await expect(label).toBeVisible();
  const text = await boxOf(label);
  const area = await boxOf(cell(page));
  expect(Math.abs(text.x + text.width / 2 - (area.x + area.width / 2))).toBeLessThan(40);
  expect(Math.abs(text.y + text.height / 2 - (area.y + area.height / 2))).toBeLessThan(40);

  held.reply({ body: scenario.market.page({ symbol: "086520" }) });
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(label).toBeHidden();
});
