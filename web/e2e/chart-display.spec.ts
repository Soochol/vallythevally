import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Layout } from "../src/api/generated/Layout";
import type { FinancialsPage } from "../src/api/generated/FinancialsPage";
import type { ChartSettings } from "../src/chart/settings";
import { installAxisProbe } from "./axis-probe";
import { installChartProbe } from "./chart-probe";
import { type App, cell, chartOf, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

const METRICS = ["owner_roe", "investing_cash_flow", "dps", "debt_ratio"] as const;
const SCREENS = path.resolve(import.meta.dirname, "../../target/ux-screens");

async function seed(app: App, period: "Q" | "Y") {
  app.dart!.largeValues = true;
  for (const coarse of ["Q", "Y"] as const) await app.fake.respondWith({ apiId: coarse === "Y" ? "ka10094" : "ka10083", status: 200, body: {
    return_code: 0, return_msg: "synthetic", stk_cd: "000660_AL",
    [coarse === "Y" ? "stk_yr_pole_chart_qry" : "stk_mth_pole_chart_qry"]: Array.from({ length: coarse === "Y" ? 4 : 48 }, (_, i) => {
      const date = new Date(Date.UTC(2017, coarse === "Y" ? 0 : 11 - i, 1));
      if (coarse === "Y") date.setUTCFullYear(2017 - i);
      return { dt: date.toISOString().slice(0, 10).replaceAll("-", ""), open_pric: "1277000", high_pric: "1302000", low_pric: "1271000", cur_prc: "1296000", trde_qty: "3120000" };
    }), _headers: { "cont-yn": "N", "next-key": "" },
  } });
  const layout: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
  const chartSettings: ChartSettings = { v: 2, style: "candle", scale: "normal", compare: [], indicators: METRICS.map((kind) => ({
    id: kind, spec: { kind }, panel: kind, visible: true, style: { colors: ["ind-1"], width: 1 },
  })), panels: METRICS.map((id) => ({ id, stretch: 0.3 })) };
  const result = await fetch(`${app.url}/api/layouts/${layout.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...layout, revision: layout.revision + 1, cells: [{ ...layout.cells[0], symbol: "000660", venue: "combined", period, chartSettings }] }) });
  expect(result.ok, await result.text()).toBe(true);
}

test.use({ financialFixture: true, clockStart: "20171231120000", bootReplies: [{ apiId: "ka10099", status: 200, body: {
  return_code: 0, return_msg: "synthetic", list: [
    { code: "005930", name: "삼성전자", marketCode: "0", marketName: "거래소", kind: "A", state: "증거금20%", nxtEnable: "Y", regDay: "19750611", lastPrice: "70000", listCount: "100000" },
    { code: "000660", name: "SK하이닉스", marketCode: "0", marketName: "거래소", kind: "A", state: "증거금20%", nxtEnable: "Y", regDay: "19961226", lastPrice: "1296000", listCount: "100000" },
  ], _headers: { "cont-yn": "N", "next-key": "" },
} }] });

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`큰 재무 축·첫 시간 범위·주기 칩 ${viewport.width}×${viewport.height}`, async ({ page, app }) => {
    await page.setViewportSize(viewport);
    await seed(app, "Y");
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
    const axes = await page.evaluate(() => window.axisTexts());
    expect(axes).toHaveLength(5);
    for (const axis of axes) {
      for (const label of axis.texts) expect(label.x + label.width).toBeLessThanOrEqual(axis.width);
      const sorted = axis.texts.toSorted((a, b) => a.y - b.y);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.y - sorted[i - 1]!.y, JSON.stringify(axis)).toBeGreaterThanOrEqual((sorted[i]!.height + sorted[i - 1]!.height) / 2);
    }
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
