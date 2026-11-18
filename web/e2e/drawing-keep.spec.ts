import type { Page } from "@playwright/test";
import { cell, chartOf, expect, test, type Scenario, pollSaved } from "./harness";
import { chartPoint, drawingDock as dock } from "./drawing-probe";

test.use({ viewport: { width: 1440, height: 900 } });

const picked = (page: Page, name: string) => expect(dock(page).getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
const menu = (page: Page) => page.getByRole("menu", { name: "드로잉 메뉴", exact: true });
const keepSaved = (scenario: Scenario) => scenario.documents.uiPrefs().drawing.keepDrawing;
const keepButton = (page: Page) => dock(page).getByRole("button", { name: "연속 그리기", exact: true });

function preset(scenario: Scenario, patch: Record<string, unknown>) {
  const state = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...state, drawing: { ...scenario.documents.uiPrefs().drawing, ...patch }, revision: state.revision + 1 });
}

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await page.mouse.move(5, 5);
}

async function chartRightClick(page: Page) {
  const at = await chartPoint(page, 0.5, 0.6);
  await page.mouse.click(at.x, at.y, { button: "right" });
}

test("단축키로 고른 도구가 막대에서 눌린 상태로 바뀌고 V는 선택 도구로 돌린다", async ({ page }) => {
  await open(page);
  await picked(page, "선택 도구");
  await cell(page).focus();
  await page.keyboard.press("T");
  await picked(page, "추세선");
  await expect(dock(page).getByRole("button", { name: "선택 도구", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("R");
  await picked(page, "사각형");
  await page.keyboard.press("V");
  await picked(page, "선택 도구");
});

test("연속 그리기 버튼은 누를 때마다 켜고 끄며 저장한다", async ({ page, scenario }) => {
  await open(page);
  await keepButton(page).click();
  await expect(keepButton(page)).toHaveAttribute("aria-pressed", "true");
  await pollSaved(() => keepSaved(scenario)).toBe(true);
  await keepButton(page).click();
  await expect(keepButton(page)).toHaveAttribute("aria-pressed", "false");
  await pollSaved(() => keepSaved(scenario)).toBe(false);
});

test("도구를 두 번 눌러 그 도구만 연속으로 두면 다 그린 뒤에도 도구가 남고 Esc로 풀린다", async ({ page, scenario }) => {
  await open(page);
  await dock(page).getByRole("button", { name: "추세선", exact: true }).dblclick();
  await picked(page, "추세선");
  await expect(dock(page).getByRole("button", { name: "추세선", exact: true })).toHaveAttribute("title", /연속/);
  const a = await chartPoint(page, 0.3, 0.6); const b = await chartPoint(page, 0.5, 0.4);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await pollSaved(() => scenario.documents.drawings("005930").length).toBe(1);
  await picked(page, "추세선");
  expect(keepSaved(scenario)).toBe(false);
  await cell(page).focus();
  await page.keyboard.press("Escape");
  await picked(page, "선택 도구");
});

test("연속 그리기를 켠 채 새로고침해도 연속 그리기 설정이 남는다", async ({ page, scenario }) => {
  preset(scenario, { keepDrawing: true });
  await open(page);
  await expect(keepButton(page)).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(keepButton(page)).toHaveAttribute("aria-pressed", "true");
  expect(keepSaved(scenario)).toBe(true);
});

test("연속 그리기가 켜진 채 차트에서 우클릭하면 연속 그리기가 꺼지고 선택 도구가 되며 차트 메뉴는 열리지 않는다", async ({ page, scenario }) => {
  preset(scenario, { keepDrawing: true });
  await open(page);
  await cell(page).focus();
  await page.keyboard.press("T");
  await picked(page, "추세선");
  await chartRightClick(page);
  await picked(page, "선택 도구");
  await expect(keepButton(page)).toHaveAttribute("aria-pressed", "false");
  await pollSaved(() => keepSaved(scenario)).toBe(false);
  await expect(menu(page)).toHaveCount(0);
  await chartRightClick(page);
  await expect(menu(page)).toBeVisible();
});

test("연속 그리기가 켜진 채 그리는 도중 우클릭하면 그리던 것을 취소하고 같은 해제가 일어난다", async ({ page, scenario }) => {
  preset(scenario, { keepDrawing: true });
  await open(page);
  await cell(page).focus();
  await page.keyboard.press("T");
  const start = await chartPoint(page, 0.4, 0.4);
  await page.mouse.click(start.x, start.y);
  await chartRightClick(page);
  await picked(page, "선택 도구");
  await pollSaved(() => keepSaved(scenario)).toBe(false);
  await expect(menu(page)).toHaveCount(0);
  expect(scenario.documents.drawings("005930")).toHaveLength(0);
});

test("연속 그리기가 켜진 채 Esc를 누르면 같은 해제가 일어나고 그리던 것은 취소된다", async ({ page, scenario }) => {
  preset(scenario, { keepDrawing: true });
  await open(page);
  await cell(page).focus();
  await page.keyboard.press("T");
  const start = await chartPoint(page, 0.4, 0.4);
  await page.mouse.click(start.x, start.y);
  await page.keyboard.press("Escape");
  await picked(page, "선택 도구");
  await pollSaved(() => keepSaved(scenario)).toBe(false);
  await expect(menu(page)).toHaveCount(0);
  expect(scenario.documents.drawings("005930")).toHaveLength(0);
});

test("연속 그리기가 꺼져 있으면 우클릭은 차트 메뉴를 열고 Esc는 도구를 푼다", async ({ page, scenario }) => {
  await open(page);
  await cell(page).focus();
  await page.keyboard.press("T");
  await picked(page, "추세선");
  await page.keyboard.press("Escape");
  await picked(page, "선택 도구");
  await expect(menu(page)).toHaveCount(0);
  await chartRightClick(page);
  await expect(menu(page)).toBeVisible();
  expect(keepSaved(scenario)).toBe(false);
});

test("막대 위에서의 우클릭은 연속 그리기를 풀지 않는다", async ({ page, scenario }) => {
  preset(scenario, { keepDrawing: true });
  await open(page);
  await dock(page).getByRole("button", { name: "자석", exact: true }).click({ button: "right" });
  const strength = page.getByRole("menu", { name: "자석 세기", exact: true });
  await expect(strength).toBeVisible();
  const bar = (await dock(page).boundingBox())!;
  expect((await strength.boundingBox())!.x).toBeGreaterThanOrEqual(bar.x + bar.width);
  expect(keepSaved(scenario)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(strength).toBeHidden();
});

test("막대를 숨겨도 ? 단축키 도움말이 열리고 닫으면 보이기 손잡이만 남는다", async ({ page, scenario }) => {
  preset(scenario, { toolbarHidden: true });
  await open(page);
  await expect(dock(page).getByRole("button", { name: "드로잉 도구 막대 보이기", exact: true })).toBeVisible();
  await cell(page).focus();
  await page.keyboard.press("Shift+Slash");
  const help = page.getByRole("dialog", { name: "드로잉 단축키", exact: true });
  await expect(help).toBeVisible();
  await help.getByRole("button", { name: "도움말 닫기", exact: true }).click();
  await expect(help).toBeHidden();
  await expect(dock(page).getByRole("button", { name: "추세선", exact: true })).toHaveCount(0);
});

test("보이기 손잡이를 키보드로 누르면 막대가 나타나고 초점이 활성 칸으로 간다", async ({ page, scenario }) => {
  preset(scenario, { toolbarHidden: true });
  await open(page);
  const handle = dock(page).getByRole("button", { name: "드로잉 도구 막대 보이기", exact: true });
  await handle.focus();
  await page.keyboard.press("Enter");
  await expect(dock(page).getByRole("button", { name: "추세선", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("section")?.getAttribute("aria-label") ?? document.activeElement?.tagName)).toMatch(/^칸 1/);
});
