import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { installChartProbe } from "./chart-probe";
import { cell, chartOf, expect, type Scenario, test } from "./harness";

test.use({ clockStart: "20261109100000", actionTimeout: 10_000 });

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], visibleBars: 40 };
const SIZES = [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 1024, height: 920 }];

function seed(scenario: Scenario, count = 4) {
  const base = scenario.documents.layout();
  const charts: LayoutWindow[] = Array.from({ length: count }, (_, i) => ({ id: `cell-${i}`, kind: "chart", link: null, symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS }));
  scenario.documents.saveLayout({ ...base, windows: [...charts, ...base.windows.filter((window) => window.kind !== "chart")], placement: {}, revision: base.revision + 1 });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: "dock" });
  const watchlists = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ ...watchlists, lists: watchlists.lists.map((list) => ({ ...list, symbols: ["035420", "000660"] })) });
}

async function settle(page: Page, count: number) {
  await page.evaluate(() => document.fonts.ready);
  for (let n = 1; n <= count; n++) {
    await expect(cell(page, n)).toHaveAttribute("aria-busy", "false");
    await expect(chartOf(cell(page, n))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  }
  await expect.poll(() => page.evaluate((count) => window.chartProbes?.length === count && window.chartProbes.every(({ chart }) => chart.chartElement().getBoundingClientRect().height === chart.chartElement().parentElement?.getBoundingClientRect().height && chart.panes().every((pane) => pane.getHTMLElement()?.getBoundingClientRect().height === pane.getHeight())), count)).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const rect = (element: Element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const textRects = (element: Element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const boxes = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim() || !(node.parentElement instanceof HTMLElement) || node.parentElement.closest("[hidden],svg")) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) boxes.push({ text: node.textContent, x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom });
      }
      return boxes;
    };
    return window.chartProbes.map(({ chart }) => {
      const body = chart.chartElement().parentElement;
      const legend = body?.querySelector(".chart-legend");
      const price = legend?.querySelector("[data-price-row]");
      const ohlc = legend?.querySelector("[data-ohlc]");
      const head = legend?.firstElementChild;
      const volume = body?.querySelector("[data-indicator-row]");
      if (!body || !legend || !head || !price || !ohlc || !volume) throw new Error("차트의 정보 행이 없습니다");
      const panes = chart.panes().map((pane) => {
        const element = pane.getHTMLElement();
        if (!element) throw new Error("차트 패널이 없습니다");
        return { ...rect(element), stretch: pane.getStretchFactor() };
      });
      const toolbar = body.querySelector(".drawing-toolbar");
      return {
        body: rect(body), panes,
        rows: { head: { box: rect(head), text: head.textContent, texts: textRects(head) }, price: { box: rect(price), text: price.textContent, texts: textRects(price) }, ohlc: { box: rect(ohlc), text: ohlc.textContent, texts: textRects(ohlc) } },
        venues: [...head.querySelectorAll("button")].map((button) => ({ label: button.getAttribute("aria-label"), ...rect(button) })),
        volume: { box: rect(volume), text: volume.textContent, texts: textRects(volume), commands: [...volume.querySelectorAll("button[data-indicator-command]:not([hidden])")].map((button) => ({ label: button.getAttribute("aria-label"), ...rect(button) })) },
        toolbar: toolbar ? rect(toolbar) : null,
      };
    });
  });
}

type Box = { x: number; y: number; right: number; bottom: number };
const contained = (box: Box, pane: Box) => box.x >= pane.x - 0.5 && box.y >= pane.y - 0.5 && box.right <= pane.right + 0.5 && box.bottom <= pane.bottom + 0.5;
const disjoint = (a: Box, b: Box) => a.right <= b.x + 0.5 || b.right <= a.x + 0.5 || a.bottom <= b.y + 0.5 || b.bottom <= a.y + 0.5;

function readable(charts: Awaited<ReturnType<typeof geometry>>) {
  for (const [index, chart] of charts.entries()) {
    const pane = chart.panes[0];
    const volumePane = chart.panes[1];
    if (!pane || !volumePane) throw new Error("가격과 거래량 패널이 없습니다");
    expect(chart.rows.head.text).toContain("삼성전자");
    expect(chart.rows.head.text).toContain("005930");
    expect(chart.rows.head.text).toContain("일");
    expect(chart.rows.price.text).toMatch(/\d[\d,]+/);
    expect(chart.rows.price.text).toMatch(/2026/);
    expect(chart.rows.ohlc.text).toMatch(/시.+고.+저.+종.+량/);
    expect(chart.volume.text).toContain("거래량");
    for (const row of Object.values(chart.rows)) for (const box of row.texts) expect.soft(contained(box, pane), `chart ${index + 1} text ${box.text} is inside its price pane`).toBe(true);
    for (const [i, row] of Object.values(chart.rows).entries()) for (const later of Object.values(chart.rows).slice(i + 1)) {
      for (const a of row.texts) for (const b of later.texts) expect.soft(disjoint(a, b), `chart ${index + 1} text rows do not overlap`).toBe(true);
    }
    expect(chart.venues.length).toBeGreaterThan(0);
    for (const venue of chart.venues) {
      expect.soft(venue.height, "venue controls retain 24px hit boxes").toBe(24);
      expect.soft(contained(venue, pane), `chart ${index + 1} venue stays in its price pane`).toBe(true);
      for (const row of [chart.rows.price, chart.rows.ohlc]) for (const text of row.texts) expect.soft(disjoint(venue, text), `chart ${index + 1} venue clears other rows`).toBe(true);
    }
    for (const box of [...chart.volume.texts, ...chart.volume.commands]) expect.soft(contained(box, volumePane), `chart ${index + 1} volume text and full action boxes stay inside volume pane`).toBe(true);
    for (const command of chart.volume.commands) expect.soft(command.height, "indicator controls retain 18px hit boxes").toBe(18);
    if (chart.toolbar) for (const box of [...Object.values(chart.rows).flatMap((row) => row.texts), ...chart.venues, ...chart.volume.texts, ...chart.volume.commands]) expect.soft(disjoint(box, chart.toolbar), `chart ${index + 1} toolbar clears text and controls`).toBe(true);
  }
}

test("four chart text and full controls remain readable inside their panes", async ({ page, scenario }, testInfo) => {
  await page.addInitScript(installChartProbe);
  seed(scenario);
  await page.goto("/");
  const captures = [];
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await settle(page, 4);
    const charts = await geometry(page);
    captures.push({ size, charts });
    await page.screenshot({ path: testInfo.outputPath(`readability-${size.width}x${size.height}.png`) });
    await testInfo.attach(`rectangles-${size.width}x${size.height}`, { body: JSON.stringify(charts, null, 2), contentType: "application/json" });
    await expect.poll(() => page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight])).toEqual([0, 0]);
    readable(charts);
  }
  const path = testInfo.outputPath("readability-rectangles.json");
  await writeFile(path, JSON.stringify(captures, null, 2));
  await testInfo.attach("readability-rectangles", { path, contentType: "application/json" });
});
