import type { Locator, Page } from "@playwright/test";
import { cell, chartOf, expect, test } from "./harness";

test.use({ clockStart: "20261109100030", viewport: { width: 1440, height: 900 } });

const GAP = 12;
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const rightPanel = (page: Page) => page.locator(".right-panel");
const rail = (page: Page) => page.getByRole("tablist", { name: "오른쪽 패널" });
const RAIL_W = 48;
const axisMode = (page: Page) => cell(page).getByRole("group", { name: "가격축 방식" });
const boxOf = async (locator: Locator) => (await locator.boundingBox())!;
const overflow = (page: Page) => page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight]);

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

test("차트는 창 전체 높이를 쓰고 위 막대·오른쪽 패널·세로 탭 막대는 12px 띄운 섬이며 상태 줄은 패널 바닥에 있다", async ({ page }, info) => {
  await open(page);
  const bar = await boxOf(toolbar(page));
  const panel = await boxOf(rightPanel(page));
  const tabs = await boxOf(rail(page));
  const chart = await boxOf(cell(page));
  expect(chart).toMatchObject({ y: 0, height: 900 });
  expect(bar).toMatchObject({ x: GAP, y: GAP, height: 48 });
  expect(tabs).toMatchObject({ y: GAP, width: RAIL_W, height: 900 - GAP * 2 });
  expect(tabs.x + tabs.width).toBe(1440 - GAP);
  expect(panel.y).toBe(GAP);
  expect(panel.x + panel.width).toBe(tabs.x - GAP);
  expect(panel.y + panel.height).toBe(900 - GAP);
  expect(bar.x + bar.width).toBe(panel.x - GAP);
  expect(chart.x + chart.width).toBe(panel.x - GAP);
  const status = rightPanel(page).locator("footer");
  await expect(status).toContainText("Lightweight Charts");
  await expect(status.getByLabel("장 상태와 서버 시계")).toBeVisible();
  await expect(page.locator("footer")).toHaveCount(1);
  expect(await overflow(page)).toEqual([0, 0]);
  await page.screenshot({ path: info.outputPath("1440-shell.png") });
  for (const name of [/^스크리너/, /^개체$/, /^관심종목$/]) {
    await rail(page).getByRole("tab", { name }).click();
    await expect(rail(page).getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
    expect(await boxOf(rightPanel(page))).toEqual(panel);
    expect(await boxOf(cell(page))).toEqual(chart);
  }
});

test("고른 세로 탭을 다시 눌러 패널을 접으면 차트와 위 막대가 세로 탭 막대 앞까지 넓어지고 상태 줄은 차트 왼쪽 아래 띠로 옮겨 간다", async ({ page }, info) => {
  await open(page);
  await rail(page).getByRole("tab", { name: "관심종목", exact: true }).click();
  await expect(rightPanel(page)).toHaveCount(0);
  const tabs = await boxOf(rail(page));
  const bar = await boxOf(toolbar(page));
  const chart = await boxOf(cell(page));
  expect(tabs.x + tabs.width).toBe(1440 - GAP);
  expect(bar.x + bar.width).toBe(tabs.x - GAP);
  expect(chart.x + chart.width).toBe(tabs.x - GAP);
  const status = page.locator("footer");
  await expect(status).toHaveCount(1);
  await expect(status).toContainText("Lightweight Charts");
  const strip = await boxOf(status);
  expect(strip.x).toBe(GAP);
  expect(strip.y + strip.height).toBeLessThan(900);
  await page.screenshot({ path: info.outputPath("1440-collapsed.png") });
  await rail(page).getByRole("tab", { name: "관심종목", exact: true }).click();
  await expect(rightPanel(page).locator("footer")).toBeVisible();
});

test("패널 왼쪽 가장자리를 끌면 모든 탭이 같은 폭으로 바뀌고 저장되며, 두 번 누르면 기본 폭으로 돌아가고 키보드로도 조절한다", async ({ page, scenario }) => {
  await open(page);
  const handle = page.getByRole("separator", { name: "오른쪽 패널 폭" });
  const before = await boxOf(rightPanel(page));
  expect(before.width).toBe(392);
  const grip = await boxOf(handle);
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 60, y, { steps: 4 });
  expect((await boxOf(rightPanel(page))).width).toBe(452);
  await page.mouse.move(x - 120, y, { steps: 4 });
  await page.mouse.up();
  const wider = await boxOf(rightPanel(page));
  expect(wider.width).toBe(512);
  expect(wider.x + wider.width).toBe(before.x + before.width);
  const chart = await boxOf(cell(page));
  expect(chart.x + chart.width).toBe(wider.x - GAP);
  await expect.poll(async () => scenario.documents.uiState().panelWidth).toBe(512);
  await rail(page).getByRole("tab", { name: /^스크리너/ }).click();
  expect((await boxOf(rightPanel(page))).width).toBe(512);
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  expect((await boxOf(rightPanel(page))).width).toBe(512);

  await page.mouse.move(x - 120, y);
  await page.mouse.down();
  await page.mouse.move(x + 400, y, { steps: 4 });
  await page.mouse.up();
  expect((await boxOf(rightPanel(page))).width).toBe(392);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 1000, y, { steps: 4 });
  await page.mouse.up();
  expect((await boxOf(rightPanel(page))).width).toBe(Math.floor(1440 * 0.55));
  await handle.dblclick();
  expect((await boxOf(rightPanel(page))).width).toBe(392);
  await expect.poll(async () => scenario.documents.uiState().panelWidth).toBeNull();

  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "408");
  expect((await boxOf(rightPanel(page))).width).toBe(408);
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "392");
  expect(await overflow(page)).toEqual([0, 0]);
});

test("가격축 방식은 차트의 가격축 옆 묶음 버튼으로 바꾸고 위 막대에는 없다", async ({ page }) => {
  await open(page);
  await expect(toolbar(page).getByRole("button", { name: "로그", exact: true })).toHaveCount(0);
  const pick = (name: string) => axisMode(page).getByRole("button", { name, exact: true });
  await expect(pick("자동")).toHaveAttribute("aria-pressed", "true");
  await pick("로그").click();
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "log");
  await expect(pick("로그")).toHaveAttribute("aria-pressed", "true");
  await pick("%").click();
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "percent");
  await pick("자동").click();
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "normal");
  const group = await boxOf(axisMode(page));
  const chart = await boxOf(cell(page));
  expect(group.x + group.width).toBeLessThan(chart.x + chart.width - 72);
  expect(group.y + group.height).toBeLessThan(900);
});

test("스크리너를 연 1024px 창에서는 위 막대가 창 폭을 쓰며 패널이 그 아래로 내려간다", async ({ page }, info) => {
  await open(page);
  await page.getByRole("tab", { name: /^스크리너/ }).click();
  await page.setViewportSize({ width: 1024, height: 768 });
  const bar = await boxOf(toolbar(page));
  const panel = await boxOf(rightPanel(page));
  expect(bar).toMatchObject({ x: GAP, width: 1024 - GAP * 2 });
  expect(panel.y).toBe(GAP * 2 + 48);
  expect((await boxOf(rail(page))).y).toBe(GAP * 2 + 48);
  expect(await toolbar(page).evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
  expect(await overflow(page)).toEqual([0, 0]);
  await page.screenshot({ path: info.outputPath("1024-shell.png") });

  await page.setViewportSize({ width: 1280, height: 300 });
  expect(await overflow(page)).toEqual([0, 0]);
});
