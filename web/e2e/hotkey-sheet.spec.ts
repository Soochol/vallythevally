import type { Page } from "@playwright/test";
import { type Scenario, cell, expect, SEARCH_BUTTON_TITLE, test } from "./harness";

test.use({ viewport: { width: 1440, height: 900 } });

const sheet = (page: Page) => page.getByRole("dialog", { name: "단축키", exact: true });

async function openWorkspace(page: Page) {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

function seedHotkeys(scenario: Scenario, hotkeys: Record<string, string[]>) {
  const state = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...state, hotkeys, revision: state.revision + 1 } as typeof state);
}

test("작업 영역에서 ?를 누르면 단축키 판이 열리고 Esc로 닫히며 초점이 돌아온다", async ({ page }) => {
  await openWorkspace(page);
  await expect(sheet(page)).toHaveCount(0);
  const searchButton = page.getByTitle(SEARCH_BUTTON_TITLE);
  await searchButton.focus();
  await page.keyboard.press("Shift+Slash");
  await expect(sheet(page)).toBeVisible();
  for (const label of ["찾기·이동", "차트", "창 배치", "드로잉"]) await expect(sheet(page).getByRole("region", { name: label, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(searchButton).toBeFocused();
});

test("찾기 입력 칸에 초점이 있으면 ?는 글자로 들어가고 판은 열리지 않는다", async ({ page }) => {
  await openWorkspace(page);
  await page.keyboard.press("/");
  const search = page.getByRole("dialog", { name: "종목 검색", exact: true });
  const input = search.getByRole("combobox");
  await expect(input).toBeFocused();
  await input.press("Shift+Slash");
  await expect(input).toHaveValue("?");
  await expect(sheet(page)).toHaveCount(0);
  await expect(search).toBeVisible();
});

test("판에서 배치로 찾으면 배치 되돌리기 줄만 남는다", async ({ page }) => {
  await openWorkspace(page);
  await page.keyboard.press("Shift+Slash");
  await sheet(page).getByRole("textbox", { name: "단축키 찾기", exact: true }).fill("배치");
  const lines = sheet(page).getByRole("listitem");
  await expect(lines).toHaveCount(1);
  await expect(lines).toContainText("배치 되돌리기");
  await expect(lines.locator("kbd")).toHaveText(["Ctrl", "Z"]);
  await sheet(page).getByRole("textbox", { name: "단축키 찾기", exact: true }).fill("없는동작");
  await expect(sheet(page)).toContainText("맞는 단축키가 없습니다");
});

test("시스템 설정에서 바꾼 키가 판에 보이고 바꾸기는 단축키 메뉴를 연다", async ({ page, scenario }) => {
  seedHotkeys(scenario, { search: ["Alt+KeyQ"] });
  await openWorkspace(page);
  await page.keyboard.press("Shift+Slash");
  const line = sheet(page).getByRole("listitem").filter({ hasText: "종목 검색" });
  await expect(line.locator("kbd")).toHaveText(["Alt", "Q"]);
  await sheet(page).getByRole("button", { name: "바꾸기", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "시스템 설정", exact: true }).getByRole("tab", { name: "단축키", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("레일의 단축키가 판을 연다", async ({ page }) => {
  await openWorkspace(page);
  const rail = page.getByRole("navigation", { name: "페이지 메뉴", exact: true });
  await expect(rail.getByRole("button", { name: "설정" })).toHaveCount(0);
  await rail.getByRole("button", { name: "단축키", exact: true }).click();
  await expect(sheet(page)).toBeVisible();
});
