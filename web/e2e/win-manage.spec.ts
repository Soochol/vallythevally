import type { Locator, Page } from "@playwright/test";
import type { DrawingInput } from "../src/api/generated/DrawingInput";
import type { Layout } from "../src/api/generated/Layout";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

test.use({ clockStart: "20261109100000" });

const NOV9 = Date.parse("2026-11-09T00:00:00+09:00") / 1000;
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };

const topbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const addButton = (page: Page) => topbar(page).getByRole("button", { name: "창 더하기" });
const kindItem = (page: Page, name: string) => page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: new RegExp(`^${name}`) });
const groups = (page: Page) => page.locator("[data-dock-group]");
const groupWith = (page: Page, tabName: string) => groups(page).filter({ has: page.getByRole("tab", { name: new RegExp(`^${tabName}`) }) });
const tabsOf = (page: Page, tabName: string) => groupWith(page, tabName).getByRole("tablist");
const windowTabs = (page: Page) => groups(page).locator(".dock-tabs").getByRole("tab");
const tab = (page: Page, name: string) => windowTabs(page).filter({ hasText: new RegExp(`^${name}`) });
const closeButton = (page: Page, name: string) => page.getByRole("button", { name: `${name} 닫기`, exact: true });
const toast = (page: Page) => page.getByRole("status").filter({ hasText: "창을 닫았습니다" });
const saved = (scenario: Scenario) => scenario.documents.layout(DEFAULT_LAYOUT_ID);

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소의 자리를 찾았습니다");
  return box;
}

async function addWindow(page: Page, name: string) {
  await addButton(page).click();
  await kindItem(page, name).click();
}

function expectServerRules(layout: Layout) {
  const ids = layout.windows.map((w) => w.id);
  expect(ids.length).toBeGreaterThanOrEqual(1);
  expect(ids.length).toBeLessThanOrEqual(12);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  const charts = layout.windows.filter((w) => w.kind === "chart").length;
  expect(charts).toBeGreaterThanOrEqual(1);
  expect(charts).toBeLessThanOrEqual(8);
  for (const kind of ["watchlist", "screener", "objects", "indicators"]) expect(layout.windows.filter((w) => w.kind === kind).length).toBeLessThanOrEqual(1);
}

function twoSamsungCharts(scenario: Scenario) {
  const layout = saved(scenario);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "cell-1", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "W", chartSettings: SETTINGS },
    ...layout.windows.filter((w) => w.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("창 더하기에서 차트를 고르면 활성 칸을 복사한 둘째 차트가 겹치지 않게 생기고 활성 칸이 되며 새로고침 뒤에도 남는다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await addWindow(page, "차트");
  await expect(cell(page, 2)).toBeVisible();
  await expect(cell(page, 2)).toHaveAttribute("aria-label", /^칸 2: .* 일$/);
  const first = groups(page).filter({ has: cell(page, 1) });
  const second = groups(page).filter({ has: cell(page, 2) });
  await expect(second).toHaveAttribute("data-active-cell", "");
  await expect(first).not.toHaveAttribute("data-active-cell", "");
  const [a, b] = [await boxOf(first), await boxOf(second)];
  expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);

  await expect.poll(() => saved(scenario).windows.filter((w) => w.kind === "chart").length).toBe(2);
  const layout = saved(scenario);
  expectServerRules(layout);
  const [source, copy] = layout.windows.filter((w) => w.kind === "chart");
  expect({ ...copy, id: source!.id }).toEqual(source);

  await page.reload();
  await expect(cell(page, 2)).toBeVisible();
  await expect(groups(page).filter({ has: page.getByRole("region", { name: /^칸 \d: / }) })).toHaveCount(2);
});

test("창 더하기에서 지표를 고르면 지표 창이 생기고, 다시 고르면 창 수는 그대로이고 그 탭을 고른다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await addButton(page).click();
  await expect(kindItem(page, "지표")).not.toContainText("열려 있음");
  await expect(kindItem(page, "관심종목")).toContainText("열려 있음");
  await kindItem(page, "지표").click();
  await expect(tab(page, "지표")).toHaveAttribute("aria-selected", "true");
  await expect(windowTabs(page)).toHaveCount(5);

  await tab(page, "관심종목").click();
  await expect(tab(page, "지표")).toHaveAttribute("aria-selected", "false");
  await addWindow(page, "지표");
  await expect(tab(page, "지표")).toHaveAttribute("aria-selected", "true");
  await expect(windowTabs(page)).toHaveCount(5);
  await expect.poll(() => saved(scenario).windows.filter((w) => w.kind === "indicators").length).toBe(1);
  expectServerRules(saved(scenario));
});

test("스크리너 탭을 닫으면 탭이 사라지고 알림의 되돌리기를 누르면 같은 자리에 돌아온다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const side = tabsOf(page, "관심종목");
  await expect(side.getByRole("tab")).toHaveText([/^관심종목/, /^스크리너/, /^개체 목록/]);
  await closeButton(page, "스크리너").click();
  await expect(tab(page, "스크리너")).toHaveCount(0);
  await expect(side.getByRole("tab")).toHaveText([/^관심종목/, /^개체 목록/]);
  await expect.poll(() => saved(scenario).windows.some((w) => w.kind === "screener")).toBe(false);
  expectServerRules(saved(scenario));

  await toast(page).getByRole("button", { name: "되돌리기" }).click();
  await expect(side.getByRole("tab")).toHaveText([/^관심종목/, /^스크리너/, /^개체 목록/]);
  await expect.poll(() => saved(scenario).windows.some((w) => w.kind === "screener")).toBe(true);
});

test("오른쪽 묶음의 탭을 모두 닫으면 묶음이 사라지고 차트가 작업 영역을 채우며, 하나뿐인 차트는 닫을 수 없다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  for (const name of ["관심종목", "스크리너", "개체 목록"]) await closeButton(page, name).click();
  await expect(groups(page)).toHaveCount(1);
  const area = await boxOf(page.getByRole("main", { name: "작업 영역" }));
  const only = await boxOf(groups(page).first());
  expect(Math.abs(only.width - area.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(only.height - area.height)).toBeLessThanOrEqual(1);

  const chartClose = groups(page).first().getByRole("button", { name: /^칸 1 .+ 닫기$/ });
  await expect(chartClose).toBeDisabled();
  await expect(chartClose).toHaveAttribute("title", "차트 창은 하나 이상 있어야 합니다");
  await expect.poll(() => saved(scenario).windows.map((w) => w.kind)).toEqual(["chart"]);
  expectServerRules(saved(scenario));
});

test("이 칸 범위의 드로잉이 있는 차트 창을 닫으면 같은 종목의 다른 차트 창에서 이 레이아웃 범위로 보인다", async ({ page, scenario }) => {
  twoSamsungCharts(scenario);
  const drawing: DrawingInput = { id: "01900000-0000-7000-8000-0000000000d1", symbol: "005930", tool: "hline", points: [{ t: NOV9, price: 70_000 }], style: {}, text: null, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "cell", layoutId: DEFAULT_LAYOUT_ID, windowId: "cell-1" }, revision: 3 };
  scenario.documents.saveDrawing(drawing);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await tab(page, "개체 목록").click();
  const objects = page.getByRole("region", { name: "개체 목록" });
  await expect(objects).toContainText("다른 칸·레이아웃에 1개");

  await cell(page, 2).click();
  await expect(objects.getByRole("region", { name: "이 칸" })).toBeVisible();
  await closeButton(page, "칸 2 삼성전자").click();
  await expect(cell(page, 2)).toHaveCount(0);
  await expect.poll(() => scenario.documents.drawings("005930")[0]?.scope).toEqual({ kind: "layout", layoutId: DEFAULT_LAYOUT_ID });
  await expect(objects.getByRole("region", { name: "이 레이아웃 공통" })).toContainText("1");
  await expect(objects).not.toContainText("다른 칸·레이아웃에");
  expectServerRules(saved(scenario));
});

test("창 더하기 메뉴와 탭의 닫기 버튼을 키보드만으로 쓴다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await addButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(kindItem(page, "차트")).toBeFocused();
  await page.keyboard.press("End");
  await expect(kindItem(page, "지표")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tab(page, "지표")).toHaveAttribute("aria-selected", "true");

  await tab(page, "지표").focus();
  await page.keyboard.press("Tab");
  await expect(closeButton(page, "지표")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tab(page, "지표")).toHaveCount(0);
  await expect(tab(page, "개체 목록")).toBeFocused();
  await expect(toast(page)).toContainText("지표 창을 닫았습니다");
});
