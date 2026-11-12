import type { Page } from "@playwright/test";
import type { Drawing } from "../src/api/generated/Drawing";
import type { Layout } from "../src/api/generated/Layout";
import { cell, DEFAULT_LAYOUT_ID, expect, test, type App } from "./harness";
import { openScreener, panel } from "./screener-page";
import { addCondition, renameScreen, sentenceEditor } from "./sentence-editor";
import { selectOption } from "./select-option";

const savedDrawings = async (app: App): Promise<Drawing[]> => (await fetch(`${app.url}/api/drawings?symbol=005930`)).json();
const visibleDrawings = (page: Page) => cell(page).locator("[data-drawings]").evaluate((node) => {
  const drawings: unknown = JSON.parse(node.getAttribute("data-drawings") ?? "[]");
  if (!Array.isArray(drawings)) throw new Error("드로잉 목록이 아닙니다");
  return drawings.length;
});

async function horizontalLine(page: Page, app: App) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const bounds = await cell(page).boundingBox();
  if (!bounds) throw new Error("차트 영역이 없습니다");
  await cell(page).focus(); await page.keyboard.press("H");
  await page.mouse.click(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.3);
  await expect.poll(async () => (await savedDrawings(app)).length).toBe(1);
}

test("차트 안 굵기 메뉴의 방향키와 Esc는 드로잉 좌표·선택을 바꾸지 않는다", async ({ page, app }) => {
  await horizontalLine(page, app);
  const original = (await savedDrawings(app))[0]!;
  const width = page.getByRole("toolbar", { name: "드로잉 스타일" }).getByRole("combobox", { name: "선 굵기" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await width.click();
    const menu = page.getByRole("menu", { name: "선 굵기", exact: true });
    const current = Number(await width.getAttribute("data-value"));
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitemradio", { name: `${current % 5 + 1}px`, exact: true })).toBeFocused();
    await expect.poll(async () => (await savedDrawings(app))[0]?.points).toEqual(original.points);
    const period = await cell(page).getAttribute("aria-label");
    await page.keyboard.press("Digit5");
    await expect(menu.getByRole("menuitemradio", { name: "5px", exact: true })).toBeFocused();
    await expect(cell(page)).toHaveAttribute("aria-label", period!);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden(); await expect(width).toBeFocused();
    await expect(page.getByRole("toolbar", { name: "드로잉 스타일" })).toBeVisible();
    await expect.poll(() => cell(page).locator("[data-drawings]").evaluate((node) => JSON.parse(node.getAttribute("data-drawings") ?? "[]")[0]?.selected)).toBe(true);
  }
});

test("조건식 배경 누르기는 한 표면만 닫고 중첩 메뉴 아래 미저장 이름을 보존한다", async ({ page }) => {
  await page.goto("/?symbol=005930"); await openScreener(page);
  await panel(page).getByRole("button", { name: "새 조건식", exact: true }).click();
  const editor = sentenceEditor(page);
  await renameScreen(editor, "남겨 둘 조건식");
  await addCondition(editor);
  const number = editor.getByRole("button", { name: "조건 1 최근 기간", exact: true });
  await number.click();
  const popup = page.getByRole("dialog", { name: "조건 1 최근 기간 편집", exact: true });
  await page.mouse.click(10, 10);
  await expect(popup).toBeHidden();
  await number.click();
  await popup.getByRole("textbox").fill("7");
  const trigger = popup.getByRole("combobox", { name: "봉 주기", exact: true });
  await trigger.click(); await page.mouse.click(10, 10);
  await expect(page.getByRole("menu", { name: "봉 주기", exact: true })).toBeHidden();
  await expect(popup).toBeVisible(); await expect(trigger).toBeFocused();
  await expect(popup.getByRole("textbox")).toHaveValue("7");
  await expect(editor.getByRole("button", { name: "조건식 고르기", exact: true })).toHaveText("남겨 둘 조건식");
  await page.keyboard.press("Escape"); await expect(popup).toBeHidden();
  await expect(number).toBeFocused();
  await expect(editor).toBeVisible();
});

for (const outside of ["배경", "부모 제목", "부모 닫기 버튼"] as const) {
  test(`드로잉 색상 선택기 ${outside} 누르기는 설정 초안을 보존한다`, async ({ page, app }) => {
    await horizontalLine(page, app);
    const settings = page.getByRole("dialog", { name: "수평선 세부 설정", exact: true });
    await page.getByRole("button", { name: "드로잉 세부 설정", exact: true }).click();
    await page.mouse.click(10, 10); await expect(settings).toBeHidden();
    await page.getByRole("button", { name: "드로잉 세부 설정", exact: true }).click();
    const width = settings.getByRole("combobox", { name: "선 굵기", exact: true });
    await selectOption(width, "4");
    const trigger = settings.getByRole("button", { name: "선 색 선택", exact: true });
    await trigger.click();
    const color = page.getByRole("dialog", { name: "선 색", exact: true });
    await expect(color).toBeVisible();
    if (outside === "배경") await page.mouse.click(10, 10);
    else if (outside === "부모 닫기 버튼") await settings.getByRole("button", { name: "세부 설정 닫기", exact: true }).click();
    else await settings.locator("strong").filter({ hasText: /^수평선$/ }).click();
    await expect(color).toBeHidden(); await expect(settings).toBeVisible();
    await expect(trigger).toBeFocused(); await expect(width).toHaveAttribute("data-value", "4");
  });
}

for (const source of ["전체 막대", "선택 막대", "개체 메뉴", "차트 메뉴"] as const) {
  test(`${source}의 삭제 알림은 Ctrl+Z 후 다른 작업을 되돌리지 않는다`, async ({ page, app }) => {
    await horizontalLine(page, app);
    const original = (await savedDrawings(app))[0]!;
    if (source === "전체 막대") {
      await page.getByRole("button", { name: "개체 목록 열기", exact: true }).click();
      await page.getByRole("button", { name: "이 종목 드로잉 모두 지우기", exact: true }).click();
    }
    else if (source === "선택 막대") await page.getByRole("button", { name: "드로잉 지우기", exact: true }).click();
    else if (source === "개체 메뉴") {
      await page.getByRole("button", { name: "드로잉 더 보기", exact: true }).click();
      await page.getByRole("menu", { name: "드로잉 메뉴", exact: true }).getByRole("menuitem", { name: "지우기", exact: true }).click();
    }
    else {
      const bounds = await cell(page).boundingBox();
      if (!bounds) throw new Error("차트 영역이 없습니다");
      await page.mouse.click(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.15, { button: "right" });
      await page.getByRole("menu", { name: "드로잉 메뉴", exact: true }).getByRole("menuitem", { name: "이 종목 드로잉 모두 지우기…", exact: true }).click();
    }
    await expect.poll(() => visibleDrawings(page)).toBe(0);
    await expect.poll(async () => (await savedDrawings(app)).length).toBe(0);
    const undo = page.getByRole("status").filter({ hasText: /드로잉.*지웠습니다/ }).getByRole("button", { name: "되돌리기", exact: true });
    await expect(undo).toBeEnabled();
    await cell(page).focus(); await page.keyboard.press("Control+z");
    await expect.poll(() => visibleDrawings(page)).toBe(1);
    await expect.poll(async () => (await savedDrawings(app)).map((d) => ({ id: d.id, points: d.points }))).toEqual([{ id: original.id, points: original.points }]);
    await expect(undo).toBeDisabled(); await undo.dispatchEvent("click");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => visibleDrawings(page)).toBe(1);
    await expect.poll(async () => (await savedDrawings(app)).map((d) => ({ id: d.id, points: d.points }))).toEqual([{ id: original.id, points: original.points }]);
    await cell(page).focus(); await page.keyboard.press("Control+Shift+z");
    await expect.poll(() => visibleDrawings(page)).toBe(0);
    await expect.poll(async () => (await savedDrawings(app)).length).toBe(0);
    await expect(undo).toBeDisabled(); await undo.dispatchEvent("click");
    await expect.poll(() => visibleDrawings(page)).toBe(0);
    await expect.poll(async () => (await savedDrawings(app)).length).toBe(0);
  });
}

test.describe("재무 자료의 중첩 DOM 메뉴", () => {
  test.use({ financialFixture: true, clockStart: "20171231120000" });
  test("보고기간 이름·방향키·Space·Enter·글자 이동과 단계별 Esc를 지킨다", async ({ page, app }) => {
    const layout: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
    expect((await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...layout, revision: layout.revision + 1, cells: [{ ...layout.cells[0], symbol: "005930", venue: "combined", period: "Y", chartSettings: { v: 2, style: "candle", scale: "normal", compare: [], indicators: [{ id: "revenue", spec: { kind: "revenue" }, panel: "revenue", visible: true, style: { colors: ["ind-2"], width: 1 } }], panels: [{ id: "revenue", stretch: 0.3 }] } }] }) })).ok).toBe(true);
    await page.goto("/");
    const row = page.locator('[data-indicator-row="revenue"]');
    await expect(row).toContainText("확인 완료");
    const summary = row.locator("summary");
    await summary.click(); await page.keyboard.press("Escape");
    await expect(row.locator("details")).not.toHaveAttribute("open", ""); await expect(summary).toBeFocused();
    await summary.click();
    const trigger = row.getByRole("combobox", { name: "보고기간 자료", exact: true });
    await expect(trigger).toHaveAttribute("aria-label", "보고기간 자료");
    await trigger.click();
    const menu = page.getByRole("menu", { name: "보고기간 자료", exact: true });
    const reports = menu.getByRole("menuitemradio");
    await page.keyboard.press("ArrowDown"); await expect(reports.nth(1)).toBeFocused();
    await page.keyboard.press("Space"); await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute("data-value", "1"); await expect(trigger).toBeFocused();
    await trigger.click(); await page.keyboard.press("Home"); await page.keyboard.press("Enter");
    await expect(menu).toBeHidden(); await expect(trigger).toHaveAttribute("data-value", "0");
    await trigger.click(); await page.keyboard.press("End");
    await menu.dispatchEvent("keydown", { key: "차", bubbles: true });
    await expect(reports.first()).toBeFocused();
    await page.keyboard.press("Escape"); await expect(menu).toBeHidden(); await expect(trigger).toBeFocused();
    await expect(row.locator("details")).toHaveAttribute("open", "");
    await page.keyboard.press("Escape"); await expect(row.locator("details")).not.toHaveAttribute("open", ""); await expect(summary).toBeFocused();
  });
});
