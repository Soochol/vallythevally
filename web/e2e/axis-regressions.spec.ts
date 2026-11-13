import type { Page } from "@playwright/test";
import { installAxisProbe } from "./axis-probe";
import { chartDisplayOptions, seedChartDisplay } from "./chart-display-fixture";
import { installChartProbe } from "./chart-probe";
import { type Scenario, cell, chartOf, expect, test } from "./harness";

type Axes = ReturnType<Window["axisTexts"]>;

function assertAxes(axes: Axes) {
  expect(axes.length).toBeGreaterThan(0);
  for (const axis of axes) {
    expect(axis.width).toBeLessThanOrEqual(72);
    const labels = axis.texts.toSorted((a, b) => a.y - b.y);
    for (const label of labels) expect(label.x + label.width).toBeLessThanOrEqual(axis.width);
    for (let i = 1; i < labels.length; i++) {
      const a = labels[i - 1]!;
      const b = labels[i]!;
      expect(b.y - a.y, `${a.text} / ${b.text}`).toBeGreaterThanOrEqual((a.height + b.height) / 2 + 1);
    }
  }
}

async function assertRendered(page: Page) {
  await expect(async () => {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assertAxes(await page.evaluate(() => window.axisTexts()));
  }).toPass({ timeout: 3000 });
}

async function open(page: Page) {
  await page.addInitScript(installChartProbe);
  await page.addInitScript(installAxisProbe);
  await page.goto("/");
  await page.getByRole("tablist", { name: "오른쪽 패널" }).hover();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.evaluate(() => window.axisTexts().flatMap((axis) => axis.texts).map((label) => label.text))).toContain("−48.1조");
}

async function yearlyPrices(scenario: Scenario, prices: number[]) {
  const bars = prices.map((price, i) => ({ t: Date.parse(`${2017 - i}-01-01T00:00:00+09:00`) / 1000, o: price, h: price + 100, l: price - 100, c: price, v: 3120000 })).reverse();
  const current = bars.pop() ?? null;
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "000660" && url.searchParams.get("period") === "Y", { body: { symbol: "000660", venue: "combined", period: "Y", bars, current, seq: null, nextBefore: null } });
}

test.describe("축 표시 회귀", () => {
  test.use(chartDisplayOptions);
  for (const broad of [false, true]) test(`퍼센트 첫 화면·전환의 ${broad ? "큰" : "작은"} 등락도 폭과 마지막 값 간격을 유지한다`, async ({ page, scenario }) => {
    await seedChartDisplay(scenario, "Y");
    await yearlyPrices(scenario, broad ? [1297000, 100000, 10000, 1000] : [1297000, 1296000, 1296000, 1296000]);
    await open(page);
    await assertRendered(page);
    await page.getByRole("button", { name: "%", exact: true }).click();
    await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "percent");
    await assertRendered(page);
    await page.reload();
    await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "percent");
    await assertRendered(page);
    await page.setViewportSize({ width: 1024, height: 768 });
    await assertRendered(page);
  });

  test("선형·로그 축과 패널 높이·화면 크기 변경은 실제 y 좌표로 마지막 값과 떨어진다", async ({ page, scenario }) => {
    await seedChartDisplay(scenario, "Y");
    await yearlyPrices(scenario, [1297000, 100000, 10000, 1000]);
    await open(page);
    const originalHeight = await page.evaluate(() => window.chartProbe.chart.panes()[0]!.getHeight());
    for (const log of [true, false, true]) {
      await page.evaluate((height) => window.chartProbe.chart.panes()[0]!.setHeight(height), originalHeight);
      const button = page.getByRole("button", { name: "로그", exact: true });
      if ((await button.getAttribute("aria-pressed") === "true") !== log) await button.click();
      await assertRendered(page);
      const range = await page.evaluate(() => window.chartProbe.chart.timeScale().getVisibleLogicalRange());
      await page.evaluate(() => window.chartProbe.chart.timeScale().setVisibleLogicalRange({ from: 0, to: 2 }));
      await assertRendered(page);
      await page.evaluate((saved) => { if (saved) window.chartProbe.chart.timeScale().setVisibleLogicalRange(saved); }, range);
      await page.evaluate(() => window.chartProbe.chart.panes()[0]!.setHeight(180));
      await assertRendered(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await assertRendered(page);
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  test("확대한 원화 조 눈금은 높은 패널과 크기 변경 뒤에도 서로 다르다", async ({ page, scenario }) => {
    await seedChartDisplay(scenario, "Y");
    await open(page);
    await page.evaluate(() => {
      const pane = window.chartProbe.chart.panes()[2]!;
      pane.setHeight(400);
      pane.priceScale("right").setVisibleRange({ from: -48_140_000_000_000, to: -48_060_000_000_000 });
    });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport);
      await expect(async () => {
        const axis = (await page.evaluate(() => window.axisTexts()))[2]!;
        const ticks = axis.texts.slice(0, -1).map((label) => label.text);
        expect(ticks.length).toBeGreaterThan(1);
        expect(new Set(ticks).size).toBe(ticks.length);
        assertAxes([axis]);
      }).toPass({ timeout: 3000 });
    }
  });
});

test.describe("실시간 눈금 캐시", () => {
  test.use({ clockStart: "20261109100030" });
  test("축 범위가 같은 0B 체결 뒤에도 가격·거래량 눈금 충돌을 다시 계산한다", async ({ page, scenario }) => {
    await page.addInitScript(installChartProbe);
    await page.addInitScript(installAxisProbe);
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect.poll(async () => scenario.live.subscriptions().map(value => value.symbol)).toContain("005930");
    await assertRendered(page);
    const volume = () => page.evaluate(() => {
      const last = window.chartProbe.chart.panes()[1]!.getSeries()[0]!.data().at(-1);
      const current = window.chartProbe.main.dataByIndex(100000, -1);
      return last && current && last.time === current.time && "value" in last && typeof last.value === "number" ? last.value : null;
    });
    await expect(async () => {
      expect(await scenario.live.update("005930", { c: Math.abs(Number("+1297000")), v: Math.abs(Number("1000")) })).toBeGreaterThan(0);
      await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", "1297000", { timeout: 500 });
    }).toPass({ timeout: 15000 });
    await expect.poll(volume).not.toBeNull();
    await page.evaluate(async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    const baseline = await volume();
    expect(baseline).not.toBeNull();
    const before = await page.evaluate(() => window.chartProbe.chart.panes()[1]!.priceScale("right").getVisibleRange());
    for (const cumulative of [16_000_000, 18_000_000]) {
      expect(await scenario.live.update("005930", { c: Math.abs(Number("+1297000")), v: Math.abs(Number(String(cumulative))) })).toBeGreaterThan(0);
      await expect.poll(volume).toBe(cumulative);
      await expect.poll(() => page.evaluate(() => window.axisTexts().flatMap((axis) => axis.texts).map((label) => label.text))).toContain(`${cumulative / 10000}만`);
      expect(await page.evaluate(() => window.chartProbe.chart.panes()[1]!.priceScale("right").getVisibleRange())).toEqual(before);
      await assertRendered(page);
    }
  });
});
