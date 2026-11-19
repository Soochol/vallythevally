import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { parsePlacement } from "../src/layout/placement";
import { windowId } from "../src/layout/kinds";
import { drawings, mirror } from "./drawing-probe";
import { cell, chartOf, DEFAULT_LAYOUT_ID, expect, pollSaved, test, type Scenario } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 900 } });

const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const groups = (page: Page) => page.locator("[data-dock-group]");
const area = (page: Page) => page.getByRole("main", { name: "작업 영역" });
const preview = (page: Page) => page.locator("[data-dock-preview]");
const sideways = (page: Page) => page.getByRole("separator", { name: "좌우 창 경계" });
const notice = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });
const layoutMenu = (page: Page) => page.getByRole("menu", { name: "레이아웃" });
const savedPlacement = (scenario: Scenario) => parsePlacement(scenario.documents.layout(DEFAULT_LAYOUT_ID).placement);
const savedDock = (scenario: Scenario) => savedPlacement(scenario).dock;
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소의 자리를 찾았습니다");
  return box;
}

async function open(page: Page) {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function persistBaseline(page: Page, scenario: Scenario) {
  await tab(page, "스크리너").click();
  await tab(page, "관심종목").click();
  await pollSaved(() => savedDock(scenario)).not.toBeNull();
  await pollSaved(() => JSON.stringify(savedDock(scenario))).toContain('"active":"watchlist"');
}

async function startDrag(page: Page, source: Locator) {
  const box = await boxOf(source);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

async function splitScreenerBelowChart(page: Page) {
  const chart = await boxOf(groups(page).first());
  await startDrag(page, tab(page, "스크리너"));
  await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height - 60, { steps: 12 });
  await expect(preview(page)).toContainText("아래에 나눠 놓기");
  await page.mouse.up();
  await expect(groups(page)).toHaveCount(3);
}

async function groupBoxes(page: Page) {
  return Promise.all((await groups(page).all()).map(boxOf));
}

test("끌어 놓은 뒤 Ctrl+Z로 끌기 전 배치와 저장으로 돌아오고 Ctrl+Shift+Z·Ctrl+Y로 다시 한다", async ({ page, scenario }) => {
  await open(page);
  await persistBaseline(page, scenario);
  const original = savedDock(scenario);
  const originalBoxes = await groupBoxes(page);
  await splitScreenerBelowChart(page);
  const splitBoxes = await groupBoxes(page);
  await pollSaved(() => savedDock(scenario)).not.toEqual(original);
  const split = savedDock(scenario);
  await expect(tab(page, "스크리너")).toBeFocused();

  await page.keyboard.press("Control+z");
  await expect(notice(page, "배치를 되돌렸습니다")).toBeVisible();
  await expect(groups(page)).toHaveCount(2);
  expect(await groupBoxes(page)).toEqual(originalBoxes);
  await pollSaved(() => savedDock(scenario)).toEqual(original);
  await expect(tab(page, "스크리너")).toBeFocused();

  await page.keyboard.press("Control+Shift+z");
  await expect(notice(page, "배치를 다시 했습니다")).toBeVisible();
  await expect(groups(page)).toHaveCount(3);
  expect(await groupBoxes(page)).toEqual(splitBoxes);
  await pollSaved(() => savedDock(scenario)).toEqual(split);
  await expect(tab(page, "스크리너")).toBeFocused();

  await page.keyboard.press("Control+z");
  await expect(groups(page)).toHaveCount(2);
  await page.keyboard.press("Control+y");
  await expect(groups(page)).toHaveCount(3);
  expect(await groupBoxes(page)).toEqual(splitBoxes);
});

test("경계를 끌어 놓은 뒤 Ctrl+Z로 폭이 돌아온다", async ({ page }) => {
  await open(page);
  const before = (await boxOf(groups(page).first())).width;
  const handle = await boxOf(sideways(page));
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 150, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await boxOf(groups(page).first())).width).toBe(before - 150);
  await page.keyboard.press("Control+z");
  await expect(notice(page, "배치를 되돌렸습니다")).toBeVisible();
  await expect.poll(async () => (await boxOf(groups(page).first())).width).toBe(before);
});

test("캔버스에서 창을 옮긴 뒤 Ctrl+Z로 자리가 돌아온다", async ({ page, scenario }) => {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "watchlist", link: null, kind: "watchlist" },
  ];
  const canvas = { rects: { "cell-0": { x: .04, y: .04, w: .45, h: .54 }, watchlist: { x: .72, y: .02, w: .25, h: .5 } }, order: ["cell-0", "watchlist"] };
  scenario.documents.saveLayout({ ...layout, windows, placement: { v: 1, dock: null, canvas }, revision: layout.revision + 1 });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: "canvas" });
  await open(page);
  const frame = page.locator('[data-canvas-window="cell-0"]');
  const before = await boxOf(frame);
  const header = await boxOf(page.locator('[data-window-header="cell-0"]'));
  await page.mouse.move(header.x + 60, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 160, header.y + header.height / 2 + 50, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await boxOf(frame)).x).not.toBe(before.x);
  await pollSaved(() => savedPlacement(scenario).canvas?.rects[windowId("cell-0")]?.x).not.toBe(.04);
  await page.keyboard.press("Control+z");
  await expect(notice(page, "배치를 되돌렸습니다")).toBeVisible();
  expect(await boxOf(frame)).toEqual(before);
  await pollSaved(() => savedPlacement(scenario).canvas?.rects[windowId("cell-0")]?.x).toBe(.04);
});

test("차트 칸 안의 Ctrl+Z는 드로잉만 지우고 배치는 그대로다", async ({ page, scenario }) => {
  await open(page);
  const chart = (await chartOf(cell(page)).boundingBox())!;
  await cell(page).focus();
  await page.keyboard.press("T");
  await page.mouse.move(chart.x + chart.width * 0.76, chart.y + chart.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(chart.x + chart.width * 0.86, chart.y + chart.height * 0.25, { steps: 12 });
  await page.mouse.up();
  await pollSaved(async () => (await drawings(scenario)).length).toBe(1);
  await splitScreenerBelowChart(page);
  const arranged = await groupBoxes(page);
  await cell(page).focus();
  await page.keyboard.press("Control+z");
  await pollSaved(async () => (await drawings(scenario)).length).toBe(0);
  await expect.poll(async () => (await mirror(page)).length).toBe(0);
  await expect(groups(page)).toHaveCount(3);
  expect(await groupBoxes(page)).toEqual(arranged);
  await expect(notice(page, "배치를 되돌렸습니다")).toHaveCount(0);
});

test("입력 칸의 Ctrl+Z는 브라우저가 맡고 배치는 그대로다", async ({ page }) => {
  await open(page);
  await splitScreenerBelowChart(page);
  await page.keyboard.press("/");
  const search = page.getByRole("dialog", { name: "종목 검색", exact: true });
  const input = search.getByRole("combobox").or(search.getByRole("textbox")).first();
  await input.fill("삼성");
  await input.press("Control+z");
  await expect(notice(page, "배치를 되돌렸습니다")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(groups(page)).toHaveCount(3);
});

test("기록이 없으면 알림만 보이고 배치는 그대로다", async ({ page }) => {
  await open(page);
  const before = await groupBoxes(page);
  await tab(page, "관심종목").focus();
  await page.keyboard.press("Control+z");
  await expect(notice(page, "되돌릴 배치 변경이 없습니다")).toBeVisible();
  await page.keyboard.press("Control+y");
  await expect(notice(page, "다시 할 배치 변경이 없습니다")).toBeVisible();
  expect(await groupBoxes(page)).toEqual(before);
});

test("탭을 끄는 중의 Ctrl+Z는 배치를 바꾸지 않고 이어 놓으면 정상으로 나눠진다", async ({ page }) => {
  await open(page);
  const chart = await boxOf(groups(page).first());
  await startDrag(page, tab(page, "스크리너"));
  await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height - 60, { steps: 12 });
  await expect(preview(page)).toContainText("아래에 나눠 놓기");
  await page.keyboard.press("Control+z");
  await expect(preview(page)).toBeVisible();
  await expect(groups(page)).toHaveCount(2);
  await page.mouse.up();
  await expect(groups(page)).toHaveCount(3);
  await expect(notice(page, "배치를 되돌렸습니다")).toHaveCount(0);
});

test("레이아웃 메뉴의 배치 다시 하기는 되돌린 뒤에만 켜지고 누르면 다시 한다", async ({ page }) => {
  await open(page);
  const trigger = page.getByRole("button", { name: /^레이아웃:/ });
  const redo = () => layoutMenu(page).getByRole("menuitem", { name: "배치 다시 하기", exact: true });
  await trigger.click();
  await expect(redo()).toBeDisabled();
  await page.keyboard.press("Escape");
  await splitScreenerBelowChart(page);
  await page.keyboard.press("Control+z");
  await expect(groups(page)).toHaveCount(2);
  await trigger.click();
  await expect(redo()).toBeEnabled();
  await redo().click();
  await expect(groups(page)).toHaveCount(3);
  await trigger.click();
  await expect(redo()).toBeDisabled();
  await expect(area(page)).toBeVisible();
});

test("떠 있는 창 머리에서 탭으로 돌아오거나 탭에서 떠 있는 창으로 바뀌어도 초점을 탭 밖으로 옮기지 않는다", async ({ page }) => {
  const header = page.locator('[data-window-header="screener"]');
  const activeIsBody = () => page.evaluate(() => document.activeElement === document.body);
  await open(page);
  await tab(page, "스크리너").click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "띄우기", exact: true }).click();
  await expect(header).toBeVisible();
  await header.focus();
  await page.keyboard.press("Control+z");
  await expect(header).toHaveCount(0);
  await expect(tab(page, "스크리너")).toBeVisible();
  await expect(tab(page, "스크리너")).not.toBeFocused();
  expect(await activeIsBody()).toBe(true);
  await page.keyboard.press("Control+y");
  await expect(header).toBeVisible();
  await page.getByRole("button", { name: "스크리너 붙이기" }).click();
  await expect(header).toHaveCount(0);
  await tab(page, "스크리너").focus();
  await page.keyboard.press("Control+z");
  await expect(header).toBeVisible();
  await expect(header).not.toBeFocused();
  expect(await activeIsBody()).toBe(true);
});
