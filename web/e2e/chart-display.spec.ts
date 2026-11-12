import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FinancialsPage } from "../src/api/generated/FinancialsPage";
import { chartDisplayOptions, seedChartDisplay } from "./chart-display-fixture";
import { installAxisProbe } from "./axis-probe";
import { installChartProbe } from "./chart-probe";
import { cell, chartOf, expect, test } from "./harness";

const SCREENS = path.resolve(import.meta.dirname, "../../target/ux-screens");

test.use(chartDisplayOptions);

test("휴대폰 주기 칩은 늦은 글꼴·앞 칩·선택 칩·줄 크기 변경 뒤에도 완전히 보인다", async ({ page, app }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedChartDisplay(app, "Y");
  let releaseFonts!: () => void;
  const fonts = new Promise<void>((resolve) => { releaseFonts = resolve; });
  let fontRequests = 0;
  await page.route("**/*.woff2", async (route) => { fontRequests++; await fonts; await route.continue(); });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const nav = page.getByRole("navigation", { name: "봉 주기" });
  const selected = nav.getByRole("button", { name: "연", exact: true });
  const snapshots: object[] = [];
  const visible = async (phase: string) => {
    snapshots.push(await nav.evaluate((node, phase) => ({ phase, scrollLeft: node.scrollLeft, nav: node.getBoundingClientRect().toJSON(), chips: [...node.querySelectorAll("button")].map((button) => ({ text: button.textContent, selected: button.getAttribute("aria-pressed"), bounds: button.getBoundingClientRect().toJSON() })) }), phase));
    await expect(selected).toBeInViewport({ ratio: 1, timeout: 3000 });
    const bounds = await selected.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width - 56);
    const viewport = await nav.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(viewport!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width);
  };
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => fontRequests).toBeGreaterThan(0);
    await visible("fallback font");
    releaseFonts();
    await page.evaluate(() => document.fonts.ready);
    await visible("loaded font");
    await nav.getByRole("button").first().evaluate((button) => { button.style.paddingInline = "32px"; });
    await visible("preceding chip widened");
    await selected.evaluate((button) => { button.style.paddingInline = "26px"; });
    await visible("selected chip widened");
    await page.getByRole("button", { name: "지표", exact: true }).evaluate((button) => { button.style.width = "68px"; });
    await visible("scroll viewport narrowed");
    await page.setViewportSize({ width: 360, height: 844 });
    await visible("phone narrowed");
    expect(errors).toEqual([]);
  } finally {
    releaseFonts();
    const evidence = testInfo.outputPath("period-chip-layouts.json");
    await writeFile(evidence, JSON.stringify(snapshots, null, 2));
    await testInfo.attach("period-chip-layouts", { path: evidence, contentType: "application/json" });
  }
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`큰 재무 축·첫 시간 범위·주기 칩 ${viewport.width}×${viewport.height}`, async ({ page, app }) => {
    await page.setViewportSize(viewport);
    await seedChartDisplay(app, "Y");
    await page.addInitScript(installChartProbe);
    await page.addInitScript(installAxisProbe);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect.poll(async () => {
      const data: FinancialsPage = await (await fetch(`${app.url}/api/symbols/000660/financials?period=Y`)).json();
      return data.status;
    }).toBe("ready");
    await expect.poll(() => page.evaluate(() => window.axisTexts().flatMap((axis) => axis.texts).map((label) => label.text))).toContain("−48.1조");
    for (const period of ["Y", "Q"] as const) {
      if (period === "Q") {
        const periods = viewport.width < 768 ? page.getByRole("navigation", { name: "봉 주기" }) : page.getByRole("group", { name: "봉 주기" });
        await periods.getByRole("button", { name: "분기", exact: true }).click();
        await expect(cell(page)).toHaveAttribute("aria-label", /분기$/);
        await expect(cell(page)).toHaveAttribute("aria-busy", "false");
      }
      await expect.poll(() => page.evaluate(() => window.chartProbe.chart.timeScale().getVisibleRange()?.from)).toBe(Date.UTC(2014, 0, 1) / 1000);
      await expect.poll(() => page.evaluate(() => window.chartProbe.chart.timeScale().getVisibleLogicalRange()?.from)).toBeGreaterThanOrEqual(-1);
      const bounds = await page.evaluate(() => {
        const chart = window.chartProbe.chart;
        const bars = chart.timeScale();
        const last = window.chartProbe.main.dataByIndex(100000, -1);
        if (!last) throw new Error("마지막 봉 없음");
        const index = bars.timeToIndex(last.time, false);
        return { range: bars.getVisibleLogicalRange(), index };
      });
      expect(bounds.range!.to).toBeGreaterThanOrEqual(bounds.index! + 0.5);
      expect(bounds.range!.to).toBeLessThanOrEqual(bounds.index! + 0.5 + Math.min(2, Number(await chartOf(cell(page)).getAttribute("data-bar-count")) * 0.05) + 0.001);
      if (viewport.width < 768) {
        const selected = page.getByRole("navigation", { name: "봉 주기" }).locator('[aria-pressed="true"]');
        await expect(selected).toBeInViewport({ ratio: 1 });
        const bounds = await selected.boundingBox();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 56);
      } else {
        await expect.poll(() => page.evaluate(() => window.chartProbe.chart.panes().map((pane) => pane.priceScale("right").width()))).toEqual([72, 72, 72, 72, 72]);
      }
    }
    if (viewport.width < 768) {
      await expect.poll(() => page.evaluate(() => window.chartProbe.chart.priceScale("right").width())).toBeLessThanOrEqual(72);
      const nav = page.getByRole("navigation", { name: "봉 주기" });
      await nav.getByRole("button", { name: "연", exact: true }).click();
      await expect(nav.locator('[aria-pressed="true"]')).toBeInViewport({ ratio: 1 });
      for (const row of await page.locator("[data-indicator-row]").all()) {
        const box = await row.boundingBox();
        const right = await page.evaluate(() => window.chartProbe.chart.priceScale("right").width());
        const chartBox = await chartOf(cell(page)).boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(chartBox!.x + chartBox!.width - right);
      }
    } else {
      await page.getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "연", exact: true }).click();
    }
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    if (viewport.width < 768) await expect.poll(() => page.evaluate(() => window.chartProbe.chart.priceScale("right").width())).toBeLessThanOrEqual(72);
    await expect(async () => {
      const axes = await page.evaluate(() => window.axisTexts());
      expect(axes).toHaveLength(5);
      for (const axis of axes) {
        for (const label of axis.texts) expect(label.x + label.width).toBeLessThanOrEqual(axis.width);
        const sorted = axis.texts.toSorted((a, b) => a.y - b.y);
        for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.y - sorted[i - 1]!.y, JSON.stringify(axis)).toBeGreaterThanOrEqual((sorted[i]!.height + sorted[i - 1]!.height) / 2);
      }
    }).toPass({ timeout: 3000 });
    await mkdir(SCREENS, { recursive: true });
    await page.screenshot({ path: path.join(SCREENS, `chart-display-${viewport.width}x${viewport.height}.png`) });
    if (viewport.width === 1440) {
      await page.setViewportSize({ width: 390, height: 844 });
      const selected = page.getByRole("navigation", { name: "봉 주기" }).getByRole("button", { name: "연", exact: true });
      await expect(selected).toHaveAttribute("aria-pressed", "true");
      await expect(selected).toBeInViewport({ ratio: 1 });
      await expect.poll(() => page.evaluate(() => window.chartProbe.chart.priceScale("right").width())).toBeLessThanOrEqual(72);
    }
    expect(errors).toEqual([]);
  });
}
