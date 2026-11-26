import { FinancialFixture } from "./financial-update-helpers";
import type { Page } from "@playwright/test";
import { installAxisProbe } from "./axis-probe";
import { installChartProbe } from "./chart-probe";
import { type Scenario, cell, chartOf, expect, test, pollSaved } from "./harness";
import { useCenterIndicatorWindow } from "./indicator-window";

declare global { interface Window { axisPaints: number } }

function installPaintCounter() {
  window.axisPaints = 0;
  const fill = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (...args: Parameters<typeof fill>) {
    window.axisPaints++;
    return fill.apply(this, args);
  };
}

type BarShape = (daysAgo: number) => { price: number; volume: number };
const DEFAULT_SHAPE: BarShape = (daysAgo) => ({ price: 190500 - daysAgo * 100, volume: 1000000 });

async function open(page: Page, scenario: Scenario, period = "D", shape: BarShape = DEFAULT_SHAPE) {
  useCenterIndicatorWindow(scenario);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(installChartProbe);
  await page.addInitScript(installAxisProbe);
  await page.addInitScript(installPaintCounter);
  if (period === "D") {
    const bars = Array.from({ length: 130 }, (_, i) => {
      const { price, volume } = shape(129 - i);
      return { t: Date.parse("2026-11-06T00:00:00+09:00") / 1000 - (129 - i) * 86400, o: price - 500, h: price + 500, l: price - 1000, c: price, v: volume };
    });
    scenario.reply("/api/bars", { body: { symbol: "005930", venue: "combined", period: "D", bars, current: null, nextBefore: null, seq: null } });
  }
  if (period === "Y") new FinancialFixture(scenario);
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
  await dialog.getByRole("button", { name: "입력창 닫기", exact: true }).click();
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

test.use({ clockStart: "20261109100030" });

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
  test(`${label} 추가 뒤 오류 없이 차트를 계속 그리고 축 폭 72px를 유지한다`, async ({ page, scenario }) => {
    const errors = await open(page, scenario, period);
    const before = await plotted(page);
    await addIndicator(page, label, name);
    await expect.poll(() => plotted(page)).toBe(before + lines);
    await assertDrawing(page, errors);
  });
});

test("비교 종목 추가 뒤 오류 없이 차트를 계속 그리고 축 폭 72px를 유지한다", async ({ page, scenario }) => {
  const errors = await open(page, scenario);
  const before = await plotted(page);
  await page.getByRole("button", { name: "비교", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창", exact: true });
  await dialog.getByRole("combobox", { name: "지표·비교 찾기" }).fill("삼성SDI");
  await dialog.getByRole("option", { name: /삼성SDI/ }).first().click();
  await dialog.getByRole("button", { name: "입력창 닫기", exact: true }).click();
  await expect(page.locator('[data-compare-row="006400"]')).toBeVisible();
  await expect.poll(() => plotted(page)).toBe(before + 1);
  await assertDrawing(page, errors);
});

const AXIS_WIDTH_STEPS = [72, 80, 88];
const axisLabels = (page: Page, pane: number) => page.evaluate(([index, steps]) => window.axisTexts().filter((axis) => steps!.includes(axis.width as number))[index as number]?.texts.map((label) => label.text) ?? [], [pane, AXIS_WIDTH_STEPS] as const);

test.describe("축 표기 규칙", () => {
  test("100만 원대 가격축은 글자를 줄이지 않고 축 폭을 넓혀 쉼표 숫자로 보이고 축 폭 안에 든다", async ({ page, scenario }) => {
    const errors = await open(page, scenario, "D", (daysAgo) => ({ price: 1_160_000 - daysAgo * 2000, volume: 1000000 }));
    await expect.poll(() => axisLabels(page, 0).then((labels) => labels.length)).toBeGreaterThan(2);
    const axis = () => page.evaluate((steps) => window.axisTexts().find((candidate) => steps.includes(candidate.width)), AXIS_WIDTH_STEPS);
    const texts = async () => (await axis())?.texts ?? [];
    await expect.poll(async () => (await texts()).every((label) => /^[\d,]+$/.test(label.text))).toBe(true);
    const labels = await texts();
    const width = (await axis())!.width;
    expect(width).toBeGreaterThan(72);
    for (const label of labels) {
      expect(label.text).toMatch(/^\d{1,3}(,\d{3})+$/);
      expect(label.text).not.toMatch(/[만KMBT]/);
      expect(label.x + label.width).toBeLessThanOrEqual(width);
    }
    expect(labels.some((label) => label.text.length === 9)).toBe(true);
    expect(new Set(labels.map((label) => label.text)).size).toBe(labels.length);
    const ys = labels.map((label) => label.y).sort((a, b) => a - b);
    ys.slice(1).forEach((y, i) => expect(y - ys[i]!).toBeGreaterThan(labels[0]!.height));
    const fontSize = await page.evaluate(() => window.chartProbe.chart.options().layout.fontSize);
    expect(fontSize).toBe(11);
    expect(errors).toEqual([]);
  });

  test("6자리 가격 종목의 축 글자 크기는 기본 11px 그대로다", async ({ page, scenario }) => {
    const errors = await open(page, scenario);
    await expect.poll(() => axisLabels(page, 0).then((labels) => labels.length)).toBeGreaterThan(2);
    expect(await page.evaluate(() => window.chartProbe.chart.options().layout.fontSize)).toBe(11);
    for (const label of await axisLabels(page, 0)) expect(label).toMatch(/^[\d,]+$/);
    expect(errors).toEqual([]);
  });

  test("거래량 3천만~2억 자료의 거래량축은 M 단위 하나이고 만·억이 없다", async ({ page, scenario }) => {
    const errors = await open(page, scenario, "D", (daysAgo) => ({ price: 190500 - daysAgo * 100, volume: 30_000_000 + (129 - daysAgo) * 1_300_000 }));
    await expect.poll(() => axisLabels(page, 1).then((labels) => labels.length)).toBeGreaterThan(1);
    const labels = (await axisLabels(page, 1)).slice(0, -1).filter((label) => label !== "0");
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label).toMatch(/^\d+(\.\d+)?M$/);
    for (const label of await axisLabels(page, 1)) expect(label).not.toMatch(/[만억조]/);
    expect(errors).toEqual([]);
  });
});

const trade = (scenario: Scenario, price: number) => scenario.live.update("005930", { c: Math.abs(Number(`+${price}`)), v: Math.abs(Number("1000")) });

test.describe("실시간 지표 추가", () => {
  test.use({ clockStart: "20261109100030" });
  test("체결이 들어오는 도중 가격 패널 지표를 추가해도 오류와 그리기 중단이 없다", async ({ page, scenario }) => {
    const errors = await open(page, scenario);
    await pollSaved(async () => scenario.live.subscriptions().map(value => value.symbol)).toContain("005930");
    await expect(async () => {
      expect(await trade(scenario, 195000)).toBeGreaterThan(0);
      await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", "195000", { timeout: 500 });
    }).toPass({ timeout: 15000 });
    const before = await plotted(page);
    let stopped = false;
    let lastPrice = 195000;
    const stream = (async () => {
      while (!stopped) {
        expect(await trade(scenario, ++lastPrice)).toBeGreaterThan(0);
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
