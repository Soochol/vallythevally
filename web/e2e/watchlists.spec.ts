import type { Page } from "@playwright/test";
import { expect, test } from "./harness";

const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const listButton = (page: Page) => panel(page).getByRole("button", { name: /^관심종목 목록: / });
const menu = (page: Page) => page.getByRole("menu", { name: "관심종목 목록" });

async function openListMenu(page: Page) {
  await listButton(page).click();
  await expect(menu(page)).toBeVisible();
}

async function addToActiveList(page: Page, query: string, code: string) {
  await panel(page).getByRole("button", { name: "관심종목에 넣기" }).click();
  const dialog = page.getByRole("dialog", { name: "관심종목에 넣을 종목 검색" });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill(query);
  await dialog.getByRole("option").filter({ hasText: code }).first().click();
  await expect(panel(page).locator(`li[data-code="${code}"]`)).toBeVisible();
}

async function createList(page: Page, name: string) {
  await openListMenu(page);
  await menu(page).getByRole("menuitem", { name: "새 목록" }).click();
  await panel(page).getByRole("textbox", { name: "새 목록 이름" }).fill(name);
  await panel(page).getByRole("textbox", { name: "새 목록 이름" }).press("Enter");
  await expect(listButton(page)).toHaveAccessibleName(`관심종목 목록: ${name}`);
}

async function switchTo(page: Page, name: string) {
  await openListMenu(page);
  await menu(page).getByRole("menuitemradio", { name }).click();
  await expect(listButton(page)).toHaveAccessibleName(`관심종목 목록: ${name}`);
}

const codes = (page: Page) => panel(page).locator("li[data-code]").evaluateAll((li) => li.map((e) => e.getAttribute("data-code")));

test("목록 셋, 목록마다의 순서, 고른 열이 새로고침과 서버 재시작 뒤에도 그대로다", async ({ app, page }) => {
  await page.goto("/");
  await expect(listButton(page)).toHaveAccessibleName("관심종목 목록: 기본");
  await addToActiveList(page, "에코프로", "086520");
  await addToActiveList(page, "005930", "005930");

  await createList(page, "반도체");
  await addToActiveList(page, "005930", "005930");

  await switchTo(page, "기본");
  await panel(page).locator('li[data-code="086520"]').hover();
  await panel(page).getByRole("button", { name: /다른 목록으로$/ }).first().click();
  await page.getByRole("menu", { name: /다른 목록으로$/ }).getByRole("menuitem", { name: "반도체" }).nth(1).click();
  await expect(page.getByText("복사했습니다: 에코프로 → 반도체")).toBeVisible();

  await createList(page, "빈 목록");

  await openListMenu(page);
  await menu(page).getByRole("menuitemcheckbox", { name: "거래량" }).click();
  await menu(page).getByRole("menuitemcheckbox", { name: "등락률" }).click();
  await expect(menu(page).getByRole("menuitemcheckbox", { name: "거래량" })).toHaveAttribute("aria-checked", "true");
  const uiSaved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/ui-state") && r.ok());
  await page.keyboard.press("Escape");
  await uiSaved;
  await expect(page.getByRole("contentinfo").getByText(/자동 저장됨/)).toBeVisible();

  const expectRestored = async () => {
    await expect(listButton(page)).toHaveAccessibleName("관심종목 목록: 빈 목록");
    await expect(panel(page).getByText("빈 목록에 종목이 없습니다")).toBeVisible();
    await openListMenu(page);
    await expect(menu(page).getByRole("menuitemradio")).toHaveText(["기본", "반도체", "빈 목록"]);
    await expect(menu(page).getByRole("menuitemcheckbox", { checked: true })).toHaveText(["현재가", "거래량"]);
    await page.keyboard.press("Escape");
    await expect(panel(page).locator('div[aria-hidden="true"]').filter({ hasText: /^종목/ }).locator("span")).toHaveText(["종목", "현재가", "거래량"]);

    await switchTo(page, "기본");
    await expect.poll(() => codes(page)).toEqual(["086520", "005930"]);
    await switchTo(page, "반도체");
    await expect.poll(() => codes(page)).toEqual(["005930", "086520"]);
    const uiSaved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/ui-state") && r.ok());
    await switchTo(page, "빈 목록");
    await uiSaved;
  };
  await page.reload();
  await expectRestored();

  await app.restart();
  await page.reload();
  await expectRestored();
});

test("마지막 목록은 지울 수 없고, 지운 목록 대신 이웃 목록을 본다", async ({ page }) => {
  await page.goto("/");
  await openListMenu(page);
  await expect(menu(page).getByRole("menuitem", { name: "목록 지우기" })).toBeDisabled();
  await page.keyboard.press("Escape");

  await createList(page, "지울 목록");
  await openListMenu(page);
  await menu(page).getByRole("menuitem", { name: "목록 지우기" }).click();
  await expect(listButton(page)).toHaveAccessibleName("관심종목 목록: 기본");
  await openListMenu(page);
  await expect(menu(page).getByRole("menuitemradio")).toHaveText(["기본"]);
});

test("이름이 겹치면 만들지 않고 까닭을 보인다", async ({ page }) => {
  await page.goto("/");
  await openListMenu(page);
  await menu(page).getByRole("menuitem", { name: "새 목록" }).click();
  const input = panel(page).getByRole("textbox", { name: "새 목록 이름" });
  await input.fill(" 기본 ");
  await expect(panel(page).getByRole("alert")).toHaveText("같은 이름의 목록이 있습니다");
  await input.press("Enter");
  await expect(input).toBeVisible();
  await input.press("Escape");
  await expect(listButton(page)).toHaveAccessibleName("관심종목 목록: 기본");
});
