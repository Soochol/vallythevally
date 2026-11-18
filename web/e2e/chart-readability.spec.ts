import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { toChartTime } from "../src/chart/time";
import { TOOLS } from "../src/chart/drawings/tools";
import { installChartProbe } from "./chart-probe";
import { expandDock } from "./drawing-probe";
import { cell, chartOf, expect, type Scenario, test, pickDesktopVenue, expectDesktopVenue, pollSaved } from "./harness";

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
  let last = "";
  let stable = 0;
  await expect.poll(async () => {
    const now = JSON.stringify(await geometry(page));
    stable = now === last ? stable + 1 : 0;
    last = now;
    return stable;
  }).toBeGreaterThanOrEqual(3);
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
        return { ...rect(element), right: body.getBoundingClientRect().left + chart.timeScale().width(), stretch: pane.getStretchFactor() };
      });
      const chartBox = chart.chartElement().getBoundingClientRect();
      const timeAxis = { x: chartBox.x, y: chartBox.bottom - chart.timeScale().height(), right: chartBox.right, bottom: chartBox.bottom };
      return {
        body: rect(body), panes, timeAxis,
        rows: { head: { box: rect(head), text: head.textContent, texts: textRects(head) }, price: { box: rect(price), text: price.textContent, texts: textRects(price) }, ohlc: { box: rect(ohlc), text: ohlc.textContent, texts: textRects(ohlc) } },
        volume: { box: rect(volume), text: volume.textContent, texts: textRects(volume), commands: [...volume.querySelectorAll("button[data-indicator-command]:not([hidden])")].map((button) => ({ label: button.getAttribute("aria-label"), ...rect(button) })) },
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
    expect.soft(contained(chart.volume.box, volumePane), `chart ${index + 1} volume row stays inside volume pane`).toBe(true);
    for (const box of [...chart.volume.texts, ...chart.volume.commands]) expect.soft(contained(box, volumePane), `chart ${index + 1} volume text and full action boxes stay inside volume pane`).toBe(true);
    for (const command of chart.volume.commands) {
      expect.soft(command.height, "indicator controls retain 18px hit boxes").toBe(18);
      expect.soft(command.width, "indicator controls retain 18px hit boxes").toBe(18);
    }
    const priceBoxes = [...Object.values(chart.rows).flatMap((row) => row.texts)];
    const volumeBoxes = [...chart.volume.texts, ...chart.volume.commands];
    for (const box of [...priceBoxes, ...volumeBoxes]) expect.soft(disjoint(box, chart.timeAxis), `chart ${index + 1} text and controls clear time axis`).toBe(true);
    for (const priceBox of priceBoxes) for (const volumeBox of volumeBoxes) expect.soft(disjoint(priceBox, volumeBox), `chart ${index + 1} price and volume text and controls do not overlap`).toBe(true);
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

const storedDocuments = (scenario: Scenario) => JSON.stringify({ layout: scenario.documents.layout(), ui: scenario.documents.uiState() });

const storedPresentation = (scenario: Scenario) => JSON.stringify({ placement: scenario.documents.layout().placement, charts: scenario.documents.layout().windows.filter((window) => window.kind === "chart").map((window) => window.chartSettings), drawing: scenario.documents.uiPrefs().drawing });

for (const pinned of [false, true]) test(`short canvas rail retains help and ${pinned ? "folded pinned tools" : "default tools"} without touching saved state`, async ({ page, scenario }) => {
  const base = scenario.documents.layout();
  scenario.documents.saveLayout({ ...base, revision: base.revision + 1,
    windows: [{ id: "cell-0", kind: "chart", link: null, symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS }],
    placement: { v: 1, dock: null, canvas: { rects: { "cell-0": { x: .02, y: .02, w: .28, h: .32 } }, order: ["cell-0"] } },
  });
  const state = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...state, layoutMode: "canvas", drawing: { ...scenario.documents.uiPrefs().drawing, pinnedTools: pinned ? TOOLS.map((tool) => tool.tool) : [] } });
  await page.addInitScript(installChartProbe);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  await settle(page, 1);
  await quietPresentation(page);
  const saved = storedPresentation(scenario);
  const documents = storedDocuments(scenario);
  const dock = await expandDock(page);
  const help = dock.getByRole("button", { name: "드로잉 단축키 도움말", exact: true });
  const fullyInside = async (button: ReturnType<typeof dock.getByRole>) => {
    await expect.poll(() => button.evaluate((element) => {
      const bar = element.closest("nav")?.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return bar !== undefined && box.left >= bar.left && box.right <= bar.right && box.top >= bar.top && box.bottom <= bar.bottom && element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    })).toBe(true);
  };
  await fullyInside(help);
  await help.click();
  await expect(page.getByRole("dialog", { name: "드로잉 단축키", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "도움말 닫기", exact: true }).click();
  if (pinned) {
    const folded = dock.getByRole("button", { name: "고정 도구 펼치기", exact: true });
    await fullyInside(folded);
    await folded.click();
    const last = TOOLS.at(-1);
    if (!last) throw new Error("고정 도구가 없습니다");
    await page.getByRole("menu", { name: "고정 도구", exact: true }).getByRole("menuitem", { name: last.label, exact: false }).click();
  }
  expect(storedPresentation(scenario)).toBe(saved);
  expect(storedDocuments(scenario)).toBe(documents);
  await pickDesktopVenue(page, "KRX");
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 KRX 일");
  await pollSaved(() => scenario.documents.layout().windows.find((window) => window.kind === "chart")?.venue).toBe("combined");
  await pollSaved(() => scenario.documents.uiState().venue).toBe("krx");
  await pickDesktopVenue(page, "통합");
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
  await pollSaved(() => scenario.documents.uiState().venue).toBe("combined");
  await settle(page, 1);
  await fullyInside(help);
  await help.click();
  await expect(page.getByRole("dialog", { name: "드로잉 단축키", exact: true })).toBeVisible();
});


async function quietPresentation(page: Page) {
  await page.mouse.move(0, 0);
  await expect.poll(() => page.evaluate(async () => {
    let mutations = 0;
    const observer = new MutationObserver((records) => { mutations += records.length; });
    for (const host of document.querySelectorAll("[data-chart-overlay-host]")) observer.observe(host, { attributes: true, attributeFilter: ["data-legend-density", "style"] });
    for (let n = 0; n < 12; n++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    observer.disconnect();
    return mutations;
  })).toBe(0);
}

test("compact controls support hover, keyboard, venue, settings, collapse, toolbar end and OHLC updates", async ({ page, scenario }, testInfo) => {
  await page.addInitScript(installChartProbe);
  seed(scenario);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  await settle(page, 4);
  readable(await geometry(page));
  const current = cell(page);
  await pickDesktopVenue(page, "KRX");
  await expect(current).toHaveAttribute("aria-label", "칸 1: 삼성전자 KRX 일");
  await expectDesktopVenue(page, "KRX");
  await pickDesktopVenue(page, "통합");
  await settle(page, 4);
  const volume = current.locator("[data-indicator-row]");
  await volume.hover();
  const collapse = volume.getByRole("button", { name: "거래량 패널 접기", exact: true });
  await expect(collapse.locator("..")).toHaveCSS("opacity", "1");
  const name = volume.getByRole("button", { name: "거래량 설정 열기", exact: true });
  await name.focus();
  await page.keyboard.press("Tab");
  await expect(collapse).toBeFocused();
  await expect(collapse.locator("..")).toHaveCSS("opacity", "1");
  readable(await geometry(page));
  await name.click();
  const dialog = page.getByRole("dialog", { name: "거래량 설정" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("거래량");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await collapse.click();
  const expand = volume.getByRole("button", { name: "거래량 패널 펼치기", exact: true });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await settle(page, 4);
  await writeFile(testInfo.outputPath("collapsed-rectangles.json"), JSON.stringify(await geometry(page), null, 2));
  readable(await geometry(page));
  await expand.click();
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await settle(page, 4);
  readable(await geometry(page));
  const help = (await expandDock(page)).getByRole("button", { name: "드로잉 단축키 도움말", exact: true });
  await help.scrollIntoViewIfNeeded();
  await help.click();
  await expect(page.getByRole("dialog", { name: "드로잉 단축키", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "도움말 닫기", exact: true }).click();
  const ohlc = current.locator("[data-ohlc]");
  const before = await ohlc.textContent();
  const hoverBar = scenario.market.page({ symbol: "005930", venue: "combined", period: "D" }).bars.at(-20);
  if (!hoverBar) throw new Error("가리킬 봉이 없습니다");
  const target = await page.evaluate((time) => {
    const { chart } = window.chartProbes[0] ?? window.chartProbe;
    const box = chart.chartElement().getBoundingClientRect();
    const x = chart.timeScale().timeToCoordinate(time);
    if (x === null) throw new Error("가리킬 봉이 화면에 없습니다");
    return { x: box.x + x, y: box.y + (chart.panes()[0]?.getHeight() ?? 78) / 2 };
  }, toChartTime(hoverBar.t));
  await page.mouse.move(target.x, target.y);
  await expect(ohlc).not.toHaveText(before ?? "");
  readable(await geometry(page));
  await quietPresentation(page);
});

test("tall normal charts and repeated resize restore geometry and saved presentation", async ({ page, scenario }, testInfo) => {
  await page.addInitScript(installChartProbe);
  seed(scenario, 1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await settle(page, 1);
  await quietPresentation(page);
  const normal = await geometry(page);
  await writeFile(testInfo.outputPath("tall-normal-rectangles.json"), JSON.stringify(normal, null, 2));
  readable(normal);
  const legend = cell(page).locator(".chart-legend");
  await expect(legend.locator("[data-price-row]>span").first()).toHaveCSS("font-size", "28px");
  await expect(legend.getByRole("heading")).toHaveCSS("font-size", "17px");
  await expect(legend).toHaveCSS("gap", "8px");
  const saved = storedPresentation(scenario);
  const documents = storedDocuments(scenario);
  for (let n = 0; n < 2; n++) {
    await page.setViewportSize({ width: 1280, height: 300 });
    await settle(page, 1);
    await writeFile(testInfo.outputPath(`short-${n}-rectangles.json`), JSON.stringify(await geometry(page), null, 2));
    readable(await geometry(page));
    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page, 1);
    await quietPresentation(page);
    expect(await geometry(page)).toEqual(normal);
    expect(storedPresentation(scenario)).toBe(saved);
    expect(storedDocuments(scenario)).toBe(documents);
  }
  const path = testInfo.outputPath("tall-normal.png");
  await page.screenshot({ path });
  await testInfo.attach("tall-normal", { path, contentType: "image/png" });
});

test("full pinned rail restores its capacity and saved state after a short resize", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  seed(scenario);
  const state = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...state, drawing: { ...scenario.documents.uiPrefs().drawing, pinnedTools: TOOLS.map((tool) => tool.tool) }, revision: state.revision + 1 });
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.goto("/");
  await settle(page, 4);
  await quietPresentation(page);
  const dock = page.getByRole("navigation", { name: "드로잉 도구" });
  const normal = await geometry(page);
  readable(normal);
  const capacity = await dock.locator(".draw-pinned [data-active-tool]").count();
  expect(capacity).toBeGreaterThan(1);
  const saved = storedPresentation(scenario);
  const documents = storedDocuments(scenario);
  for (let n = 0; n < 2; n++) {
    await page.setViewportSize({ width: 1024, height: 768 });
    await settle(page, 4);
    await quietPresentation(page);
    readable(await geometry(page));
    expect(await dock.locator(".draw-pinned [data-active-tool]").count()).toBeLessThan(capacity);
    const help = dock.getByRole("button", { name: "드로잉 단축키 도움말", exact: true });
    await expect(help).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1600 });
    await settle(page, 4);
    await quietPresentation(page);
    expect(await dock.locator(".draw-pinned [data-active-tool]").count()).toBe(capacity);
    expect(await geometry(page)).toEqual(normal);
    expect(storedPresentation(scenario)).toBe(saved);
    expect(storedDocuments(scenario)).toBe(documents);
  }
});

test("rail fold boundary keeps stable frames and real help", async ({ page, scenario }, testInfo) => {
  await page.addInitScript(installChartProbe);
  seed(scenario, 1);
  const base = scenario.documents.layout();
  scenario.documents.saveLayout({ ...base, windows: base.windows.filter((window) => window.kind === "chart"), placement: { v: 1, dock: null, canvas: { rects: { "cell-0": { x: .02, y: .02, w: .5, h: .38 } }, order: ["cell-0"] } } });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: "canvas", drawing: { ...scenario.documents.uiPrefs().drawing, pinnedTools: TOOLS.map((tool) => tool.tool) } });
  await page.setViewportSize({ width: 1015, height: 768 });
  await page.goto("/");
  await settle(page, 1);
  const dock = page.getByRole("navigation", { name: "드로잉 도구" });
  const folded = dock.getByRole("button", { name: "고정 도구 펼치기", exact: true });
  await expandDock(page);
  await folded.click();
  await expect(page.getByRole("menu", { name: "고정 도구", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  const repeated = [];
  for (const height of [768, 769, 800, 769]) {
    await page.setViewportSize({ width: 1015, height });
    const frames = await page.evaluate(async () => {
      const samples = [];
      for (let i = 0; i < 60; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        samples.push({ rail: document.querySelector(".drawing-toolbar")?.getBoundingClientRect().toJSON(), pinned: document.querySelectorAll(".drawing-toolbar .draw-pinned [data-active-tool]").length });
      }
      return samples;
    });
    expect(new Set(frames.slice(15).map((frame) => JSON.stringify(frame))).size).toBe(1);
    repeated.push({ height, frames });
  }
  await writeFile(testInfo.outputPath("repeated-rail-frames.json"), JSON.stringify(repeated, null, 2));
  const help = dock.getByRole("button", { name: "드로잉 단축키 도움말", exact: true });
  await help.click();
  await expect(page.getByRole("dialog", { name: "드로잉 단축키", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "도움말 닫기", exact: true }).click();
});

