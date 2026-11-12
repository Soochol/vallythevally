import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { cell, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const row = (page: Page, code: string) => panel(page).locator(`li[data-code="${code}"]`);
const listButton = (page: Page) => panel(page).getByRole("button", { name: /^관심종목 목록: / });
const codes = (page: Page) => panel(page).locator("li[data-code]").evaluateAll((rows) => rows.map((el) => el.getAttribute("data-code")));

async function seed(page: Page, symbols = ["005930", "086520", "005935"]) {
  const response = await page.request.put("/api/watchlists", { data: { revision: 100, lists: [
    { id: "source", name: "기본", symbols },
    { id: "target", name: "반도체", symbols: [] },
  ] } });
  expect(response.ok()).toBe(true);
}

async function action(page: Page, code: string, name: string) {
  await row(page, code).locator("[data-main]").click({ button: "right" });
  await page.getByRole("menu", { name: /행 동작$/ }).getByRole("menuitem", { name: new RegExp(`^${name}(?: |$)`) }).click();
}

test("13종목이 34px 한 줄로 보이고 이름을 자르지 않으며 화면 안에서 스크롤한다", async ({ page }) => {
  const symbols = ["005930", "086520", "005935", "000020", "000810", "000815", "0030R0", "900110", "0004Y0", "021045", "03481K", "159910", "0205H0"];
  await seed(page, symbols);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(row(page, "0205H0")).toContainText("에스케이증권제14호기업인수목적");
  const longCode = row(page, "0205H0").locator("[data-main] > span:first-child small");
  expect(await longCode.evaluate((el) => el.clientWidth < el.scrollWidth)).toBe(true);
  const list = panel(page).getByRole("list");
  await expect(list.locator("li")).toHaveCount(13);
  await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);
  for (const item of await list.locator("li").all()) {
    await expect(item).toHaveJSProperty("offsetHeight", 34);
    const name = item.locator("b");
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await name.evaluate((el) => getComputedStyle(el).textOverflow)).not.toBe("ellipsis");
  }
  await expect(panel(page).getByText("끌거나 Alt+↑↓로 순서를 바꿉니다", { exact: true })).toHaveCount(0);
  await mkdir(path.resolve("../target/ux-screens"), { recursive: true });
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    await expect.poll(() => page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight])).toEqual([0, 0]);
    await page.screenshot({ path: path.resolve(`../target/ux-screens/watchlist-${size.width}x${size.height}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("navigation", { name: "휴대폰 탭" }).getByRole("button", { name: "관심종목" }).click();
  await page.screenshot({ path: path.resolve("../target/ux-screens/watchlist-390x844.png") });
});

test("우클릭의 열기·비교·맨 위로·복사와 키보드·끌기를 지원한다", async ({ page }) => {
  await seed(page);
  await page.goto("/");
  await expect(row(page, "086520")).toContainText("에코프로");
  await action(page, "005930", "이 칸에 열기");
  await expect(cell(page)).toHaveAttribute("aria-label", /삼성전자/);
  await action(page, "086520", "비교에 추가");
  await expect(page.getByRole("status").getByText("비교에 추가했습니다: 에코프로")).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/layouts/${DEFAULT_LAYOUT_ID}`)).json()).cells[0].chartSettings.compare).toEqual(["086520"]);
  await action(page, "086520", "맨 위로");
  await expect.poll(() => codes(page)).toEqual(["086520", "005930", "005935"]);
  await expect(row(page, "086520").locator("[data-main]")).toBeFocused();
  await row(page, "086520").locator("[data-main]").press("Alt+ArrowDown");
  await expect.poll(() => codes(page)).toEqual(["005930", "086520", "005935"]);
  await row(page, "005935").dragTo(row(page, "005930"));
  await expect.poll(() => codes(page)).toEqual(["005935", "005930", "086520"]);
  await action(page, "086520", "다른 목록에 복사");
  await page.getByRole("menu", { name: /다른 목록으로$/ }).getByRole("menuitem", { name: "반도체", exact: true }).last().click();
  await expect.poll(async () => (await (await page.request.get("/api/watchlists")).json()).lists[1].symbols).toEqual(["086520"]);
  await expect.poll(() => codes(page)).toEqual(["005935", "005930", "086520"]);
  const button = row(page, "086520").locator("[data-main]");
  await button.focus();
  await button.press("Shift+F10");
  await expect(page.getByRole("menu", { name: /행 동작$/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
});

test("빼기 알림은 원래 위치를 복원하고 다른 목록 편집 뒤에는 되돌리지 않는다", async ({ page }) => {
  await seed(page);
  await page.goto("/");
  await expect(row(page, "086520")).toContainText("에코프로");
  await action(page, "086520", "관심종목에서 빼기");
  await expect.poll(() => codes(page)).toEqual(["005930", "005935"]);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(() => codes(page)).toEqual(["005930", "086520", "005935"]);
  await action(page, "086520", "관심종목에서 빼기");
  await row(page, "005935").locator("[data-main]").press("Alt+ArrowUp");
  await expect(page.getByRole("button", { name: "되돌리기", exact: true })).toBeDisabled();
  await expect.poll(() => codes(page)).toEqual(["005935", "005930"]);
});

test("목록 복제·이름 바꾸기는 순서를 보존하며 목록 지우기는 확인 뒤에만 실행한다", async ({ page }) => {
  await seed(page);
  await page.goto("/");
  await listButton(page).click();
  const menu = page.getByRole("menu", { name: "관심종목 목록", exact: true });
  await expect(menu.getByRole("menuitemradio").first()).toHaveText("기본3");
  await menu.getByRole("menuitem", { name: "복제", exact: true }).click();
  await expect(listButton(page)).toHaveAccessibleName("관심종목 목록: 기본 복사");
  await expect.poll(() => codes(page)).toEqual(["005930", "086520", "005935"]);
  await listButton(page).click();
  await menu.getByRole("menuitem", { name: "이름 바꾸기", exact: true }).click();
  const input = panel(page).getByRole("textbox", { name: "목록 이름", exact: true });
  await input.fill("장기 관찰");
  await input.press("Enter");
  await expect(listButton(page)).toHaveAccessibleName("관심종목 목록: 장기 관찰");
  await listButton(page).click();
  await menu.getByRole("menuitem", { name: "목록 지우기", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
  await expect(listButton(page)).toHaveAccessibleName("관심종목 목록: 장기 관찰");
  await listButton(page).click();
  await menu.getByRole("menuitem", { name: "목록 지우기", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "확인", exact: true }).click();
  await expect(listButton(page)).toHaveAccessibleName("관심종목 목록: 반도체");
  await page.reload();
  await expect(listButton(page)).toHaveAccessibleName("관심종목 목록: 반도체");
});
