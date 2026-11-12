import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import { parseChartSettings } from "../src/chart/settings";
import { installChartProbe } from "./chart-probe";
import { installFrameProbe } from "./frame-probe";
import { type App, cell, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

async function settings(app: App) {
  const layout: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
  return parseChartSettings(layout.cells[0]!.chartSettings);
}

async function seed(app: App) {
  const layout: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
  const chartSettings = { v: 2, style: "candle", scale: "normal", compare: [], indicators: [
    { id: "ma", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["#C7F36B"], width: 1 } },
    { id: "volume", spec: { kind: "volume", maPeriod: null }, panel: "p-volume", visible: true, style: { colors: ["ind-1"], width: 1 } },
    { id: "rsi", spec: { kind: "rsi", period: 14, signal: null }, panel: "p-rsi", visible: true, style: { colors: ["ind-2"], width: 1 } },
  ], panels: [{ id: "p-volume", stretch: 0.25 }, { id: "p-rsi", stretch: 0.25 }] };
  expect((await fetch(`${app.url}/api/layouts/${layout.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...layout, revision: layout.revision + 1, cells: [{ ...layout.cells[0], symbol: "005930", venue: "combined", period: "D", chartSettings }] }) })).ok).toBe(true);
}

const row = (page: Page, id: string) => cell(page).locator(`[data-indicator-row="${id}"]`);
const heights = (page: Page) => page.evaluate(() => window.chartProbe.chart.panes().map((pane) => pane.getHeight()));
const maLine = (page: Page) => page.evaluate(() => window.frameProbe.snapshot().find((series) => series.type === "Custom" && series.scaleMode !== 2));

async function open(page: Page, app: App) {
  await seed(app);
  await page.addInitScript(installChartProbe);
  await page.addInitScript(installFrameProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(row(page, "ma")).toContainText("이동평균");
  await expect.poll(() => maLine(page).then((line) => line?.data.length ?? 0)).toBeGreaterThan(0);
}

async function resize(page: Page) {
  const handle = cell(page).locator('[data-panel-resize="p-volume"]');
  const box = await handle.boundingBox();
  if (!box) throw new Error("높이 손잡이가 없습니다");
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height / 2 - 45, { steps: 8 });
  await page.mouse.up();
}

test("범례 설정은 기간·색·굵기를 즉시 그리고 Esc로 처음 값과 선을 복원한다", async ({ page, app }) => {
  await open(page, app);
  const original = await maLine(page);
  await row(page, "ma").getByRole("button", { name: /설정 열기/ }).click();
  const popup = page.getByRole("dialog", { name: /이동평균.*설정/ });
  await popup.getByRole("textbox", { name: "기간", exact: true }).fill("10");
  await expect(row(page, "ma")).toContainText("10");
  await expect.poll(() => maLine(page).then((line) => line?.data)).not.toEqual(original?.data);
  await popup.getByRole("button", { name: "선 색상 선택", exact: true }).click();
  const colors = page.getByRole("dialog", { name: "선 색상", exact: true });
  await expect(colors.getByRole("button", { name: /^기본 색상 \d/ })).toHaveCount(48);
  const swatch = colors.getByRole("button", { name: /^기본 색상 1 / });
  const color = (await swatch.getAttribute("aria-label"))!.split(" ").at(-1)!;
  await swatch.click();
  await colors.getByRole("button", { name: "선택", exact: true }).click();
  await popup.getByRole("group", { name: "굵기", exact: true }).getByRole("button", { name: "5", exact: true }).click();
  await expect.poll(() => maLine(page).then((line) => line?.style)).toEqual({ color, width: 5 });
  await expect.poll(async () => (await settings(app)).indicators[0]?.style).toEqual({ colors: [color], width: 5 });
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect.poll(() => maLine(page).then((line) => ({ data: line?.data, style: line?.style }))).toEqual({ data: original?.data, style: original?.style });
  await expect.poll(async () => (await settings(app)).indicators[0]?.spec).toEqual({ kind: "ma", method: "sma", period: 5 });
  await expect.poll(async () => (await settings(app)).indicators[0]?.style).toEqual({ colors: ["#C7F36B"], width: 1 });
  await expect(row(page, "ma").getByRole("button", { name: /설정 열기/ })).toBeFocused();
});

test("높이와 접기를 저장하고 재시작해 복원하며 접힌 패널은 최신 값 한 줄이다", async ({ page, app }) => {
  await open(page, app);
  const before = await heights(page);
  await resize(page);
  await expect.poll(() => heights(page).then((values) => values[1]! - before[1]!)).toBeGreaterThan(35);
  await expect.poll(async () => (await settings(app)).panels[0]?.stretch).toBeGreaterThan(0.25);
  const resized = await heights(page);
  await row(page, "volume").hover();
  await row(page, "volume").getByRole("button", { name: /패널 접기/ }).click();
  await expect.poll(() => heights(page).then((values) => values[1])).toBeLessThanOrEqual(31);
  await expect(row(page, "volume")).toContainText(/거래량.*\d/);
  await expect.poll(async () => (await settings(app)).panels[0]?.collapsed).toBe(true);
  await app.restart();
  await page.reload();
  await expect(row(page, "volume").getByRole("button", { name: /패널 펼치기/ })).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => heights(page).then((values) => values[1])).toBeLessThanOrEqual(31);
  await row(page, "volume").hover();
  await row(page, "volume").getByRole("button", { name: /패널 펼치기/ }).click();
  await expect.poll(() => heights(page).then((values) => Math.abs(values[1]! - resized[1]!))).toBeLessThanOrEqual(2);
  const handle = cell(page).locator('[data-panel-resize="p-volume"]');
  await handle.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => heights(page).then((values) => values[1]! - resized[1]!)).toBeGreaterThan(10);
});

for (const key of ["T", "H"]) {
  test(`${key} 도구에서도 범례·팝오버·손잡이 입력은 드로잉 저장을 바꾸지 않는다`, async ({ page, app }) => {
    await open(page, app);
    const url = `${app.url}/api/drawings?symbol=005930`;
    const before = await (await fetch(url)).json();
    const mutations: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/drawings") && request.method() !== "GET") mutations.push(request.method()); });
    await cell(page).focus(); await page.keyboard.press(key);
    await row(page, "ma").getByRole("button", { name: /설정 열기/ }).click();
    const popup = page.getByRole("dialog", { name: /이동평균.*설정/ });
    await popup.getByRole("textbox", { name: "기간", exact: true }).fill("7");
    await popup.getByRole("button", { name: "선 색상 선택" }).click();
    await page.keyboard.press("Escape");
    await expect(popup).toBeVisible();
    await popup.getByRole("group", { name: "굵기", exact: true }).getByRole("button", { name: "3", exact: true }).click();
    await popup.getByRole("button", { name: "설정 닫기" }).click();
    await row(page, "ma").hover();
    await row(page, "ma").getByRole("button", { name: /숨기기/ }).click();
    await resize(page);
    await row(page, "rsi").hover();
    await row(page, "rsi").getByRole("button", { name: /패널 접기/ }).click();
    await expect.poll(async () => (await settings(app)).panels[1]?.collapsed).toBe(true);
    expect(await (await fetch(url)).json()).toEqual(before);
    expect(mutations).toEqual([]);
    await page.reload();
    await expect(row(page, "ma")).toContainText("7");
    expect(await (await fetch(url)).json()).toEqual(before);
    expect(mutations).toEqual([]);
  });
}

for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`범례 팝오버 화면 ${size.width}×${size.height}`, async ({ page, app }) => {
    await page.setViewportSize(size);
    await open(page, app);
    await row(page, "ma").getByRole("button", { name: /설정 열기/ }).click();
    await expect(page.getByRole("dialog", { name: /이동평균.*설정/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await mkdir(resolve("../target/ux-screens"), { recursive: true });
    await page.screenshot({ path: resolve(`../target/ux-screens/legend-panels-${size.width}x${size.height}.png`) });
  });
}
