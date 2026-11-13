import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { BarsPage } from "../src/api/generated/BarsPage";
import type { Drawing } from "../src/api/generated/Drawing";
import type { Layout } from "../src/api/generated/Layout";
import { parseChartSettings } from "../src/chart/settings";
import type { DrawingInput } from "../src/api/generated/DrawingInput";
import { installChartProbe } from "./chart-probe";
import { type Scenario, DEFAULT_LAYOUT_ID, cell, chartOf, expect, test } from "./harness";

const LONG_NAME = "TIGER 엔비디아미국채커버드콜밸런스(합성)";
const saved = async (scenario: Scenario): Promise<Drawing[]> => scenario.documents.drawings("005930");

declare global {
  interface Window { legendCrosshair: { x: number; y: number; hasBar: boolean } | null }
}

async function pan(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.mouse.up();
}

for (const history of ["짧은 이력", "끌어서 이동한 이력"]) {
  for (const [key, label] of [["T", "추세선"], ["H", "수평선"], ["V", "선택"]] satisfies [string, string][]) {
    test(`${history}에서 ${label} 도구로 거래소를 눌러도 저장된 드로잉은 바뀌지 않는다`, async ({ page, scenario }) => {
      const data: BarsPage = scenario.market.page({"symbol":"005930","venue":"combined","period":"D","limit":500});
      const bar = data.bars.at(-1);
      if (!bar) throw new Error("가짜 일봉이 없습니다");
      const marker: DrawingInput = { id: "01900000-0000-7000-8000-000000000321", symbol: "005930", tool: "hline", points: [{ t: bar.t, price: bar.c * 0.85 }], text: null, style: {}, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 1 };
      scenario.documents.saveDrawing(marker);
      const before = await saved(scenario);
      const mutations: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/drawings") && request.method() !== "GET") mutations.push(request.method());
      });
      await page.addInitScript(installChartProbe);
      await page.goto("/?symbol=005930");
      await expect(cell(page)).toHaveAttribute("aria-busy", "false");
      await expect.poll(() => chartOf(cell(page)).locator(".drawing-mirror").getAttribute("data-drawings")).toContain(marker.id);
      if (history === "끌어서 이동한 이력") {
        const box = await cell(page).boundingBox();
        if (!box) throw new Error("차트가 없습니다");
        const from = await page.evaluate(() => window.chartProbe.chart.timeScale().getVisibleLogicalRange()?.from);
        await pan(page, { x: box.x + box.width * 0.85, y: box.y + 230 }, { x: box.x + box.width * 0.2, y: box.y + 230 });
        await expect.poll(() => page.evaluate(() => window.chartProbe.chart.timeScale().getVisibleLogicalRange()?.from)).not.toBe(from);
      }
      await cell(page).focus();
      await page.keyboard.press(key);
      const venues = cell(page).getByRole("group", { name: "거래소", exact: true });
      await venues.getByRole("button", { name: "KRX", exact: true }).click({ timeout: 3000 });
      await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 KRX 일");
      await expect(cell(page)).toHaveAttribute("aria-busy", "false");
      await expect(venues.getByRole("button", { name: "KRX", exact: true })).toHaveAttribute("aria-pressed", "true");
      expect(await saved(scenario)).toEqual(before);
      const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/drawings" && response.request().method() === "GET");
      await page.reload();
      await loaded;
      await expect(cell(page)).toHaveAttribute("aria-busy", "false");
      await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 KRX 일");
      await expect.poll(() => chartOf(cell(page)).locator(".drawing-mirror").getAttribute("data-drawings")).toContain(marker.id);
      expect(await saved(scenario)).toEqual(before);
      expect(mutations).toEqual([]);
    });
  }
}

for (const action of ["십자선", "휠 확대", "끌기"]) {
  test(`긴 종목명 위 ${action} 입력은 차트로 전달된다`, async ({ page }, info) => {
    await page.addInitScript(installChartProbe);
    await page.route("**/api/bars?*", (route) => {
      const query = new URL(route.request().url()).searchParams;
      const bars: Bar[] = Array.from({ length: 150 }, (_, i) => {
        const price = 50000 + Math.sin(i / 10) * 2000;
        return { t: Date.UTC(2026, 4, 1) / 1000 - 9 * 3600 + i * 86400, o: price, h: price + 500, l: price - 500, c: price + 100, v: 1000 };
      });
      return route.fulfill({ json: { symbol: query.get("symbol"), venue: query.get("venue"), period: query.get("period"), bars, current: null, nextBefore: null, seq: null } });
    });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/?symbol=0000D0");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "150");
    await page.getByRole("button", { name: "넓게 보기", exact: true }).click();
    const name = cell(page).getByText(LONG_NAME, { exact: true });
    const box = await name.boundingBox();
    const chartBox = await cell(page).boundingBox();
    if (!box || !chartBox) throw new Error("범례 머리가 없습니다");
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const before = await page.evaluate(() => window.chartProbe.chart.timeScale().getVisibleLogicalRange());
    if (!before) throw new Error("차트 범위가 없습니다");
    if (action === "십자선") {
      await page.evaluate(() => {
        window.legendCrosshair = null;
        window.chartProbe.chart.subscribeCrosshairMove(({ point, time }) => { window.legendCrosshair = point ? { x: point.x, y: point.y, hasBar: time !== undefined } : null; });
      });
      await page.mouse.move(at.x, at.y);
      await expect.poll(() => page.evaluate(() => window.legendCrosshair), { timeout: 3000 }).toMatchObject({ hasBar: true });
      const crosshair = await page.evaluate(() => window.legendCrosshair);
      if (!crosshair) throw new Error("십자선이 없습니다");
      expect(Math.abs(crosshair.x - (at.x - chartBox.x))).toBeLessThan(2);
      expect(Math.abs(crosshair.y - (at.y - chartBox.y))).toBeLessThan(2);
    } else if (action === "휠 확대") {
      await page.mouse.move(at.x, at.y);
      const delivered = page.evaluate(() => new Promise<void>((resolve) => {
        document.addEventListener("wheel", () => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), { once: true, capture: true });
      }));
      await page.mouse.wheel(0, -240);
      await delivered;
      await expect.poll(() => page.evaluate(() => {
        const range = window.chartProbe.chart.timeScale().getVisibleLogicalRange();
        return range ? range.to - range.from : null;
      }), { timeout: 3000 }).toBeLessThan(before.to - before.from - 1);
    } else {
      await pan(page, at, { x: at.x + 70, y: at.y });
      await expect.poll(() => page.evaluate((from) => {
        const range = window.chartProbe.chart.timeScale().getVisibleLogicalRange();
        return range ? Math.abs(range.from - from) : 0;
      }, before.from), { timeout: 3000 }).toBeGreaterThan(2);
    }
    expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(cell(page).getByRole("heading", { name: LONG_NAME, exact: true })).toBeVisible();
    await expect(name).not.toHaveAttribute("title");
    await page.screenshot({ path: info.outputPath(`name-${action}.png`) });
  });
}

test("수평선 도구가 켜져도 지표 범례 버튼은 조작하고 드로잉은 바꾸지 않는다", async ({ page, scenario }) => {
  const layout: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const current = layout.cells[0];
  if (!current) throw new Error("칸이 없습니다");
  const settings = parseChartSettings(current.chartSettings);
  settings.indicators.push({ id: "control-ma", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } });
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, cells: [{ ...current, symbol: "005930", venue: "combined", period: "D", chartSettings: settings }] });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const before = await saved(scenario);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/drawings") && request.method() !== "GET") mutations.push(request.method());
  });
  await cell(page).focus();
  await page.keyboard.press("H");
  const row = cell(page).locator('[data-indicator-row="control-ma"]');
  await row.hover();
  const stored = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/layouts/${layout.id}` && response.request().method() === "PUT" && response.ok());
  await row.getByRole("button", { name: /숨기기/ }).click();
  await expect(row.getByRole("button", { name: /보이기/ })).toHaveCount(1);
  await stored;
  expect(await saved(scenario)).toEqual(before);
  await page.reload();
  await expect(row.getByRole("button", { name: /보이기/ })).toHaveCount(1);
  expect(await saved(scenario)).toEqual(before);
  expect(mutations).toEqual([]);
});
