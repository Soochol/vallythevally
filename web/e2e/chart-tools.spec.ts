import type { Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import { installChartProbe } from "./chart-probe";
import { installFrameProbe } from "./frame-probe";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, pollSaved, test, withFirstChart } from "./harness";

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const settingsButton = (page: Page) => toolbar(page).getByRole("button", { name: "차트 설정", exact: true });
const settingsPopover = (page: Page) => page.getByRole("dialog", { name: "차트 설정", exact: true });
const indicatorButton = (page: Page) => toolbar(page).getByRole("button", { name: "지표", exact: true });
const commandDialog = (page: Page) => page.getByRole("dialog", { name: "지표·비교 입력창", exact: true });
const inspector = (page: Page) => page.getByRole("region", { name: "지표", exact: true });
const colorWindow = (page: Page) => page.getByRole("dialog", { name: "선 색", exact: true });
const legendRow = (page: Page, id: string) => cell(page).locator(`[data-indicator-row="${id}"]`);

const saveIndicatorWindow = (scenario: Scenario, indicatorWindow: "dialog" | "inspector" | null) =>
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), indicatorWindow });

function seedMovingAverage(scenario: Scenario) {
  const layout: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chartSettings = { v: 2, style: "candle", scale: "normal", compare: [], indicators: [
    { id: "ma", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-3"], width: 1 } },
  ], panels: [] };
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "D", chartSettings }) });
}

async function open(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.addInitScript(installChartProbe);
  await page.addInitScript(installFrameProbe);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

const mainSeriesTypes = (page: Page) => page.evaluate(() => window.frameProbe.snapshot().filter((series) => series.data.length > 100).map((series) => series.type));

test("1280x600에서 차트 설정 창은 화면 가운데에 다 들어오고 폭이 360px 이하이다", async ({ page }) => {
  await open(page, { width: 1280, height: 600 });
  await settingsButton(page).click();
  await expect(settingsPopover(page)).toBeVisible();
  const popover = (await settingsPopover(page).boundingBox())!;
  expect(popover.width).toBeLessThanOrEqual(360);
  expect(popover.x).toBeGreaterThanOrEqual(0);
  expect(popover.x + popover.width).toBeLessThanOrEqual(1280);
  expect(popover.y).toBeGreaterThanOrEqual(0);
  expect(popover.y + popover.height).toBeLessThanOrEqual(600);
  expect(Math.abs(popover.x + popover.width / 2 - 1280 / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(popover.y + popover.height / 2 - 600 / 2)).toBeLessThanOrEqual(2);
  await expect(settingsPopover(page).locator("xpath=..")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  for (const groupName of ["봉 모양", "가격 축"] as const) {
    const group = settingsPopover(page).getByRole("group", { name: groupName, exact: true });
    const selected = group.locator("[aria-pressed=true]");
    const groupBox = (await group.boundingBox())!;
    const itemBox = (await selected.boundingBox())!;
    const topGap = itemBox.y - groupBox.y;
    const bottomGap = groupBox.y + groupBox.height - (itemBox.y + itemBox.height);
    const leftGap = itemBox.x - groupBox.x;
    expect(topGap).toBeGreaterThanOrEqual(2);
    expect(Math.abs(topGap - bottomGap)).toBeLessThanOrEqual(1);
    expect(leftGap).toBeGreaterThanOrEqual(2);
  }
  await expect(settingsPopover(page).getByRole("region", { name: "지표 창", exact: true })).toBeInViewport();
});

test("800px에서 더 보기로 연 차트 설정 창도 화면 가운데에서 열린다", async ({ page }) => {
  await open(page, { width: 800, height: 900 });
  const more = toolbar(page).getByRole("button", { name: "더 보기", exact: true });
  await more.click();
  await page.getByRole("menuitem", { name: "차트 설정", exact: true }).click();
  await expect(settingsPopover(page)).toBeVisible();
  const popover = (await settingsPopover(page).boundingBox())!;
  expect(Math.abs(popover.x + popover.width / 2 - 800 / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(popover.y + popover.height / 2 - 900 / 2)).toBeLessThanOrEqual(2);
  await page.setViewportSize({ width: 900, height: 900 });
  await expect.poll(async () => {
    const box = (await settingsPopover(page).boundingBox())!;
    return Math.abs(box.x + box.width / 2 - 900 / 2);
  }).toBeLessThanOrEqual(2);
});

test("봉 모양을 바꾸면 팝오버가 열린 채 차트에 바로 반영된다", async ({ page }) => {
  await open(page, { width: 1440, height: 900 });
  await expect.poll(() => mainSeriesTypes(page)).not.toContain("Line");
  await settingsButton(page).click();
  const style = settingsPopover(page).getByRole("group", { name: "봉 모양", exact: true });
  await style.getByRole("button", { name: "라인", exact: true }).click();
  await expect(settingsPopover(page)).toBeVisible();
  await expect(style.getByRole("button", { name: "라인", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => mainSeriesTypes(page)).toContain("Line");
  await style.getByRole("button", { name: "캔들", exact: true }).click();
  await expect(settingsPopover(page)).toBeVisible();
  await expect.poll(() => mainSeriesTypes(page)).not.toContain("Line");
});

test("1440px에서 저장된 선택이 없으면 지표 버튼이 차트 옆 지표 창을 열고 가운데 창을 고른 사용자는 가운데 창이 열린다", async ({ page, scenario }) => {
  expect(scenario.documents.uiState()).not.toHaveProperty("indicatorWindow");
  await open(page, { width: 1440, height: 900 });
  await indicatorButton(page).click();
  await expect(inspector(page)).toBeVisible();
  await expect(commandDialog(page)).toHaveCount(0);

  await settingsButton(page).click();
  const windows = settingsPopover(page).getByRole("group", { name: "지표 창", exact: true });
  await expect(windows.getByRole("button", { name: "차트 옆", exact: true })).toHaveAttribute("aria-pressed", "true");
  await windows.getByRole("button", { name: "가운데 창", exact: true }).click();
  await pollSaved(() => scenario.documents.uiState().indicatorWindow).toBe("dialog");
  await settingsPopover(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(settingsPopover(page)).toBeHidden();
  await indicatorButton(page).click();
  await expect(commandDialog(page)).toBeVisible();
});

test("가운데 지표 창은 폭이 760px 이하로 화면 가운데에 열리고 흐림 필터와 하단 적용 버튼이 없다", async ({ page, scenario }) => {
  saveIndicatorWindow(scenario, "dialog");
  await open(page, { width: 1440, height: 900 });
  await indicatorButton(page).click();
  const dialog = commandDialog(page);
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(760);
  expect(Math.abs(box.x + box.width / 2 - 1440 / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.y + box.height / 2 - 900 / 2)).toBeLessThanOrEqual(2);
  expect(await dialog.evaluate((node) => getComputedStyle(node).backdropFilter)).toBe("none");
  await expect(dialog.locator("xpath=..")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(dialog.getByRole("button", { name: "거래량 설정", exact: true })).toBeVisible();
  const footer = dialog.locator("footer");
  await expect(footer.getByText("Tab", { exact: true })).toBeVisible();
  await expect(footer.getByRole("button")).toHaveCount(0);
  await dialog.getByRole("tab", { name: "비교 종목", exact: true }).click();
  await expect(footer.getByText("Tab", { exact: true })).toHaveCount(0);
  await expect(footer.getByRole("button")).toHaveCount(0);
});

test("범례에서 연 지표 팝오버는 높이가 360px 이하이고 색 더 보기를 누르면 색상표가 보인다", async ({ page, scenario }) => {
  saveIndicatorWindow(scenario, "dialog");
  seedMovingAverage(scenario);
  await open(page, { width: 1440, height: 900 });
  await expect(legendRow(page, "ma")).toContainText("이동평균");
  await legendRow(page, "ma").getByRole("button", { name: /설정 열기/ }).click();
  const popup = page.getByRole("dialog", { name: /이동평균.*설정/ });
  await expect(popup).toBeVisible();
  expect((await popup.boundingBox())!.height).toBeLessThanOrEqual(360);
  const palette = popup.getByRole("group", { name: "색상표", exact: true });
  await expect(palette).toHaveCount(0);
  await expect(popup.getByRole("group", { name: "테마 색", exact: true })).toBeVisible();
  await popup.getByRole("button", { name: "색 더 보기", exact: true }).click();
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("button")).toHaveCount(40);
  expect((await popup.boundingBox())!.height).toBeLessThanOrEqual(360);
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await legendRow(page, "ma").getByRole("button", { name: /설정 열기/ }).click();
  await expect(page.getByRole("dialog", { name: /이동평균.*설정/ }).getByRole("group", { name: "색상표", exact: true })).toBeVisible();
});

test("지표와 드로잉에서 연 색 창의 제목이 같다", async ({ page, scenario }) => {
  saveIndicatorWindow(scenario, "dialog");
  await open(page, { width: 1440, height: 900 });
  await indicatorButton(page).click();
  const command = commandDialog(page);
  await command.getByRole("tab", { name: "지표 추가", exact: true }).click();
  await command.getByRole("button", { name: "직접 고르기", exact: true }).click();
  await expect(colorWindow(page)).toBeVisible();
  const indicatorTitle = await colorWindow(page).getByRole("heading").first().textContent();
  await page.keyboard.press("Escape");
  await expect(colorWindow(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(command).toHaveCount(0);

  const chart = (await chartOf(cell(page)).boundingBox())!;
  await cell(page).focus();
  await page.keyboard.press("T");
  await page.mouse.move(chart.x + chart.width * 0.76, chart.y + chart.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(chart.x + chart.width * 0.86, chart.y + chart.height * 0.25, { steps: 10 });
  await page.mouse.up();
  await page.getByRole("toolbar", { name: "드로잉 스타일" }).getByRole("button", { name: "선 색 선택", exact: true }).click();
  await expect(colorWindow(page)).toBeVisible();
  const drawingTitle = await colorWindow(page).getByRole("heading").first().textContent();
  expect(indicatorTitle).toBe("선 색");
  expect(drawingTitle).toBe(indicatorTitle);
  const topbar = (await toolbar(page).boundingBox())!;
  expect((await colorWindow(page).boundingBox())!.y).toBeGreaterThanOrEqual(topbar.y + topbar.height);
});
