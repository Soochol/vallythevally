import type { Page } from "@playwright/test";
import type { WatchGroup } from "../src/api/generated/WatchGroup";
import { type Scenario, expect, test, pollSaved } from "./harness";

const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "관심종목에 넣을 종목 검색" });
const input = (page: Page) => dialog(page).getByRole("combobox", { name: "종목 검색" });
const pill = (page: Page, name: string) => dialog(page).getByRole("button", { name: `넣을 곳: ${name}`, exact: true });
const menu = (page: Page) => page.getByRole("menu", { name: "넣을 곳" });
const toast = (page: Page) => page.locator(".ui-toast");
const served = (scenario: Scenario) => scenario.documents.watchlists().lists[0]!;
const servedGroups = (scenario: Scenario) => served(scenario).groups.map((g) => [g.name, g.symbols]);

const GROUPS: WatchGroup[] = [{ id: "g1", name: "반도체", symbols: ["005930"] }, { id: "g2", name: "2차전지", symbols: [] }];

async function seed(scenario: Scenario, symbols = ["005930", "086520"], groups: WatchGroup[] = GROUPS) {
  scenario.documents.saveWatchlists({ revision: 100, lists: [{ id: "L", name: "기본", symbols, groups }] });
}

async function openWatchSearch(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(panel(page).locator('li[data-code="086520"]')).toContainText("에코프로");
  await panel(page).getByRole("button", { name: "관심종목에 넣기" }).click();
  await expect(input(page)).toBeFocused();
}

async function put(page: Page, query: string) {
  await input(page).fill(query);
  const option = dialog(page).getByRole("option").filter({ hasText: query });
  await expect(option).toHaveAttribute("aria-disabled", "false");
  await input(page).press("Enter");
}

test("그룹 머리의 ＋로 열면 그 그룹에 넣고 창을 연 채 이어서 넣는다", async ({ scenario, page }) => {
  await seed(scenario);
  await page.goto("/?symbol=005930");
  await panel(page).getByRole("button", { name: "2차전지 0종목" }).hover();
  await panel(page).getByRole("button", { name: "2차전지에 종목 넣기" }).click();
  await expect(pill(page, "2차전지")).toBeVisible();
  await expect(input(page)).toBeFocused();

  await put(page, "000660");
  await expect(toast(page)).toContainText("SK하이닉스 · 2차전지에 넣었습니다");
  await expect(dialog(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await put(page, "035420");
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", ["005930"]], ["2차전지", ["000660", "035420"]]]);
  expect(served(scenario).symbols).toEqual(["005930", "086520", "000660", "035420"]);
  await dialog(page).getByRole("button", { name: "검색 닫기" }).click();
  await expect(dialog(page)).toBeHidden();
});

test("넣기를 되돌리면 새로 넣은 종목은 목록에서도 빠진다", async ({ scenario, page }) => {
  await seed(scenario);
  await openWatchSearch(page);
  await pill(page, "그룹 없음").click();
  await menu(page).getByRole("menuitemradio", { name: /^2차전지/ }).click();
  await put(page, "000660");
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", ["005930"]], ["2차전지", ["000660"]]]);
  await toast(page).getByRole("button", { name: "되돌리기" }).click();
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", ["005930"]], ["2차전지", []]]);
  expect(served(scenario).symbols).toEqual(["005930", "086520"]);
});

test("이미 목록에 있는 종목은 그룹에만 더하고 되돌리면 그 그룹에서만 뺀다", async ({ scenario, page }) => {
  await seed(scenario);
  await page.goto("/?symbol=005930");
  await panel(page).getByRole("button", { name: "반도체 1종목" }).hover();
  await panel(page).getByRole("button", { name: "반도체에 종목 넣기" }).click();

  await input(page).fill("005930");
  const present = dialog(page).getByRole("option").filter({ hasText: "005930" });
  await expect(present).toContainText("✓ 반도체에 있음");
  await expect(present).toHaveAttribute("aria-disabled", "false");
  await input(page).press("Enter");
  await expect(toast(page)).toContainText("이미 반도체에 있습니다");

  await input(page).fill("086520");
  const other = dialog(page).getByRole("option").filter({ hasText: "086520" });
  await expect(other).toHaveAttribute("aria-disabled", "false");
  await expect(other).not.toContainText("에 있음");
  await input(page).press("Enter");
  await expect(toast(page)).toContainText("에코프로 · 반도체에 넣었습니다");
  await expect(other).toContainText("✓ 반도체에 있음");
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", ["005930", "086520"]], ["2차전지", []]]);
  expect(served(scenario).symbols).toEqual(["005930", "086520"]);

  await toast(page).getByRole("button", { name: "되돌리기" }).click();
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", ["005930"]], ["2차전지", []]]);
  expect(served(scenario).symbols).toEqual(["005930", "086520"]);
});

test("마지막으로 고른 넣을 곳을 기억하고 앱을 다시 열면 그룹 없음이다", async ({ scenario, page }) => {
  await seed(scenario);
  await openWatchSearch(page);
  await expect(pill(page, "그룹 없음")).toBeVisible();
  await pill(page, "그룹 없음").click();
  await expect(menu(page).getByRole("menuitemradio", { name: "그룹 없음" })).toHaveAttribute("aria-checked", "true");
  await expect(menu(page).getByRole("menuitemradio", { name: /^반도체/ })).toContainText("1");
  await menu(page).getByRole("menuitemradio", { name: /^2차전지/ }).click();
  await expect(pill(page, "2차전지")).toBeVisible();
  await input(page).press("Escape");
  await expect(dialog(page)).toBeHidden();

  await panel(page).getByRole("button", { name: "관심종목에 넣기" }).click();
  await expect(pill(page, "2차전지")).toBeVisible();
  await input(page).press("Escape");

  await page.reload();
  await expect(panel(page).locator('li[data-code="086520"]')).toContainText("에코프로");
  await panel(page).getByRole("button", { name: "관심종목에 넣기" }).click();
  await expect(pill(page, "그룹 없음")).toBeVisible();
});

test("알약에서 없는 이름을 쳐 새 그룹을 만들고 그 그룹에 넣는다", async ({ scenario, page }) => {
  await seed(scenario);
  await openWatchSearch(page);
  await pill(page, "그룹 없음").click();
  const filter = menu(page).getByRole("textbox", { name: "넣을 곳 찾기" });
  await expect(filter).toBeFocused();
  await expect(filter).toHaveAttribute("placeholder", "그룹 찾기 또는 새 이름");

  await filter.fill("반도");
  await expect(menu(page).getByRole("menuitemradio")).toHaveText([/^반도체/]);
  await expect(menu(page).getByRole("menuitem", { name: /^'반도' 새 그룹 만들고 넣을 곳으로/ })).toBeEnabled();
  await filter.fill("반도체");
  await expect(menu(page).getByRole("menuitem")).toHaveCount(0);

  await filter.fill("가".repeat(21));
  const tooLong = menu(page).getByRole("menuitem", { name: /새 그룹 만들고 넣을 곳으로/ });
  await expect(tooLong).toBeDisabled();
  await expect(tooLong).toContainText("이름은 20자까지입니다");

  await filter.fill("AI");
  await menu(page).getByRole("menuitem", { name: "'AI' 새 그룹 만들고 넣을 곳으로" }).click();
  await expect(pill(page, "AI")).toBeVisible();
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", ["005930"]], ["2차전지", []], ["AI", []]]);

  await put(page, "000660");
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", ["005930"]], ["2차전지", []], ["AI", ["000660"]]]);
});

test("그룹이 100개면 새 그룹 줄은 비활성이고 사유를 보인다", async ({ scenario, page }) => {
  const full = Array.from({ length: 100 }, (_, i): WatchGroup => ({ id: `G${i}`, name: `그룹 ${i + 1}`, symbols: [] }));
  await seed(scenario, ["005930", "086520"], full);
  await openWatchSearch(page);
  await pill(page, "그룹 없음").click();
  await menu(page).getByRole("textbox", { name: "넣을 곳 찾기" }).fill("새이름");
  const create = menu(page).getByRole("menuitem", { name: /새 그룹 만들고 넣을 곳으로/ });
  await expect(create).toBeDisabled();
  await expect(create).toContainText("그룹은 100개까지입니다");
});

test("Tab으로 알약에 가서 키보드로 고르고 Esc는 메뉴만 닫는다", async ({ scenario, page }) => {
  await seed(scenario);
  await openWatchSearch(page);
  await input(page).press("Tab");
  await expect(pill(page, "그룹 없음")).toBeFocused();
  await page.keyboard.press("Enter");
  const filter = menu(page).getByRole("textbox", { name: "넣을 곳 찾기" });
  await expect(filter).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(dialog(page)).toBeVisible();
  await expect(pill(page, "그룹 없음")).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(filter).toBeFocused();
  await page.keyboard.type("2차");
  await page.keyboard.press("Enter");
  await expect(menu(page)).toHaveCount(0);
  await expect(pill(page, "2차전지")).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(filter).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(menu(page).getByRole("menuitemradio", { name: /^반도체/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(pill(page, "반도체")).toBeFocused();

  await page.keyboard.press("0");
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue("0");
});

test("Ctrl+K 검색에는 알약이 없고 별은 그룹 없음에 넣는다", async ({ scenario, page }) => {
  await seed(scenario);
  await page.goto("/?symbol=005930");
  await panel(page).getByRole("button", { name: "반도체에 종목 넣기" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  const open = page.getByRole("dialog", { name: "종목 검색" });
  await expect(open.getByRole("button", { name: /^넣을 곳/ })).toHaveCount(0);
  await open.getByRole("combobox").fill("000660");
  await expect(open.getByRole("option")).toHaveAttribute("aria-disabled", "false");
  await open.getByRole("combobox").press("Control+Enter");
  await expect(open).toBeHidden();
  await pollSaved(() => served(scenario).symbols).toEqual(["005930", "086520", "000660"]);
  expect(servedGroups(scenario)).toEqual([["반도체", ["005930"]], ["2차전지", []]]);
});

test("휴대폰 폭에서도 알약이 바닥에 보이고 바닥 줄이 넘치지 않는다", async ({ scenario, page }) => {
  await seed(scenario, ["005930", "086520"], [{ id: "g1", name: "아주 긴 이름의 그룹입니다 열여덟자", symbols: [] }]);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await page.getByRole("navigation", { name: "휴대폰 탭" }).getByRole("button", { name: "관심종목" }).click();
  await page.getByRole("region", { name: "관심종목", exact: true }).getByRole("button", { name: "관심종목에 넣기" }).click();
  const bar = dialog(page).locator("div.border-t").last();
  await expect(pill(page, "그룹 없음")).toBeVisible();
  await pill(page, "그룹 없음").click();
  await menu(page).getByRole("menuitemradio", { name: /^아주 긴 이름/ }).click();
  await expect(pill(page, "아주 긴 이름의 그룹입니다 열여덟자")).toBeVisible();
  expect(await bar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  const box = (await pill(page, "아주 긴 이름의 그룹입니다 열여덟자").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(360);
});

test("목록을 바꿨다가 돌아오면 넣을 곳은 그룹 없음이다", async ({ scenario, page }) => {
  scenario.documents.saveWatchlists({ revision: 100, lists: [{ id: "L", name: "기본", symbols: ["005930", "086520"], groups: GROUPS }, { id: "M", name: "둘째", symbols: [], groups: [] }] });
  await page.goto("/?symbol=005930");
  await panel(page).getByRole("button", { name: "반도체에 종목 넣기" }).click();
  await expect(pill(page, "반도체")).toBeVisible();
  await dialog(page).getByRole("button", { name: "검색 닫기" }).click();
  await panel(page).getByRole("button", { name: /^관심종목 목록/ }).click();
  await page.getByRole("menuitemradio", { name: "둘째" }).click();
  await panel(page).getByRole("button", { name: /^관심종목 목록/ }).click();
  await page.getByRole("menuitemradio", { name: "기본" }).click();
  await panel(page).getByRole("button", { name: "관심종목에 넣기" }).click();
  await expect(pill(page, "그룹 없음")).toBeVisible();
});

test("지금 보이는 목록을 다시 골라도 넣을 곳은 그대로다", async ({ scenario, page }) => {
  scenario.documents.saveWatchlists({ revision: 100, lists: [{ id: "L", name: "기본", symbols: ["005930", "086520"], groups: GROUPS }, { id: "M", name: "둘째", symbols: [], groups: [] }] });
  await page.goto("/?symbol=005930");
  await panel(page).getByRole("button", { name: "반도체에 종목 넣기" }).click();
  await dialog(page).getByRole("button", { name: "검색 닫기" }).click();
  await panel(page).getByRole("button", { name: /^관심종목 목록/ }).click();
  await page.getByRole("menuitemradio", { name: "기본" }).click();
  await panel(page).getByRole("button", { name: "관심종목에 넣기" }).click();
  await expect(pill(page, "반도체")).toBeVisible();
});
