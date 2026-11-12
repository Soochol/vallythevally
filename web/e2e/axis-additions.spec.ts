import type { Page } from "@playwright/test";
import { installAxisProbe } from "./axis-probe";
import { installChartProbe } from "./chart-probe";
import { type App, cell, chartOf, expect, test } from "./harness";

declare global { interface Window { axisPaints: number } }

function installPaintCounter() {
  window.axisPaints = 0;
  const fill = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (...args: Parameters<typeof fill>) {
    window.axisPaints++;
    return fill.apply(this, args);
  };
}

async function open(page: Page, app: App, period = "D") {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(installChartProbe);
  await page.addInitScript(installAxisProbe);
  await page.addInitScript(installPaintCounter);
  if (period === "D") await app.fake.respondWith({ apiId: "ka10081", status: 200, body: {
    return_code: 0, return_msg: "synthetic", stk_cd: "005930_AL",
    stk_dt_pole_chart_qry: Array.from({ length: 130 }, (_, i) => ({ dt: new Date(Date.UTC(2026, 10, 6 - i)).toISOString().slice(0, 10).replaceAll("-", ""), open_pric: String(190000 - i * 100), high_pric: String(191000 - i * 100), low_pric: String(189000 - i * 100), cur_prc: String(190500 - i * 100), trde_qty: "1000000" })),
    _headers: { "cont-yn": "N", "next-key": "" },
  } });
  await page.goto(`/?symbol=005930&period=${period}`);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => plotted(page)).toBe(2);
  return errors;
}

const plotted = (page: Page) => page.evaluate(() => window.chartProbe.chart.panes().flatMap((pane) => pane.getSeries()).filter((series) => series.data().length > 0).length);

async function addIndicator(page: Page, label: string, name: string) {
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창", exact: true });
  await dialog.getByRole("combobox", { name: "지표·비교 찾기" }).fill(label);
  await dialog.getByRole("option", { name: `${name} 추가 후보`, exact: true }).click();
  await dialog.getByRole("button", { name: `${name} 추가`, exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-indicator-row]").filter({ hasText: name }).last()).toBeVisible();
}

async function assertDrawing(page: Page, errors: string[]) {
  const paints = await page.evaluate(() => window.axisPaints);
  await page.setViewportSize({ width: 1439, height: 900 });
  await expect.poll(() => page.evaluate(() => window.axisPaints)).toBeGreaterThan(paints);
  await expect.poll(() => page.evaluate(() => window.chartProbe.chart.panes().map((pane) => pane.priceScale("right").width()))).toEqual(await page.evaluate(() => window.chartProbe.chart.panes().map(() => 72)));
  await expect.poll(() => page.evaluate(() => window.axisTexts().filter((axis) => axis.width === 72 && axis.texts.length > 0).length)).toBeGreaterThan(0);
  await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
  expect(errors).toEqual([]);
}

test.use({ financialFixture: true, clockStart: "20261109100030" });

for (const [label, name, lines, period] of [
  ["이동평균", "이동평균 단순 20", 1, "D"],
  ["볼린저 밴드", "볼린저 밴드 20 2", 3, "D"],
  ["일목균형표", "일목균형표 9 26 52 26", 5, "D"],
  ["거래량", "거래량", 2, "D"],
  ["RSI", "RSI 14", 1, "D"],
  ["MACD", "MACD 12 26 9", 3, "D"],
  ["스토캐스틱 슬로우", "스토캐스틱 슬로우 5 3 3", 2, "D"],
  ["매출액", "매출액", 1, "Y"],
] as const) test.describe(label, () => {
  test.use({ clockStart: period === "Y" ? "20171231120000" : "20261109100030" });
  test(`${label} 추가 뒤 오류 없이 차트를 계속 그리고 축 폭 72px를 유지한다`, async ({ page, app }) => {
    const errors = await open(page, app, period);
    const before = await plotted(page);
    await addIndicator(page, label, name);
    await expect.poll(() => plotted(page)).toBe(before + lines);
    await assertDrawing(page, errors);
  });
});

test("비교 종목 추가 뒤 오류 없이 차트를 계속 그리고 축 폭 72px를 유지한다", async ({ page, app }) => {
  const errors = await open(page, app);
  const before = await plotted(page);
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("group", { name: "찾을 항목" }).getByRole("button", { name: "비교 종목", exact: true }).click();
  await dialog.getByRole("combobox", { name: "지표·비교 찾기" }).fill("삼성SDI");
  await dialog.getByRole("option", { name: /삼성SDI/ }).first().click();
  await dialog.getByRole("button", { name: /^삼성SDI.*추가$/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-compare-row="006400"]')).toBeVisible();
  await expect.poll(() => plotted(page)).toBe(before + 1);
  await assertDrawing(page, errors);
});

const trade = (app: App, price: number) => app.fake.pushReal("0B", "005930_AL", { "20": "100032", "10": `+${price}`, "15": "+1", "13": "1000", "9081": "KRX", "11": "+0", "12": "+0.00", "25": "2" });

test.describe("실시간 지표 추가", () => {
  test.use({ clockStart: "20261109100030" });
  test("체결이 들어오는 도중 가격 패널 지표를 추가해도 오류와 그리기 중단이 없다", async ({ page, app }) => {
    const errors = await open(page, app);
    await expect.poll(async () => (await app.fake.registered())["0B"] ?? []).toContain("005930_AL");
    await expect(async () => {
      expect(await trade(app, 195000)).toBeGreaterThan(0);
      await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", "195000", { timeout: 500 });
    }).toPass({ timeout: 15000 });
    const before = await plotted(page);
    let stopped = false;
    let lastPrice = 195000;
    const stream = (async () => {
      while (!stopped) {
        expect(await trade(app, ++lastPrice)).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    try {
      await addIndicator(page, "이동평균", "이동평균 단순 20");
      await expect.poll(() => plotted(page)).toBe(before + 1);
      await assertDrawing(page, errors);
    } finally {
      stopped = true;
      await stream;
    }
    expect(lastPrice).toBeGreaterThan(195001);
    await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", String(lastPrice));
    expect(errors).toEqual([]);
  });
});
