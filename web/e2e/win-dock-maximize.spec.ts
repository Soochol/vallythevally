import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { parsePlacement } from "../src/layout/placement";
import { cell, chartOf, DEFAULT_LAYOUT_ID, expect, test, type Scenario, pollSaved } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 900 } });
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const groups = (page: Page) => page.locator("[data-dock-group]");
const groupWith = (page: Page, name: string) => groups(page).filter({ has: tab(page, name) });
const area = (page: Page) => page.getByRole("main", { name: "작업 영역" });
const menu = (page: Page) => page.getByRole("menu", { name: "창 배치" });
const separators = (page: Page) => area(page).getByRole("separator", { name: /창 경계/ });
const saved = (scenario: Scenario) => scenario.documents.layout(DEFAULT_LAYOUT_ID).placement;
const settings = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소의 자리를 찾았습니다");
  return box;
}

const emptyTabs = (group: Locator) => group.locator(".dock-tabs");
async function doubleClickEmpty(group: Locator) {
  const row = await boxOf(emptyTabs(group));
  const add = await boxOf(group.locator(".dock-add"));
  const actions = group.locator(".dock-tab-actions");
  const rightEdge = (await actions.isVisible()) ? (await boxOf(actions)).x : row.x + row.width - 8;
  const gap = (add.x + add.width + rightEdge) / 2;
  await emptyTabs(group).dblclick({ position: { x: gap - row.x, y: row.height / 2 } });
}

function twoCharts(scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: settings },
    { id: "cell-1", link: null, kind: "chart", symbol: "000660", venue: "combined", period: "D", chartSettings: settings },
    ...layout.windows.filter((window) => window.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
}

async function open(page: Page) {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(groups(page)).toHaveCount(2);
}

test("오른쪽 묶음 탭 줄 빈 곳을 더블클릭하면 작업 영역 전체로 커지고 Esc로 원래 두 사각형으로 돌아온다", async ({ page }) => {
  await open(page);
  await expect(groups(page).first()).toHaveAttribute("data-active-cell", "");
  const work = await boxOf(area(page));
  const chartBefore = await boxOf(groups(page).first());
  const sideBefore = await boxOf(groups(page).last());
  await expect(separators(page)).toHaveCount(1);
  await doubleClickEmpty(groups(page).last());
  await expect(groups(page)).toHaveCount(1);
  await expect(separators(page)).toHaveCount(0);
  expect(await boxOf(groups(page))).toEqual(work);
  await page.keyboard.press("Escape");
  await expect(groups(page)).toHaveCount(2);
  await expect(separators(page)).toHaveCount(1);
  expect(await boxOf(groups(page).first())).toEqual(chartBefore);
  expect(await boxOf(groups(page).last())).toEqual(sideBefore);
  await expect(groups(page).first()).toHaveAttribute("data-active-cell", "");
});

test("같은 탭 줄 빈 곳 더블클릭과 되돌림 버튼도 크게 보기를 끝낸다", async ({ page }) => {
  await open(page);
  const sideBefore = await boxOf(groups(page).last());
  await doubleClickEmpty(groups(page).last());
  await expect(groups(page)).toHaveCount(1);
  await doubleClickEmpty(groups(page));
  await expect(groups(page)).toHaveCount(2);
  expect(await boxOf(groups(page).last())).toEqual(sideBefore);
  await doubleClickEmpty(groups(page).last());
  await expect(groups(page)).toHaveCount(1);
  await page.getByRole("button", { name: "원래 크기로", exact: true }).click();
  await expect(groups(page)).toHaveCount(2);
  await expect(page.getByRole("button", { name: "원래 크기로", exact: true })).toHaveCount(0);
});

test("탭 메뉴의 크게 보기와 원래 크기로를 키보드만으로 쓴다", async ({ page }) => {
  await open(page);
  const side = groups(page).last();
  await side.getByRole("tab").first().focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("menuitem", { name: "원래 크기로" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(groups(page)).toHaveCount(1);
  await expect(separators(page)).toHaveCount(0);
  await page.keyboard.press("Shift+F10");
  await expect(menu(page).getByRole("menuitem", { name: "원래 크기로" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(groups(page)).toHaveCount(2);
});

test("크게 보기는 저장된 배치와 배치 되돌리기 가능 여부를 바꾸지 않고 새로고침하면 원래 배치다", async ({ page, scenario }) => {
  await open(page);
  await tab(page, "스크리너").click();
  await tab(page, "관심종목").click();
  await pollSaved(() => JSON.stringify(parsePlacement(saved(scenario)).dock)).toContain('"active":"watchlist"');
  const before = JSON.stringify(saved(scenario));
  const side = groups(page).last();
  await side.getByRole("tab").first().focus();
  await page.keyboard.press("Shift+F10");
  const undo = menu(page).getByRole("menuitem", { name: "배치 되돌리기", exact: true });
  const undoable = await undo.isEnabled();
  await page.keyboard.press("Escape");
  await doubleClickEmpty(side);
  await expect(groups(page)).toHaveCount(1);
  await groups(page).getByRole("tab").first().focus();
  await page.keyboard.press("Shift+F10");
  expect(await menu(page).getByRole("menuitem", { name: "배치 되돌리기", exact: true }).isEnabled()).toBe(undoable);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(groups(page)).toHaveCount(2);
  expect(JSON.stringify(saved(scenario))).toBe(before);
  await doubleClickEmpty(groups(page).last());
  await expect(groups(page)).toHaveCount(1);
  await page.reload();
  await expect(groups(page)).toHaveCount(2);
});

test("차트 묶음을 크게 보고 나와도 같은 차트 노드가 이어진다", async ({ page }) => {
  await open(page);
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  const node = await chartOf(cell(page)).elementHandle();
  if (!node) throw new Error("차트가 없습니다");
  await doubleClickEmpty(groups(page).first());
  await expect(groups(page)).toHaveCount(1);
  await expect(chartOf(cell(page))).toBeVisible();
  expect(await chartOf(cell(page)).evaluate((element, previous) => element === previous, node)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(groups(page)).toHaveCount(2);
  expect(await chartOf(cell(page)).evaluate((element, previous) => element === previous, node)).toBe(true);
});

test("둘째 차트 묶음을 크게 보면 활성 칸이 둘째 차트가 되고 나와도 유지된다", async ({ page, scenario }) => {
  twoCharts(scenario);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(groupWith(page, "삼성전자")).toHaveAttribute("data-active-cell", "");
  const second = groupWith(page, "SK하이닉스");
  await expect(second).toBeVisible();
  await doubleClickEmpty(second);
  await expect(groups(page)).toHaveCount(1);
  await expect(groupWith(page, "SK하이닉스")).toHaveAttribute("data-active-cell", "");
  await page.keyboard.press("Escape");
  await expect(groups(page).first()).toBeVisible();
  await expect(groupWith(page, "SK하이닉스")).toHaveAttribute("data-active-cell", "");
});

test("크게 보는 동안 다른 탭을 누르면 내용이 바뀌고 탭 끌기를 시작하면 크게 보기가 끝나고 끌기가 이어진다", async ({ page }) => {
  await open(page);
  const side = groups(page).last();
  await doubleClickEmpty(side);
  await expect(groups(page)).toHaveCount(1);
  await tab(page, "스크리너").click();
  await expect(tab(page, "스크리너")).toHaveAttribute("aria-selected", "true");
  await expect(groups(page)).toHaveCount(1);
  const box = await boxOf(tab(page, "관심종목"));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + 120, { steps: 8 });
  await expect(groups(page)).toHaveCount(2);
  await expect(page.locator("[data-dock-preview]")).toBeVisible();
  await page.mouse.up();
  await expect(groups(page).first()).toBeVisible();
});

test("크게 보는 동안 그 묶음의 창을 닫아 묶음이 사라지면 크게 보기가 끝나고 남은 배치가 보인다", async ({ page }) => {
  await open(page);
  const side = groups(page).last();
  const names = await side.getByRole("tab").count();
  await doubleClickEmpty(side);
  await expect(groups(page)).toHaveCount(1);
  for (let i = 0; i < names; i++) {
    await groups(page).first().getByRole("button", { name: /닫기$/ }).first().click();
  }
  await expect(groups(page)).toHaveCount(1);
  await expect(chartOf(cell(page))).toBeVisible();
  await expect(page.getByRole("button", { name: "원래 크기로", exact: true })).toHaveCount(0);
});
