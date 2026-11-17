import type { Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, test, windowTabs } from "./harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const KINDS = [
  { kind: "trades", name: "체결" },
  { kind: "book", name: "10호가" },
  { kind: "program", name: "프로그램 체결" },
  { kind: "brokers", name: "거래원 입체분석" },
] as const;

const addButton = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" });
const kindItem = (page: Page, name: string) => page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: new RegExp(`^${name}`) });
const tabOf = (page: Page, id: string) => windowTabs(page).locator(`[role=tab][data-window-id="${id}"]`);
const dotOf = (page: Page, id: string) => windowTabs(page).locator(`[role=tab][data-window-id="${id}"] + .link-dot`);
const preparing = (page: Page) => page.getByTestId("market-window-preparing");
const savedWindows = (scenario: Scenario) => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows;

function twoLinkedCharts(scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "cell-1", link: "b", kind: "chart", symbol: "000660", venue: "combined", period: "D", chartSettings: SETTINGS },
    ...layout.windows.filter((w) => w.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
}

async function addWindow(page: Page, name: string) {
  await addButton(page).click();
  await kindItem(page, name).click();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

for (const { kind, name } of KINDS) {
  test(`${name} 창은 창 더하기에서 열리고 연동 색을 따르며 두 번째는 만들어지지 않는다`, async ({ page, scenario }) => {
    twoLinkedCharts(scenario);
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");

    await addWindow(page, name);
    await expect(tabOf(page, kind)).toHaveAccessibleName(new RegExp(`^${name}`));
    await expect(preparing(page)).toContainText(`${name} 준비 중`);
    await expect(preparing(page)).toContainText("삼성전자");
    await expect(dotOf(page, kind)).toHaveAccessibleName("연동 색: 끔");
    await expect.poll(() => savedWindows(scenario).filter((w) => w.kind === kind)).toEqual([{ id: kind, link: null, kind }]);

    await dotOf(page, kind).click();
    await page.getByRole("menu", { name: "연동 색" }).getByRole("menuitemradio", { name: /^B/ }).click();
    await expect(dotOf(page, kind)).toHaveAccessibleName("연동 색: B");
    await expect(preparing(page)).toContainText("SK하이닉스");
    await expect(preparing(page)).toHaveAttribute("data-symbol", "000660");
    await expect.poll(() => savedWindows(scenario).find((w) => w.kind === kind)?.link).toBe("b");

    await addButton(page).click();
    await expect(kindItem(page, name)).toContainText("열려 있음");
    await kindItem(page, name).click();
    await expect(windowTabs(page).getByRole("tab", { name: new RegExp(`^${name}`) })).toHaveCount(1);
    expect(savedWindows(scenario).filter((w) => w.kind === kind)).toHaveLength(1);
  });
}

test("지수 종목을 따르는 시세 창은 주식만 보인다고 알린다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await addWindow(page, "10호가");
  await expect(page.getByText("이 창은 주식만 보입니다")).toBeVisible();
  await expect(preparing(page)).toHaveCount(0);
});

test("새 종류 넷을 레이아웃에 저장하면 다시 열어도 그대로 있다", async ({ page, scenario }) => {
  twoLinkedCharts(scenario);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  for (const { name } of KINDS) await addWindow(page, name);
  await expect.poll(() => savedWindows(scenario).map((w) => w.kind).sort()).toEqual(["brokers", "book", "chart", "chart", "objects", "program", "screener", "trades", "watchlist"].sort());
  await page.reload();
  for (const { kind } of KINDS) await expect(tabOf(page, kind)).toHaveCount(1);
});
