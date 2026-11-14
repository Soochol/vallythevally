import type { Page } from "@playwright/test";
import { cell, chartOf, expect, saveChartShare, test, type Scenario } from "./harness";
import { installChartProbe } from "./chart-probe";
import { chartPoint, pickTool, settledMirror } from "./drawing-probe";
import { TOOLS } from "../src/chart/drawings/tools";

test.use({ clockStart: "20261109100030", viewport: { width: 1440, height: 900 } });

type Box = { x: number; y: number; width: number; height: number };

const dock = (page: Page) => page.getByRole("navigation", { name: "드로잉 도구" });
const grip = (page: Page) => dock(page).getByRole("button", { name: "드로잉 도구 막대 옮기기", exact: true });
const dockBox = async (page: Page): Promise<Box> => (await dock(page).boundingBox())!;
const chartArea = (page: Page): Promise<Box> => dock(page).evaluate((bar) => {
  const { x, y, width, height } = bar.parentElement!.getBoundingClientRect();
  return { x, y, width, height };
});

const drawings = async (scenario: Scenario) => scenario.documents.drawings("005930");
const savedDockAt = (scenario: Scenario) => (scenario.documents.uiState().drawing as { dockAt?: unknown } | undefined)?.dockAt;
const visibleRange = (page: Page) => page.evaluate(() => window.chartProbe.chart.timeScale().getVisibleLogicalRange());

function expectInside(bar: Box, area: Box) {
  expect(bar.x).toBeGreaterThanOrEqual(area.x);
  expect(bar.y).toBeGreaterThanOrEqual(area.y);
  expect(bar.x + bar.width).toBeLessThanOrEqual(area.x + area.width);
  expect(bar.y + bar.height).toBeLessThanOrEqual(area.y + area.height);
}

function expectSameSpot(actual: Box, expected: Box, tolerance = 2) {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance);
}

async function settledDock(page: Page): Promise<Box> {
  let last = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await dockBox(page));
    const same = now === last;
    last = now;
    return same;
  }).toBe(true);
  return dockBox(page);
}

async function open(page: Page, symbol = "005930") {
  await page.goto(`/?symbol=${symbol}`);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  return settledDock(page);
}

async function dragGrip(page: Page, dx: number, dy: number) {
  const g = (await grip(page).boundingBox())!;
  const from = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  await page.mouse.up();
  return settledDock(page);
}

async function moveTo(page: Page, spot: (area: Box, bar: Box) => { x: number; y: number }) {
  const bar = await dockBox(page);
  const target = spot(await chartArea(page), bar);
  return dragGrip(page, target.x - bar.x, target.y - bar.y);
}

const bottomRight = (area: Box, bar: Box) => ({ x: area.x + area.width - bar.width - 40, y: area.y + area.height - bar.height - 40 });
const middle = (area: Box, bar: Box) => ({ x: area.x + (area.width - bar.width) / 2, y: area.y + (area.height - bar.height) / 2 });

async function expectSavedRatios(scenario: Scenario) {
  await expect.poll(() => savedDockAt(scenario)).toEqual({ x: expect.any(Number), y: expect.any(Number) });
  const { x, y } = savedDockAt(scenario) as { x: number; y: number };
  for (const ratio of [x, y]) { expect(ratio).toBeGreaterThanOrEqual(0); expect(ratio).toBeLessThanOrEqual(1); }
}

async function legendRows(page: Page) {
  return cell(page).locator(".chart-legend").evaluate((legend) => {
    const range = document.createRange();
    return Array.from(legend.children).flatMap((child) => getComputedStyle(child).flexDirection === "column" ? Array.from(child.children) : [child]).map((row) => {
      range.selectNodeContents(row);
      const { left, top, right, bottom } = range.getBoundingClientRect();
      return { left, top, right, bottom };
    }).filter((row) => row.right > row.left);
  });
}

test("손잡이로 차트 영역 오른쪽 아래로 옮긴 막대는 그 자리에 남고, 새로고침·종목·봉 주기를 바꿔도 같은 자리이며, 끄는 동안 차트가 움직이지 않는다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  await open(page);
  const range = await visibleRange(page);
  const before = await dockBox(page);
  const area = await chartArea(page);
  const target = bottomRight(area, before);
  const moved = await dragGrip(page, target.x - before.x, target.y - before.y);
  expectSameSpot(moved, { ...before, ...target }, 1);
  expectInside(moved, area);
  expect(await visibleRange(page)).toEqual(range);
  expect(await drawings(scenario)).toEqual([]);
  await expectSavedRatios(scenario);

  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  expectSameSpot(await settledDock(page), moved);

  await page.getByTitle("종목 검색 (/ 또는 Ctrl+K)").click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill("ㅇㅋㅍㄹ");
  const ecopro = dialog.getByRole("option").filter({ hasText: "086520" });
  await expect(ecopro).toHaveAttribute("aria-disabled", "false");
  await ecopro.click();
  await expect(cell(page)).toHaveAttribute("aria-label", /^칸 1: 에코프로/);
  expectSameSpot(await settledDock(page), moved);

  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "주", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-label", /주$/);
  expectSameSpot(await settledDock(page), moved);
});

test("옮긴 막대는 범례를 밀지 않고, 범례 위로 옮겨도 범례가 움직이지 않는다", async ({ page }) => {
  await open(page);
  await moveTo(page, bottomRight);
  const resting = await legendRows(page);
  const rows = resting[0]!;
  const onLegend = await moveTo(page, () => ({ x: rows.left, y: rows.top }));
  expect(onLegend.y).toBeLessThan(rows.bottom);
  expect(await legendRows(page)).toEqual(resting);
});

test("옮긴 막대에서 추세선을 골라 선을 그리고, 맨 아래에 둔 막대의 그룹 메뉴는 막대 위로 창 안에 열린다", async ({ page, scenario }) => {
  await open(page);
  await moveTo(page, middle);
  await pickTool(page, "선", "추세선");
  await dragGrip(page, 30, 20);
  expect(await drawings(scenario)).toEqual([]);
  const a = await chartPoint(page, 0.15, 0.2);
  const b = await chartPoint(page, 0.3, 0.3);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await drawings(scenario)).map((d) => d.tool)).toEqual(["trendline"]);
  await page.keyboard.press("Escape");

  const area = await chartArea(page);
  const low = await moveTo(page, (_, bar) => ({ x: bar.x, y: area.y + area.height }));
  expect(low.y + low.height).toBeGreaterThan(area.y + area.height - 16);
  await dock(page).getByRole("button", { name: "선 도구 펼치기", exact: true }).click();
  const menu = page.getByRole("menu", { name: "선 도구", exact: true });
  await expect(menu).toBeVisible();
  const opened = (await menu.boundingBox())!;
  expect(opened.y + opened.height).toBeLessThanOrEqual(low.y);
  expect(opened.y).toBeGreaterThanOrEqual(0);
});

test("창을 1024×768로 줄여도 옮긴 막대 전체가 차트 영역 안에 있고, 되돌리면 옮긴 자리로 돌아온다", async ({ page }) => {
  await open(page);
  const moved = await moveTo(page, bottomRight);
  await page.setViewportSize({ width: 1024, height: 768 });
  expectInside(await settledDock(page), await chartArea(page));
  await page.setViewportSize({ width: 1440, height: 900 });
  expectSameSpot(await settledDock(page), moved);
});

test("고정 도구 12개를 둔 옮긴 막대는 차트 영역 폭을 넘지 않고 접힌 고정 도구를 메뉴에서 고를 수 있다", async ({ page, scenario }) => {
  saveChartShare(scenario, 0.45);
  const state = scenario.documents.uiState();
  const pinned = TOOLS.slice(0, 12);
  scenario.documents.saveUiState({ ...state, drawing: { ...scenario.documents.uiPrefs().drawing, pinnedTools: pinned.map((t) => t.tool), dockAt: { x: 0.5, y: 0.5 } }, revision: state.revision + 1 });
  const bar = await open(page);
  const area = await chartArea(page);
  expectInside(bar, area);
  expect(await dock(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  const inline = await dock(page).getByRole("button", { name: /고정 도구$/ }).count();
  expect(inline).toBeGreaterThanOrEqual(1);
  expect(inline).toBeLessThan(pinned.length);
  await dock(page).getByRole("button", { name: "고정 도구 펼치기", exact: true }).click();
  const menu = page.getByRole("menu", { name: "고정 도구", exact: true });
  const last = pinned.at(-1)!;
  await menu.getByRole("menuitem").filter({ hasText: last.label }).click();
  await expect(menu).toBeHidden();
  await expect(dock(page).locator("button[aria-pressed=true][data-active-tool]")).toHaveAttribute("title", new RegExp(`^${last.label}`));
});

test("막대를 가운데에 두고 위쪽 드로잉을 고르면 스타일 막대가 드로잉 가까이에 놓이고 막대와 겹치지 않는다", async ({ page, scenario }, info) => {
  await open(page);
  const bar = await moveTo(page, middle);
  await pickTool(page, "선", "추세선");
  const a = await chartPoint(page, 0.35, 0.2);
  const b = await chartPoint(page, 0.6, 0.25);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await drawings(scenario)).length).toBe(1);
  await expect.poll(async () => (await settledMirror(page)).some((m) => m.selected)).toBe(true);
  const style = page.getByRole("toolbar", { name: "드로잉 스타일" });
  await expect(style).toBeVisible();
  const styleBox = (await style.boundingBox())!;
  const top = Math.min(a.y, b.y);
  expect(styleBox.y + styleBox.height).toBeLessThanOrEqual(top);
  expect(top - (styleBox.y + styleBox.height)).toBeLessThan(40);
  const apart = styleBox.x + styleBox.width <= bar.x || styleBox.x >= bar.x + bar.width || styleBox.y + styleBox.height <= bar.y || styleBox.y >= bar.y + bar.height;
  expect(apart).toBe(true);
  await page.screenshot({ path: info.outputPath("1440-moved-dock.png") });
});

test("손잡이를 두 번 누르면 기본 자리로 돌아가고, 기본 자리에서 10px 옮겨 놓아도 기본 자리에 붙는다", async ({ page, scenario }) => {
  const home = await open(page);
  await moveTo(page, middle);
  await expectSavedRatios(scenario);
  await grip(page).dblclick();
  expectSameSpot(await settledDock(page), home, 1);
  await expect.poll(() => savedDockAt(scenario)).toBeNull();

  expectSameSpot(await dragGrip(page, 10, 10), home, 1);
  await expect(dock(page)).not.toHaveAttribute("data-moved");
  expect(savedDockAt(scenario)).toBeNull();
});

test("손잡이에 포커스를 두고 오른쪽 화살표를 세 번 누르면 48px 옮기고 Home은 기본 자리로 돌린다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  const home = await open(page);
  const range = await visibleRange(page);
  await grip(page).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  const moved = await settledDock(page);
  expect(Math.round(moved.x - home.x)).toBe(48);
  expect(Math.round(moved.y - home.y)).toBe(0);
  await expectSavedRatios(scenario);
  expect(await visibleRange(page)).toEqual(range);
  await page.keyboard.press("Home");
  expectSameSpot(await settledDock(page), home, 1);
  await expect.poll(() => savedDockAt(scenario)).toBeNull();
  await expect(grip(page)).toBeFocused();
});
