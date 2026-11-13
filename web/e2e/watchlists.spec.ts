import type { Page } from "@playwright/test";
import { type Scenario, expect, test } from "./harness";

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
  await menu(page).getByRole("menuitemradio", { name: new RegExp(`^${name}\\s*\\d+$`) }).click();
  await expect(listButton(page)).toHaveAccessibleName(`관심종목 목록: ${name}`);
}

const codes = (page: Page) => panel(page).locator("li[data-code]").evaluateAll((li) => li.map((e) => e.getAttribute("data-code")));

test("목록 셋, 목록마다의 순서, 고른 열이 새로고침 뒤에도 그대로다", async ({ page }) => {
  await page.goto("/");
  await expect(listButton(page)).toHaveAccessibleName("관심종목 목록: 기본");
  await addToActiveList(page, "에코프로", "086520");
  await addToActiveList(page, "005930", "005930");

  await createList(page, "반도체");
  await addToActiveList(page, "005930", "005930");

  await switchTo(page, "기본");
  await panel(page).locator('li[data-code="086520"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "다른 목록에 복사", exact: true }).click();
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
    await expect(menu(page).getByRole("menuitemradio")).toHaveText(["기본2", "반도체2", "빈 목록0"]);
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
  await page.getByRole("dialog").getByRole("button", { name: "확인", exact: true }).click();
  await expect(listButton(page)).toHaveAccessibleName("관심종목 목록: 기본");
  await openListMenu(page);
  await expect(menu(page).getByRole("menuitemradio")).toHaveText(["기본0"]);
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

async function seed(scenario: Scenario, lists: { id: string; name: string; symbols: string[] }[]) {
  scenario.documents.saveWatchlists({ lists, revision: 100 });
}

test("휴대폰에서 목록이 20개여도 옮기기·복사 메뉴의 모든 대상을 누를 수 있다", async ({ scenario, page }) => {
  const symbols = Array.from({ length: 20 }, (_, i) => String(100_000 + i));
  await seed(scenario, Array.from({ length: 20 }, (_, i) => ({ id: `L${i}`, name: `목록 ${i}`, symbols: i === 0 ? symbols : [] })));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("navigation", { name: "휴대폰 탭" }).getByRole("button", { name: "관심종목" }).click();
  const sheet = page.getByRole("region", { name: "관심종목", exact: true });
  await sheet.getByRole("button", { name: "편집", exact: true }).click();

  for (const code of [symbols[0], symbols[6], symbols.at(-1)]) {
    const transfer = sheet.locator(`li[data-code="${code}"]`).getByRole("button", { name: /다른 목록으로$/ });
    await transfer.scrollIntoViewIfNeeded();
    await transfer.click();
    const transferMenu = page.getByRole("menu", { name: /다른 목록으로$/ });
    const box = (await transferMenu.boundingBox())!;
    expect(box.y, code).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, code).toBeLessThanOrEqual(844);
    const targets = transferMenu.getByRole("menuitem");
    await expect(targets).toHaveCount(38);
    for (const target of await targets.all()) await target.click({ trial: true, timeout: 2_000 });
    await targets.last().click();
    await expect(page.getByText(new RegExp(`^복사했습니다: .+ → 목록 19$`))).toBeVisible();
  }
});

test("값 열을 모두 꺼도 패널의 기본 폭을 유지하고 종목 이름이 보인다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "L0", name: "기본", symbols: ["005930"] }]);
  await page.goto("/?symbol=005930");
  const stock = panel(page).locator('li[data-code="005930"]');
  await expect(stock).toContainText("삼성전자");
  const before = (await panel(page).boundingBox())!.width;

  await openListMenu(page);
  await menu(page).getByRole("menuitemcheckbox", { name: "현재가", exact: true }).click();
  await menu(page).getByRole("menuitemcheckbox", { name: "등락률", exact: true }).click();
  await expect(menu(page).getByRole("menuitemcheckbox", { checked: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await expect.poll(async () => (await panel(page).boundingBox())!.width).toBe(before);
  await expect(stock).toBeVisible();
  await expect(stock).toContainText("삼성전자");
  await expect(panel(page).getByRole("region", { name: "종목 정보" })).toHaveCount(0);
});
