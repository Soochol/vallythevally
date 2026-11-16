import { writeFile } from "node:fs/promises";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { cell, chartOf, expect, test } from "./harness";
import { installChartProbe } from "./chart-probe";
import { expandDock, pickTool, settledMirror } from "./drawing-probe";

test.use({ clockStart: "20261109100030", viewport: { width: 1440, height: 900 } });

const dock = (page: Page) => page.getByRole("navigation", { name: "드로잉 도구" });
const boxOf = async (locator: Locator) => (await locator.boundingBox())!;
type Box = Awaited<ReturnType<typeof boxOf>>;
type Point = Pick<Box, "x" | "y">;

const apart = (a: Box, b: Box) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
const inside = (box: Box, pane: Box) => box.x >= pane.x && box.y >= pane.y && box.x + box.width <= pane.x + pane.width && box.y + box.height <= pane.y + pane.height;
const handleBox = (point: Point): Box => ({ x: point.x - 6, y: point.y - 6, width: 12, height: 12 });

async function settledBox(locator: Locator): Promise<Box> {
  let last = "";
  await expect.poll(async () => {
    const next = JSON.stringify(await locator.boundingBox());
    const stable = next === last;
    last = next;
    return stable && next !== "null";
  }).toBe(true);
  return boxOf(locator);
}

async function drag(page: Page, from: Point, to: Point) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

async function moveDock(page: Page, to: Point): Promise<Box> {
  await expandDock(page);
  const bar = await boxOf(dock(page));
  const grip = await boxOf(dock(page).getByRole("button", { name: "드로잉 도구 막대 옮기기", exact: true }));
  const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  await drag(page, from, { x: from.x + to.x - bar.x, y: from.y + to.y - bar.y });
  await expect(dock(page)).toHaveAttribute("data-moved", "true");
  return settledBox(dock(page));
}

async function paneOf(page: Page): Promise<Box> {
  const chart = await boxOf(chartOf(cell(page)));
  const size = await page.evaluate(() => ({
    width: window.chartProbe.chart.timeScale().width(),
    height: window.chartProbe.chart.panes()[0]!.getHeight(),
  }));
  return { x: chart.x, y: chart.y, ...size };
}

async function styleGeometry(page: Page) {
  await page.mouse.move(4, 4);
  await expect.poll(async () => (await settledMirror(page)).filter((drawing) => drawing.selected && drawing.tool === "trendline").length).toBe(1);
  const style = page.getByRole("toolbar", { name: "드로잉 스타일", exact: true });
  await expect(style).toBeVisible();
  await expandDock(page);
  const styleBox = await settledBox(style);
  const chart = await boxOf(chartOf(cell(page)));
  const selected = (await settledMirror(page)).find((drawing) => drawing.selected && drawing.tool === "trendline")!;
  const endpoints = selected.points.filter((point) => point !== null).map((point) => ({ x: chart.x + point.x, y: chart.y + point.y }));
  const hits = await chartOf(cell(page)).evaluate((host, points) => points.map((point) => {
    const target = document.elementFromPoint(point.x, point.y);
    return { point, tag: target?.tagName, label: target?.closest("[aria-label]")?.getAttribute("aria-label"), accessible: target !== null && host.contains(target) && !target.closest("[data-chart-control]") };
  }), endpoints);
  return { viewport: page.viewportSize(), pane: await paneOf(page), dock: await settledBox(dock(page)), style: styleBox, endpoints, hits };
}

async function attachStyleGeometry(page: Page, info: TestInfo, geometry: Awaited<ReturnType<typeof styleGeometry>>, free: Box) {
  const screenshot = info.outputPath("style-layout.png");
  await page.screenshot({ path: screenshot });
  await info.attach("style-layout", { path: screenshot, contentType: "image/png" });
  const coordinates = info.outputPath("style-geometry.json");
  await writeFile(coordinates, JSON.stringify({ ...geometry, free }, null, 2));
  await info.attach("style-geometry", { path: coordinates, contentType: "application/json" });
}

function expectStyleClear(geometry: Awaited<ReturnType<typeof styleGeometry>>, free: Box) {
  expect(geometry.endpoints).toHaveLength(2);
  expect(inside(free, geometry.pane), "a free spot fits inside the actual pane").toBe(true);
  expect(apart(free, geometry.dock), "the free spot avoids the moved dock").toBe(true);
  expect(geometry.endpoints.every((point) => apart(free, handleBox(point))), "the free spot leaves both endpoint handles clear").toBe(true);
  expect.soft(inside(geometry.dock, geometry.pane), "the moved dock stays inside the actual pane").toBe(true);
  expect.soft(inside(geometry.style, geometry.pane), "the style bar stays inside the actual pane").toBe(true);
  expect.soft(apart(geometry.style, geometry.dock), "the two bars do not overlap").toBe(true);
  expect.soft(geometry.endpoints.every((point) => apart(geometry.style, handleBox(point))), "the style bar leaves both endpoint handles clear").toBe(true);
  expect.soft(geometry.hits.every((hit) => hit.accessible), "elementFromPoint reaches the chart at both endpoints").toBe(true);
}

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

test("드로잉 도구는 활성 칸 위쪽 가운데의 도크이고 고른 도구는 강조색으로 채우며 펼침 메뉴는 도크 아래로 열린다", async ({ page }, info) => {
  await open(page);
  await expandDock(page);
  const bar = await boxOf(dock(page));
  const chart = await boxOf(cell(page));
  expect(Math.abs(bar.x + bar.width / 2 - (chart.x + chart.width / 2))).toBeLessThanOrEqual(1);
  expect(bar.y).toBeGreaterThanOrEqual(chart.y);
  expect(bar.y - chart.y).toBeLessThan(24);
  expect(bar.width).toBeGreaterThan(bar.height * 4);
  const legend = await boxOf(cell(page).locator(".chart-legend"));
  expect(legend.y).toBeLessThan(bar.y + bar.height);
  const pointer = dock(page).getByRole("button", { name: "선택 도구", exact: true });
  await expect(pointer).toHaveCSS("background-color", "rgb(199, 243, 107)");
  await (await expandDock(page)).getByRole("button", { name: "추세선", exact: true }).click();
  await expect(dock(page).getByRole("button", { name: "추세선", exact: true })).toHaveCSS("background-color", "rgb(199, 243, 107)");
  await expect(pointer).not.toHaveCSS("background-color", "rgb(199, 243, 107)");
  await page.keyboard.press("Escape");

  await expandDock(page);
  await dock(page).getByRole("button", { name: "선 도구 펼치기", exact: true }).click();
  const menu = page.getByRole("menu", { name: "선 도구", exact: true });
  await expect(menu).toBeVisible();
  const menuBox = await boxOf(menu);
  const docked = await boxOf(dock(page));
  expect(menuBox.y).toBeGreaterThanOrEqual(docked.y + docked.height);
  await page.screenshot({ path: info.outputPath("1440-dock.png") });
  await menu.getByRole("menuitem", { name: /수평선/ }).click();
  await expandDock(page);
  await expect(dock(page).getByRole("button", { name: "수평선", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("좁고 낮은 창에서도 도크는 창 안에 있고 가격축 방식 버튼과 겹치지 않으며 도구를 끝까지 누를 수 있다", async ({ page, scenario }) => {
  const st = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...st, drawing: { ...scenario.documents.uiPrefs().drawing, keepDrawing: true }, revision: st.revision + 1 });
  await open(page);
  for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 300 }]) {
    await page.setViewportSize(size);
    await expandDock(page);
    const bar = await boxOf(dock(page));
    const axis = await boxOf(cell(page).getByRole("group", { name: "가격축 방식" }));
    expect(bar.x).toBeGreaterThanOrEqual(0);
    expect(bar.y + bar.height).toBeLessThanOrEqual(size.height);
    expect(bar.y + bar.height <= axis.y || bar.x + bar.width <= axis.x).toBe(true);
    expect(await dock(page).evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
    await (await expandDock(page)).getByRole("button", { name: "드로잉 단축키 도움말", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "드로잉 단축키", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight])).toEqual([0, 0]);
  }
});

test.describe("selected drawing in a 1024×768 pane", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("style bar keeps the selected endpoint clear", async ({ page }, info) => {
    await page.addInitScript(installChartProbe);
    await open(page);
    await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
    const start = await settledBox(await expandDock(page));
    const pane = await paneOf(page);
    const bar = await moveDock(page, { x: pane.x + (pane.width - start.width) / 2, y: pane.y + 40 });
    await pickTool(page, "선", "추세선");
    const from = { x: bar.x + bar.width * 0.6, y: bar.y + bar.height + 15 };
    await drag(page, from, { x: from.x + 220, y: pane.y + pane.height - 15 });
    const geometry = await styleGeometry(page);
    const free = { x: pane.x + 8, y: geometry.dock.y + geometry.dock.height + 8, width: geometry.style.width, height: geometry.style.height };
    await attachStyleGeometry(page, info, geometry, free);
    expectStyleClear(geometry, free);
  });
});

test.describe("selected drawing in a short 1024×330 pane", () => {
  test.use({ viewport: { width: 1024, height: 330 } });

  test("style bar fits beside the moved dock in a short pane", async ({ page }, info) => {
    await page.addInitScript(installChartProbe);
    await open(page);
    await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
    await pickTool(page, "선", "추세선");
    const pane = await paneOf(page);
    const start = await settledBox(await expandDock(page));
    await drag(page, { x: pane.x + pane.width * 0.45, y: pane.y + 92 }, { x: pane.x + pane.width * 0.55, y: pane.y + 102 });
    await expect.poll(async () => (await settledMirror(page)).some((drawing) => drawing.selected)).toBe(true);
    await moveDock(page, { x: pane.x + (pane.width - start.width) / 2, y: pane.y + 48 });
    const geometry = await styleGeometry(page);
    const free = { x: geometry.style.x, y: geometry.dock.y - geometry.style.height, width: geometry.style.width, height: geometry.style.height };
    await attachStyleGeometry(page, info, geometry, free);
    expect(geometry.pane.height).toBeGreaterThanOrEqual(120);
    expect(geometry.pane.height).toBeLessThanOrEqual(128);
    expectStyleClear(geometry, free);
  });

  test("style bar keeps endpoint handles clear when the drawing spans the short pane", async ({ page }, info) => {
    await page.addInitScript(installChartProbe);
    await open(page);
    await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
    const pane = await paneOf(page);
    const start = await settledBox(await expandDock(page));
    await moveDock(page, { x: pane.x + (pane.width - start.width) / 2, y: pane.y + 48 });
    await pickTool(page, "선", "추세선");
    await drag(page, { x: pane.x + 320, y: pane.y + 20 }, { x: pane.x + 620, y: pane.y + 110 });
    const geometry = await styleGeometry(page);
    const free = { x: pane.x + 8, y: pane.y + pane.height - geometry.style.height, width: geometry.style.width, height: geometry.style.height };
    await attachStyleGeometry(page, info, geometry, free);
    expectStyleClear(geometry, free);
  });
});

test.describe("휴대폰", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("종목 이름과 코드가 잘리지 않고 거래소 묶음과 아래 탭이 창 안에 있다", async ({ page }, info) => {
    await open(page);
    const name = page.getByRole("button", { name: /삼성전자/ }).first();
    expect(await name.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
    await expect(name).toContainText("005930");
    const venues = await boxOf(page.getByRole("group", { name: "거래소" }));
    expect(venues.x + venues.width).toBeLessThanOrEqual(390);
    const tabs = await boxOf(page.getByRole("navigation", { name: "휴대폰 탭" }));
    expect(tabs.x).toBeGreaterThan(0);
    expect(tabs.x + tabs.width).toBeLessThan(390);
    expect(tabs.y + tabs.height).toBeLessThanOrEqual(844);
    await expect(dock(page)).toBeHidden();
    await page.screenshot({ path: info.outputPath("390-phone.png") });
  });
});
