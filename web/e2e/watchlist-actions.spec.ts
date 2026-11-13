import { parseChartSettings } from "../src/chart/settings";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const row = (page: Page, code: string) => panel(page).locator(`li[data-code="${code}"]`);
const listButton = (page: Page) => panel(page).getByRole("button", { name: /^관심종목 목록: / });
const codes = (page: Page) => panel(page).locator("li[data-code]").evaluateAll((rows) => rows.map((el) => el.getAttribute("data-code")));

async function seed(scenario: Scenario, symbols = ["005930", "086520", "005935"]) {
  scenario.reply("/api/symbols/0205H0", { body: { code: "0205H0", name: "에스케이증권제14호기업인수목적", kind: "common", market: "kosdaq", nxtEnabled: false } });
  scenario.reply("/api/symbols/0000D0", { body: { code: "0000D0", name: "KODEX 미국배당다우존스타겟커버드콜액티브", kind: "etf", market: "kospi", nxtEnabled: false } });
  scenario.documents.saveWatchlists({ revision: 100, lists: [
    { id: "source", name: "기본", symbols },
    { id: "target", name: "반도체", symbols: [] },
  ] });

}

async function action(page: Page, code: string, name: string) {
  await row(page, code).locator("[data-main]").click({ button: "right" });
  await page.getByRole("menu", { name: /행 동작$/ }).getByRole("menuitem", { name: new RegExp(`^${name}(?: |$)`) }).click();
}

test("13종목이 34px 한 줄로 세로 스크롤 없이 보인다", async ({ scenario, page }) => {
  const symbols = ["005930", "086520", "005935", "000020", "000810", "000815", "0030R0", "900110", "0004Y0", "021045", "03481K", "159910", "0205H0"];
  await seed(scenario, symbols);
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

test("긴 종목명도 숫자 열을 밀지 않고 보통 이름은 기본 폭에서 모두 보인다", async ({ scenario, page }) => {
  const symbols = ["005930", "0205H0", "0000D0", "005490", "207940"];
  await seed(scenario, symbols);
  await page.route("**/api/symbols/005490", (route) => route.fulfill({ json: { code: "005490", name: "POSCO홀딩스", market: "kospi", kind: "common", nxtEnabled: false } }));
  await page.route("**/api/symbols/207940", (route) => route.fulfill({ json: { code: "207940", name: "삼성바이오로직스", market: "kospi", kind: "common", nxtEnabled: false } }));
  await page.route("**/api/quotes?*", (route) => route.fulfill({ json: symbols.map((symbol, i) => ({ symbol, price: i === 0 ? 1296000 : 50300, change: i % 2 ? -300 : 300, changeRate: i % 2 ? -29.99 : 1.5, volume: 1000, t: 1793952000, source: "polled" })) }));
  await page.goto("/?symbol=005930");
  await expect(row(page, "0000D0")).toContainText("50,300");
  await expect(row(page, "0205H0")).toContainText("에스케이증권제14호기업인수목적");
  await expect(row(page, "207940")).toContainText("삼성바이오로직스");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await mkdir(path.resolve("../target/ux-screens"), { recursive: true });
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    const metrics = await panel(page).evaluate((panel) => {
      const el = panel.querySelector("ul")!;
      const box = el.getBoundingClientRect();
      return { left: box.left, right: box.right, client: el.clientWidth, scroll: el.scrollWidth,
        headings: [...panel.querySelectorAll("div[aria-hidden=true] > span")].slice(1).map((cell) => { const box = cell.getBoundingClientRect(); return { left: box.left, right: box.right }; }),
        rows: [...el.querySelectorAll<HTMLButtonElement>("[data-main]")].map((button) => ({
          cells: [...button.children].slice(1).map((cell) => { const rect = cell.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; }),
        })),
      };
    });
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client);
    for (const item of metrics.rows) for (const [index, value] of item.cells.entries()) {
      expect(value.left).toBeGreaterThanOrEqual(metrics.left);
      expect(value.right).toBeLessThanOrEqual(Math.min(metrics.right, size.width));
      expect(value.top).toBeGreaterThanOrEqual(0);
      expect(value.bottom).toBeLessThanOrEqual(size.height);
      expect(value.left).toBeCloseTo(metrics.rows[0]!.cells[index]!.left, 1);
      expect(value.right).toBeCloseTo(metrics.rows[0]!.cells[index]!.right, 1);
      expect(value.left).toBeCloseTo(metrics.headings[index]!.left, 1);
      expect(value.right).toBeCloseTo(metrics.headings[index]!.right, 1);
    }
    for (const code of ["005490", "207940"]) {
      expect(await row(page, code).locator("b").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    for (const code of ["0205H0", "0000D0"]) {
      const name = row(page, code).locator("b");
      await expect(name).toHaveAttribute("title", (await name.textContent())!);
      expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    }
    await page.screenshot({ path: path.resolve(`../target/ux-screens/watchlist-review-${size.width}x${size.height}.png`) });
  }
});

test("되돌리기 직전 최신 조회가 실패하면 서버 목록을 바꾸지 않고 알린다", async ({ scenario, page }) => {
  await seed(scenario);
  await page.goto("/");
  await expect(row(page, "086520")).toContainText("에코프로");
  await action(page, "086520", "관심종목에서 빼기");
  await expect.poll(async () => scenario.documents.watchlists().lists[0]!.symbols).toEqual(["005930", "005935"]);
  const before = scenario.documents.watchlists();
  await page.route("**/api/watchlists", (route) => route.request().method() === "GET"
    ? route.fulfill({ status: 503, json: { error: { code: "internal", message: "연결 실패" } } })
    : route.fallback());
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(page.getByRole("status").getByText("관심종목을 확인하지 못해 되돌리지 않았습니다. 다시 불러와 주세요")).toBeVisible();
  expect(scenario.documents.watchlists()).toEqual(before);
});

test("빼기 저장이 처음 실패해도 되돌린 목록을 다시 저장한다", async ({ scenario, page }) => {
  await seed(scenario);
  await page.goto("/");
  await expect(row(page, "086520")).toContainText("에코프로");
  let failed = false;
  await page.route("**/api/watchlists", (route) => {
    if (route.request().method() === "PUT" && !failed) {
      failed = true;
      return route.fulfill({ status: 503, json: { error: { code: "internal", message: "저장 실패" } } });
    }
    return route.fallback();
  });
  await action(page, "086520", "관심종목에서 빼기");
  await expect(page.getByRole("contentinfo").getByRole("alert")).toContainText("저장하지 못했습니다");
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(row(page, "086520")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toContainText("자동 저장됨");
  expect(scenario.documents.watchlists().lists[0]!.symbols).toEqual(["005930", "086520", "005935"]);
});

test("다른 탭이 복제한 목록을 유지하면서 빠진 종목만 원래 위치에 되돌린다", async ({ scenario, page, context }) => {
  await seed(scenario);
  await page.goto("/");
  await expect(row(page, "086520")).toContainText("에코프로");
  await action(page, "086520", "관심종목에서 빼기");
  await expect.poll(async () => scenario.documents.watchlists().lists[0]!.symbols).toEqual(["005930", "005935"]);
  const other = await context.newPage();
  await other.goto("/");
  await listButton(other).click();
  await other.getByRole("menuitem", { name: "복제", exact: true }).click();
  await expect.poll(async () => scenario.documents.watchlists().lists.length).toBe(3);
  const before = scenario.documents.watchlists();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(async () => scenario.documents.watchlists().lists).toEqual([
    { ...before.lists[0], symbols: ["005930", "086520", "005935"] }, ...before.lists.slice(1),
  ]);
});

test("다른 탭이 같은 목록을 바꾸면 빼기 되돌리기를 비활성화한다", async ({ scenario, page, context }) => {
  await seed(scenario);
  await page.goto("/");
  await expect(row(page, "086520")).toContainText("에코프로");
  await action(page, "086520", "관심종목에서 빼기");
  await expect.poll(async () => scenario.documents.watchlists().lists[0]!.symbols).toEqual(["005930", "005935"]);
  const other = await context.newPage();
  await other.goto("/");
  await expect(row(other, "005935")).toBeVisible();
  await row(other, "005935").locator("[data-main]").press("Alt+ArrowUp");
  await expect.poll(async () => scenario.documents.watchlists().lists[0]!.symbols).toEqual(["005935", "005930"]);
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: "되돌리기", exact: true })).toBeDisabled();
  await expect.poll(() => codes(page)).toEqual(["005935", "005930"]);
});

test("우클릭의 열기·비교·맨 위로·복사와 키보드·끌기를 지원한다", async ({ scenario, page }) => {
  await seed(scenario);
  await page.goto("/");
  await expect(row(page, "086520")).toContainText("에코프로");
  await action(page, "005930", "이 칸에 열기");
  await expect(cell(page)).toHaveAttribute("aria-label", /삼성전자/);
  await action(page, "086520", "비교에 추가");
  await expect(page.getByRole("status").getByText("비교에 추가했습니다: 에코프로")).toBeVisible();
  await expect.poll(async () => parseChartSettings(scenario.documents.layout(DEFAULT_LAYOUT_ID).cells[0]!.chartSettings).compare).toEqual(["086520"]);
  await action(page, "086520", "맨 위로");
  await expect.poll(() => codes(page)).toEqual(["086520", "005930", "005935"]);
  await expect(row(page, "086520").locator("[data-main]")).toBeFocused();
  await row(page, "086520").locator("[data-main]").press("Alt+ArrowDown");
  await expect.poll(() => codes(page)).toEqual(["005930", "086520", "005935"]);
  await row(page, "005935").dragTo(row(page, "005930"));
  await expect.poll(() => codes(page)).toEqual(["005935", "005930", "086520"]);
  await action(page, "086520", "다른 목록에 복사");
  await page.getByRole("menu", { name: /다른 목록으로$/ }).getByRole("menuitem", { name: "반도체", exact: true }).last().click();
  await expect.poll(async () => scenario.documents.watchlists().lists[1]!.symbols).toEqual(["086520"]);
  await expect.poll(() => codes(page)).toEqual(["005935", "005930", "086520"]);
  const button = row(page, "086520").locator("[data-main]");
  await button.focus();
  await button.press("Shift+F10");
  await expect(page.getByRole("menu", { name: /행 동작$/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
});

test("빼기 알림은 원래 위치를 복원하고 다른 목록 편집 뒤에는 되돌리지 않는다", async ({ scenario, page }) => {
  await seed(scenario);
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

test("목록 복제·이름 바꾸기는 순서를 보존하며 목록 지우기는 확인 뒤에만 실행한다", async ({ scenario, page }) => {
  await seed(scenario);
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
