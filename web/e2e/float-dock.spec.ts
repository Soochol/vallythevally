import type { Locator, Page } from "@playwright/test";
import { cell, expect, test } from "./harness";
import { expandDock } from "./drawing-probe";

test.use({ clockStart: "20261109100030", viewport: { width: 1440, height: 900 } });

const dock = (page: Page) => page.getByRole("navigation", { name: "드로잉 도구" });
const boxOf = async (locator: Locator) => (await locator.boundingBox())!;

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

test("드로잉 도구는 작업 영역 왼쪽의 세로 막대이고 고른 도구는 강조색으로 채우며 펼침 메뉴는 막대 오른쪽으로 열린다", async ({ page }, info) => {
  await open(page);
  await expandDock(page);
  const bar = await boxOf(dock(page));
  const chart = await boxOf(cell(page));
  expect(bar.x + bar.width).toBeLessThanOrEqual(chart.x);
  expect(bar.height).toBeGreaterThan(bar.width * 4);
  const legend = await boxOf(cell(page).locator(".chart-legend"));
  expect(legend.x).toBeGreaterThanOrEqual(chart.x);
  const pointer = dock(page).getByRole("button", { name: "선택 도구", exact: true });
  await expect(pointer).toHaveCSS("background-color", "rgb(199, 243, 107)");
  await dock(page).getByRole("button", { name: "추세선", exact: true }).click();
  await expect(dock(page).getByRole("button", { name: "추세선", exact: true })).toHaveCSS("background-color", "rgb(199, 243, 107)");
  await expect(pointer).not.toHaveCSS("background-color", "rgb(199, 243, 107)");
  await page.keyboard.press("Escape");

  await dock(page).getByRole("button", { name: "선 도구 펼치기", exact: true }).click();
  const menu = page.getByRole("menu", { name: "선 도구", exact: true });
  await expect(menu).toBeVisible();
  const menuBox = await boxOf(menu);
  const docked = await boxOf(dock(page));
  expect(menuBox.x).toBeGreaterThanOrEqual(docked.x + docked.width);
  await page.screenshot({ path: info.outputPath("1440-dock.png") });
  await menu.getByRole("menuitem", { name: /수평선/ }).click();
  await expect(dock(page).getByRole("button", { name: "수평선", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("좁고 낮은 창에서도 막대는 창 안에 있고 가격축 방식 버튼과 겹치지 않으며 도움말까지 누를 수 있다", async ({ page, scenario }) => {
  const st = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...st, drawing: { ...scenario.documents.uiPrefs().drawing, keepDrawing: true }, revision: st.revision + 1 });
  await open(page);
  for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 300 }]) {
    await page.setViewportSize(size);
    await expandDock(page);
    const bar = await boxOf(dock(page));
    const axis = await boxOf(cell(page).getByRole("combobox", { name: "가격축 방식" }));
    expect(bar.x).toBeGreaterThanOrEqual(0);
    expect(bar.y + bar.height).toBeLessThanOrEqual(size.height);
    expect(bar.y + bar.height <= axis.y || bar.x + bar.width <= axis.x).toBe(true);
    expect(await dock(page).evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
    await dock(page).getByRole("button", { name: "드로잉 단축키 도움말", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "드로잉 단축키", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight])).toEqual([0, 0]);
  }
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
