import type { Locator, Page } from "@playwright/test";
import { cell, chartOf, expect, test } from "./harness";

test.use({ clockStart: "20261109100030", viewport: { width: 1440, height: 900 } });

const GAP = 12;
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const rightPanel = (page: Page) => page.locator(".right-panel");
const axisMode = (page: Page) => cell(page).getByRole("group", { name: "가격축 방식" });
const boxOf = async (locator: Locator) => (await locator.boundingBox())!;
const overflow = (page: Page) => page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight]);

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

test("차트는 창 전체 높이를 쓰고 위 막대와 오른쪽 패널은 12px 띄운 섬이며 상태 줄은 패널 바닥에 있다", async ({ page }, info) => {
  await open(page);
  const bar = await boxOf(toolbar(page));
  const panel = await boxOf(rightPanel(page));
  const chart = await boxOf(cell(page));
  expect(chart).toMatchObject({ y: 0, height: 900 });
  expect(bar).toMatchObject({ x: GAP, y: GAP, height: 48 });
  expect(panel.y).toBe(GAP);
  expect(panel.x + panel.width).toBe(1440 - GAP);
  expect(panel.y + panel.height).toBe(900 - GAP);
  expect(bar.x + bar.width).toBe(panel.x - GAP);
  expect(chart.x + chart.width).toBe(panel.x - GAP);
  const status = rightPanel(page).locator("footer");
  await expect(status).toContainText("Lightweight Charts");
  await expect(status.getByLabel("장 상태와 서버 시계")).toBeVisible();
  await expect(page.locator("footer")).toHaveCount(1);
  expect(await overflow(page)).toEqual([0, 0]);
  await page.screenshot({ path: info.outputPath("1440-shell.png") });
});

test("패널을 숨기면 차트와 위 막대가 넓어지고 상태 줄은 차트 왼쪽 아래 띠로 옮겨 간다", async ({ page }, info) => {
  await open(page);
  await page.getByRole("button", { name: "탭 숨기기", exact: true }).click();
  await expect(rightPanel(page)).toHaveCount(0);
  const bar = await boxOf(toolbar(page));
  const chart = await boxOf(cell(page));
  expect(bar.x + bar.width).toBe(1440 - GAP);
  expect(chart.x + chart.width).toBe(1440);
  const status = page.locator("footer");
  await expect(status).toHaveCount(1);
  await expect(status).toContainText("Lightweight Charts");
  const strip = await boxOf(status);
  expect(strip.x).toBeGreaterThan(40);
  expect(strip.y + strip.height).toBeLessThan(900);
  await page.screenshot({ path: info.outputPath("1440-collapsed.png") });
  await toolbar(page).getByRole("button", { name: "패널 펴기", exact: true }).click();
  await expect(rightPanel(page).locator("footer")).toBeVisible();
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

test("넓게 보기 스크리너는 위 막대 아래를 채우고, 1024px 창에서는 위 막대가 창 폭을 쓰며 패널이 그 아래로 내려간다", async ({ page }, info) => {
  await open(page);
  await page.getByRole("tab", { name: /^스크리너/ }).click();
  await page.getByRole("button", { name: "넓게 보기", exact: true }).click();
  const wide = await boxOf(rightPanel(page));
  expect(wide).toMatchObject({ x: GAP, y: GAP * 2 + 48, width: 1440 - GAP * 2 });
  expect((await boxOf(toolbar(page))).width).toBe(1440 - GAP * 2);
  await page.getByRole("button", { name: "오른쪽 탭으로", exact: true }).click();

  await page.setViewportSize({ width: 1024, height: 768 });
  const bar = await boxOf(toolbar(page));
  const panel = await boxOf(rightPanel(page));
  expect(bar).toMatchObject({ x: GAP, width: 1024 - GAP * 2 });
  expect(panel.y).toBe(GAP * 2 + 48);
  expect(await toolbar(page).evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
  expect(await overflow(page)).toEqual([0, 0]);
  await page.screenshot({ path: info.outputPath("1024-shell.png") });

  await page.setViewportSize({ width: 1280, height: 300 });
  expect(await overflow(page)).toEqual([0, 0]);
});
