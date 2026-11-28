import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { BarsPage } from "../src/api/generated/BarsPage";
import type { ChartSettings } from "../src/chart/settings";
import { DEFAULT_CHART_SETTINGS } from "../src/chart/settings";
import { toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { cell, chartOf, expect, type Scenario, test } from "./harness";
import { installLegendSourceProbe } from "./legend-source-probe";

test.use({ clockStart: "20261109100000" });

function seed(scenario: Scenario, settings: Partial<ChartSettings> = {}) {
  const layout = scenario.documents.layout();
  scenario.documents.saveLayout({ ...layout, windows: [{ id: "cell-0", kind: "chart", link: null, symbol: "005930", venue: "combined", period: "D", chartSettings: { ...DEFAULT_CHART_SETTINGS, visibleBars: 40, ...settings } }], placement: {} });
}

async function frames(page: Page, count = 12) {
  await page.evaluate(async (count) => {
    await document.fonts.ready;
    for (let i = 0; i < count; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, count);
}

async function ready(page: Page) {
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await expect.poll(() => page.evaluate(() => window.legendSources.projections.length)).toBeGreaterThan(0);
  await expect(page.getByRole("contentinfo")).toContainText("저장됨");
  await frames(page, 30);
}

async function hover(page: Page, t: number) {
  const target = await page.evaluate((t) => {
    const { chart } = window.chartProbe;
    const box = chart.chartElement().getBoundingClientRect();
    const x = chart.timeScale().timeToCoordinate(t);
    if (x === null) throw new Error("가리킬 등록 시각이 없습니다");
    return { x: box.x + x, y: box.y + (chart.panes()[0]?.getHeight() ?? 600) * .75 };
  }, toChartTime(t));
  await page.mouse.move(target.x, target.y);
  await frames(page, 2);
}

async function boundedFields(page: Page) {
  const fields = await page.evaluate(() => {
    const projection = window.legendSources.projections.at(-1);
    if (!projection) throw new Error("범례 원천 투영이 없습니다");
    const values: { key: string; text: string; width: number; bound: number; included: boolean }[] = [];
    const sample = (key: string, element: HTMLElement, text = element.textContent ?? "", width = element.getBoundingClientRect().width) => {
      if (element.offsetParent === null) return;
      const bound = projection.fields.find((field) => field.key === key);
      if (!bound) throw new Error(`원천 필드가 없습니다: ${key}`);
      values.push({ key, text, width, bound: bound.width, included: bound.alternatives.includes(text) });
    };
    document.querySelectorAll<HTMLElement>("[data-price-row] > span").forEach((element, i) => sample(`price/${i}`, element));
    document.querySelectorAll<HTMLElement>("[data-ohlc] > span").forEach((element, i) => {
      const label = element.querySelector("i");
      if (!label) throw new Error("봉 값 필드 이름이 없습니다");
      const range = document.createRange();
      range.setStartAfter(label);
      range.setEnd(element, element.childNodes.length);
      sample(`ohlc/${i}`, element, (element.textContent ?? "").slice(label.textContent?.length ?? 0), range.getBoundingClientRect().width);
    });
    document.querySelectorAll<HTMLElement>(".chart-legend [data-indicator-row]").forEach((row) => row.querySelectorAll<HTMLElement>(":scope > span.font-medium > span").forEach((element, i) => sample(`indicator/${row.dataset.indicatorRow}/${i}`, element)));
    document.querySelectorAll<HTMLElement>("[data-compare-row]").forEach((row) => {
      const element = row.querySelector<HTMLElement>(":scope > span.font-medium");
      if (element) sample(`compare/${row.dataset.compareRow}`, element);
    });
    return values;
  });
  for (const field of fields) {
    expect(field.included, `${field.key}: ${field.text} is source-formatted`).toBe(true);
    expect(field.width, `${field.key}: ${field.text} fits its field`).toBeLessThanOrEqual(field.bound + .5);
  }
  return fields;
}

const priceIndicators: ChartSettings["indicators"] = [
  { id: "ma", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } },
  { id: "ichi", spec: { kind: "ichimoku", conversion: 3, base: 5, spanB: 8, displacement: 6 }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 1 } },
  { id: "hidden", spec: { kind: "ma", method: "sma", period: 7 }, panel: "price", visible: false, style: { colors: ["ind-3"], width: 1 } },
];

test("all legend owners bound native main and shifted future fields without hover source or fit work", async ({ page, scenario }, testInfo) => {
  await page.addInitScript(installChartProbe);
  await installLegendSourceProbe(page, true);
  seed(scenario, { indicators: priceIndicators, panels: [], compare: ["000660"], showOhlcChange: true });
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/");
  await ready(page);
  await expect(cell(page).locator('[data-indicator-row="ichi"] > span.font-medium')).toBeEmpty();
  await expect.poll(() => page.evaluate(() => window.legendSources.pendingWorkers.length)).toBeGreaterThan(0);
  const pending = await page.evaluate(() => window.legendSources.projections.at(-1));
  const beforeWorkers = await page.evaluate(() => ({ ...window.legendSources.counts, projections: window.legendSources.projections.length }));
  await page.evaluate(() => { window.legendSources.holdWorkers = false; window.legendSources.pendingWorkers.splice(0).forEach((send) => send()); });
  await expect(cell(page).locator('[data-indicator-row="ichi"] > span.font-medium')).not.toBeEmpty();
  await expect(cell(page).locator('[data-compare-row="000660"]')).not.toHaveAttribute("data-last-t", "");
  await frames(page, 60);
  const afterWorkers = await page.evaluate(() => ({ ...window.legendSources.counts, projections: window.legendSources.projections.length }));
  expect(afterWorkers.base).toBe(beforeWorkers.base);
  expect(afterWorkers.indicator).toBeGreaterThan(beforeWorkers.indicator);
  expect(afterWorkers.projections).toBeGreaterThan(beforeWorkers.projections);
  expect(await scenario.live.update("000660", { c: 777_777, v: 1000 })).toBeGreaterThan(0);
  await frames(page, 30);
  const sameShapeCompare = await page.evaluate(() => ({ ...window.legendSources.counts, projections: window.legendSources.projections.length }));
  expect(sameShapeCompare.base).toBe(afterWorkers.base);
  expect(sameShapeCompare.indicator).toBe(afterWorkers.indicator);
  expect(sameShapeCompare.compare).toBeGreaterThan(afterWorkers.compare);
  expect(sameShapeCompare.projections).toBe(afterWorkers.projections);
  expect(await scenario.live.update("000660", { c: 9_999_999, v: 1000 })).toBeGreaterThan(0);
  await frames(page, 30);
  const afterCompare = await page.evaluate(() => ({ ...window.legendSources.counts, projections: window.legendSources.projections.length }));
  expect(afterCompare.base).toBe(afterWorkers.base);
  expect(afterCompare.indicator).toBe(afterWorkers.indicator);
  expect(afterCompare.compare).toBeGreaterThan(afterWorkers.compare);
  expect(afterCompare.projections).toBeGreaterThan(afterWorkers.projections);
  const before = await page.evaluate(() => ({ counts: { ...window.legendSources.counts }, projections: window.legendSources.projections.length }));
  const source = scenario.market.page({ symbol: "005930", venue: "combined", period: "D" });
  const samples = [];
  for (const bar of source.bars.slice(-25, -5).filter((_, i) => i % 3 === 0)) {
    await hover(page, bar.t);
    samples.push(await boundedFields(page));
  }
  const latest = source.current?.t ?? source.bars.at(-1)?.t;
  if (!latest) throw new Error("현재 봉이 없습니다");
  const future = await page.evaluate((last) => Math.max(...window.legendSources.times.filter((time) => time > last)), latest);
  expect(Number.isFinite(future)).toBe(true);
  await hover(page, future);
  await expect(cell(page).locator("[data-price-row]")).toBeHidden();
  await expect(cell(page).locator('[data-compare-row="000660"] > span.font-medium')).toHaveText("—");
  samples.push(await boundedFields(page));
  await page.mouse.move(0, 0);
  await frames(page, 60);
  samples.push(await boundedFields(page));
  const after = await page.evaluate(() => ({ counts: window.legendSources.counts, projections: window.legendSources.projections }));
  expect(after.counts.base).toBe(before.counts.base);
  expect(after.counts.indicator).toBe(before.counts.indicator);
  expect(after.counts.compare).toBe(before.counts.compare);
  expect(after.counts.fit).toBe(before.counts.fit);
  expect(after.counts.paint).toBeGreaterThan(before.counts.paint);
  expect(after.projections).toHaveLength(before.projections);
  expect(after.projections.every((projection) => projection.safe)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 300 });
  await frames(page, 60);
  await expect(page.locator("[data-chart-overlay-host]")).toHaveAttribute("data-legend-density", "compact");
  const compact = { projection: await page.evaluate(() => window.legendSources.projections.at(-1)), fields: await boundedFields(page) };
  for (const button of await cell(page).locator(".chart-legend button[data-indicator-command]:not([hidden])").all()) {
    await expect(button).toHaveCSS("width", "24px");
    await expect(button).toHaveCSS("height", "24px");
  }
  await page.setViewportSize({ width: 1440, height: 1200 });
  await frames(page, 60);
  const hidden = cell(page).locator('[data-indicator-row="hidden"]');
  await expect(hidden.getByRole("button", { name: /보이기$/ })).toHaveCSS("width", "24px");
  await hidden.hover();
  await hidden.getByRole("button", { name: /보이기$/ }).click();
  await expect(hidden.locator(":scope > span.font-medium")).not.toBeEmpty();
  await cell(page).locator('[data-compare-row="000660"]').hover();
  await cell(page).getByRole("button", { name: "SK하이닉스 비교 종목 지우기", exact: true }).click();
  await expect(cell(page).locator("[data-compare-row]")).toHaveCount(0);
  await frames(page);
  expect(await page.evaluate(() => window.legendSources.projections.at(-1)?.fields.some((field) => field.key.startsWith("compare/")))).toBe(false);
  await writeFile(testInfo.outputPath("combined-native-fields.json"), JSON.stringify({ pending, before, after, future, samples, compact }, null, 2));
  if (process.env.VALLY_E2E_SCREENSHOTS === "1") await page.screenshot({ path: testInfo.outputPath("combined-native.png") });
});

for (const count of [4, 300, 3000]) test(`source ${count} uses bounded projection nodes and narrows immediately on replacement`, async ({ page, scenario }, testInfo) => {
  await page.addInitScript(installChartProbe);
  await installLegendSourceProbe(page);
  seed(scenario, { indicators: [], panels: [], compare: [], showOhlcChange: true });
  const source = scenario.market.page({ symbol: "005930", venue: "combined", period: "D", limit: 3000 });
  const all = [...source.bars, ...(source.current ? [source.current] : [])];
  const first = all[0];
  if (!first) throw new Error("원천 봉이 없습니다");
  const extended = [...Array.from({ length: Math.max(0, count - all.length) }, (_, i) => ({ ...first, t: first.t - (count - all.length - i) * 86400 })), ...all].slice(-count);
  const current = extended.at(-1) ?? null;
  const initial: BarsPage = { ...source, bars: extended.slice(0, -1), current, nextBefore: null };
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "D", { body: initial });
  const weekly = scenario.market.page({ symbol: "005930", venue: "combined", period: "W", limit: 4 });
  const small = [...weekly.bars, ...(weekly.current ? [weekly.current] : [])].map((bar) => ({ ...bar, o: 1, h: 2, l: 1, c: 1, v: 1 }));
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "W", { body: { ...weekly, bars: small.slice(0, -1), current: small.at(-1), nextBefore: null } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await ready(page);
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", String(count));
  await boundedFields(page);
  const before = await page.evaluate(() => ({ counts: { ...window.legendSources.counts }, projection: window.legendSources.projections.at(-1), nodes: document.querySelectorAll("*").length, elements: [...document.querySelectorAll("*")].map((element) => `${element.tagName}:${element.getAttribute("class") ?? ""}`) }));
  expect(before.projection?.fields.find((field) => field.key === "price/0")?.alternatives).toHaveLength(count);
  expect(before.projection?.fields).toHaveLength(9);
  expect(before.projection?.nodes).toBe(32);
  expect(before.projection?.peakNodes).toBe(41);
  for (const bar of extended.slice(-Math.min(count, 20), -1)) await hover(page, bar.t);
  await frames(page, 30);
  const hovered = await page.evaluate(() => ({ counts: { ...window.legendSources.counts }, nodes: document.querySelectorAll("*").length, elements: [...document.querySelectorAll("*")].map((element) => `${element.tagName}:${element.getAttribute("class") ?? ""}`) }));
  expect(hovered.counts.base).toBe(before.counts.base);
  expect(hovered.counts.fit).toBe(before.counts.fit);
  await page.mouse.move(0, 0);
  await frames(page, 12);
  const parked = await page.evaluate(() => ({ nodes: document.querySelectorAll("*").length, elements: [...document.querySelectorAll("*")].map((element) => `${element.tagName}:${element.getAttribute("class") ?? ""}`) }));
  await writeFile(testInfo.outputPath("pointer-nodes.json"), JSON.stringify({ before, hovered, parked }, null, 2));
  expect(parked.nodes).toBe(before.nodes);
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "주", exact: true }).click();
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "4");
  await frames(page, 30);
  await boundedFields(page);
  const narrowed = await page.evaluate(() => window.legendSources.projections.at(-1));
  expect(narrowed?.fields.find((field) => field.key === "price/0")?.alternatives).toHaveLength(4);
  const widths = (projection: typeof narrowed) => projection?.fields.reduce((sum, field) => sum + field.width, 0) ?? 0;
  expect(widths(narrowed)).toBeLessThan(widths(before.projection));
  await page.clock.setSystemTime(new Date("2026-11-09T10:00:00+09:00"));
  scenario.live.status({ realtime: "reconnecting", since: scenario.now / 1000, backfilling: false });
  await expect(cell(page).locator("[data-price-row]")).toContainText("멈춤 10:00");
  await frames(page, 30);
  await boundedFields(page);
  await writeFile(testInfo.outputPath("bounded-source.json"), JSON.stringify({ count, before, hovered, narrowed, stalled: await page.evaluate(() => window.legendSources.projections.at(-1)) }, null, 2));
});

for (const compare of [[], ["005930"]]) test(`range changes without actual comparison entries keep current source families: ${compare.join(",") || "empty"}`, async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  await installLegendSourceProbe(page);
  seed(scenario, { indicators: [], panels: [], compare });
  await page.goto("/");
  await ready(page);
  const before = await page.evaluate(() => ({ ...window.legendSources.counts }));
  await page.evaluate(() => {
    const scale = window.chartProbe.chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    if (!range) throw new Error("차트 범위가 없습니다");
    scale.setVisibleLogicalRange({ from: range.from + 2, to: range.to + 2 });
  });
  await frames(page, 30);
  const after = await page.evaluate(() => window.legendSources.counts);
  expect(after.base).toBe(before.base);
  expect(after.indicator).toBe(before.indicator);
  expect(after.compare).toBe(before.compare);
});
