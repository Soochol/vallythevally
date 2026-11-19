import type { Page } from "@playwright/test";
import type { WatchGroup } from "../src/api/generated/WatchGroup";
import { type Scenario, expect, test, pollSaved } from "./harness";

const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const row = (page: Page, code: string) => panel(page).locator(`li[data-code="${code}"]`);
const codes = (page: Page) => panel(page).locator("li[data-code]").evaluateAll((rows) => rows.map((el) => el.getAttribute("data-code")));
const groupHead = (page: Page, name: string) => panel(page).getByRole("button", { name: new RegExp(`^${name} \\d+종목$`) });
const groupMenu = (page: Page, name: string) => panel(page).getByRole("button", { name: `${name} 그룹 메뉴`, exact: true });
const served = (scenario: Scenario) => scenario.documents.watchlists().lists[0]!;
const servedGroups = (scenario: Scenario) => served(scenario).groups.map((g) => [g.name, g.symbols]);

async function seed(scenario: Scenario, groups: WatchGroup[] = []) {
  scenario.documents.saveWatchlists({ revision: 100, lists: [
    { id: "L", name: "기본", symbols: ["005930", "086520", "005935", "000660"], groups },
    { id: "other", name: "다른 목록", symbols: [] },
  ] });
}

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(row(page, "086520")).toContainText("에코프로");
}

async function moveToGroup(page: Page, code: string, group: string) {
  await row(page, code).locator("[data-main]").click({ button: "right" });
  await page.getByRole("menu", { name: /행 동작$/ }).getByRole("menuitem", { name: "그룹으로 옮기기", exact: true }).click();
  await page.getByRole("menu", { name: /그룹으로 옮기기$/ }).getByRole((group === "새 그룹…" || group === "이 그룹에서 빼기") ? "menuitem" : "menuitemradio", { name: group, exact: true }).click();
}

async function nameGroup(page: Page, name: string) {
  const input = panel(page).getByRole("textbox", { name: "그룹 이름" });
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press("Enter");
  await expect(input).toHaveCount(0);
}

test("그룹이 없으면 그룹 머리 없이 지금과 같은 한 목록으로 보이고 그룹 없이 저장한다", async ({ scenario, page }) => {
  await seed(scenario);
  await open(page);
  await expect(panel(page).getByRole("list")).toHaveCount(1);
  await expect(panel(page).getByRole("list")).toHaveAccessibleName("기본");
  await expect(panel(page).getByText("그룹 없음")).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: /그룹 메뉴$/ })).toHaveCount(0);
  expect(await codes(page)).toEqual(["005930", "086520", "005935", "000660"]);
  await row(page, "000660").locator("[data-main]").press("Alt+ArrowUp");
  await pollSaved(() => served(scenario).symbols).toEqual(["005930", "086520", "000660", "005935"]);
  expect(served(scenario).groups).toEqual([]);
});

test("그룹을 만들고 이름을 바꾸고 접으며 접힘은 관심종목 저장 순서를 올리지 않는다", async ({ scenario, page }) => {
  await seed(scenario);
  await open(page);
  await panel(page).getByRole("button", { name: "새 그룹", exact: true }).click();
  await expect(panel(page).getByRole("textbox", { name: "그룹 이름" })).toHaveValue("그룹 1");
  await nameGroup(page, "반도체");
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", []]]);
  await expect(groupHead(page, "반도체")).toHaveAccessibleName("반도체 0종목");
  await expect(panel(page).getByText("그룹 없음", { exact: true })).toBeVisible();

  await groupMenu(page, "반도체").click();
  await page.getByRole("menuitem", { name: "이름 바꾸기", exact: true }).click();
  const input = panel(page).getByRole("textbox", { name: "그룹 이름" });
  await input.fill("  ");
  await expect(panel(page).getByRole("alert")).toHaveText("이름을 입력하세요");
  await nameGroup(page, "칩");
  await pollSaved(() => servedGroups(scenario)).toEqual([["칩", []]]);

  await moveToGroup(page, "086520", "칩");
  await moveToGroup(page, "005935", "칩");
  await pollSaved(() => servedGroups(scenario)).toEqual([["칩", ["086520", "005935"]]]);
  expect(await codes(page)).toEqual(["086520", "005935", "005930", "000660"]);

  const revision = scenario.documents.watchlists().revision;
  await groupHead(page, "칩").click();
  await expect(groupHead(page, "칩")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "086520")).toHaveCount(0);
  const id = served(scenario).groups[0]!.id;
  await pollSaved(() => scenario.documents.uiPrefs().collapsedWatchGroups).toEqual([id]);
  expect(scenario.documents.watchlists().revision).toBe(revision);
  await groupHead(page, "칩").click();
  await expect(row(page, "086520")).toBeVisible();
  await pollSaved(() => scenario.documents.uiPrefs().collapsedWatchGroups).toEqual([]);
});

test("종목을 그룹 사이와 그룹 없음으로 옮기고 우클릭 메뉴에 지금 그룹을 표시한다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "반도체", symbols: ["005935"] }, { id: "B", name: "2차전지", symbols: ["086520"] }]);
  await open(page);
  expect(await codes(page)).toEqual(["005935", "086520", "005930", "000660"]);

  await row(page, "086520").locator("[data-main]").click({ button: "right" });
  await page.getByRole("menuitem", { name: "그룹으로 옮기기", exact: true }).click();
  const groups = page.getByRole("menu", { name: /그룹으로 옮기기$/ });
  await expect(groups.getByRole("menuitemradio")).toHaveText(["반도체", "2차전지"]);
  await expect(groups.getByRole("menuitemradio", { checked: true })).toHaveText("2차전지");
  await groups.getByRole("menuitemradio", { name: "반도체", exact: true }).click();
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", ["005935", "086520"]], ["2차전지", []]]);
  await expect(row(page, "086520").locator("[data-main]")).toBeFocused();

  await groupHead(page, "2차전지").click();
  await moveToGroup(page, "005930", "2차전지");
  await expect(groupHead(page, "2차전지")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "005930").locator("[data-main]")).toBeFocused();
  await moveToGroup(page, "005930", "이 그룹에서 빼기");
  await moveToGroup(page, "005935", "이 그룹에서 빼기");
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", ["086520"]], ["2차전지", []]]);
  expect(await codes(page)).toEqual(["086520", "005930", "005935", "000660"]);

  await moveToGroup(page, "000660", "새 그룹…");
  await nameGroup(page, "관찰");
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", ["086520"]], ["2차전지", []], ["관찰", ["000660"]]]);
  expect(served(scenario).symbols).toEqual(["005930", "086520", "005935", "000660"]);
});

test("키보드로 바꾸는 종목 순서는 같은 그룹 안에서만 움직인다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "반도체", symbols: ["005935", "086520"] }]);
  await open(page);
  const main = row(page, "086520").locator("[data-main]");
  await main.press("Alt+ArrowUp");
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", ["086520", "005935"]]]);
  await expect(main).toBeFocused();
  await main.press("Alt+ArrowUp");
  await row(page, "005930").locator("[data-main]").press("Alt+ArrowUp");
  await row(page, "000660").locator("[data-main]").press("Alt+ArrowUp");
  await pollSaved(() => served(scenario).symbols).toEqual(["000660", "086520", "005935", "005930"]);
  expect(servedGroups(scenario)).toEqual([["반도체", ["086520", "005935"]]]);
  expect(await codes(page)).toEqual(["086520", "005935", "000660", "005930"]);
});

test("그룹을 옮기고 풀고 지운다. 지울 때는 확인하고 종목도 뺀다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "반도체", symbols: ["005935"] }, { id: "B", name: "2차전지", symbols: ["086520"] }]);
  await open(page);
  await groupMenu(page, "2차전지").click();
  await page.getByRole("menuitem", { name: "위로 옮기기", exact: true }).click();
  await pollSaved(() => servedGroups(scenario)).toEqual([["2차전지", ["086520"]], ["반도체", ["005935"]]]);

  await groupMenu(page, "반도체").click();
  await page.getByRole("menuitem", { name: "그룹 풀기", exact: true }).click();
  await pollSaved(() => servedGroups(scenario)).toEqual([["2차전지", ["086520"]]]);
  expect(served(scenario).symbols).toContain("005935");

  await groupMenu(page, "2차전지").click();
  await page.getByRole("menuitem", { name: "그룹 지우기", exact: true }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText("2차전지 그룹과 그 안의 1종목을 지웁니다. 다른 그룹에도 있는 종목은 남습니다");
  await confirm.getByRole("button", { name: "그룹 지우기", exact: true }).click();
  await pollSaved(() => served(scenario)).toMatchObject({ symbols: ["005930", "005935", "000660"], groups: [] });
  await expect(panel(page).getByText("그룹 없음")).toHaveCount(0);
  await expect(panel(page).getByRole("list")).toHaveAccessibleName("기본");
});

test("그룹을 지운 종목을 되돌리면 원래 그룹의 원래 자리로 돌아간다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "반도체", symbols: ["005935", "086520", "000660"] }]);
  await open(page);
  await row(page, "086520").locator("[data-main]").press("Delete");
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", ["005935", "000660"]]]);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", ["005935", "086520", "000660"]]]);
  expect(served(scenario).symbols).toEqual(["005930", "086520", "005935", "000660"]);
});

test("새로고침 뒤 그룹 순서와 접힘을 복원한다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "반도체", symbols: ["005935"] }, { id: "B", name: "2차전지", symbols: ["000660", "086520"] }]);
  await open(page);
  await groupHead(page, "반도체").click();
  await pollSaved(() => scenario.documents.uiPrefs().collapsedWatchGroups).toEqual(["A"]);
  await page.reload();
  await expect(row(page, "086520")).toContainText("에코프로");
  await expect(groupHead(page, "반도체")).toHaveAttribute("aria-expanded", "false");
  await expect(groupHead(page, "2차전지")).toHaveAttribute("aria-expanded", "true");
  expect(await codes(page)).toEqual(["000660", "086520", "005930"]);
});

test("휴대폰 관심종목도 그룹으로 묶어 보이고 편집에서 그룹을 옮긴다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "반도체", symbols: ["005935"] }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?symbol=005930");
  await page.getByRole("navigation", { name: "휴대폰 탭" }).getByRole("button", { name: "관심종목" }).click();
  const sheet = page.getByRole("region", { name: "관심종목", exact: true });
  await expect(sheet.getByRole("button", { name: "반도체 1종목", exact: true })).toBeVisible();
  await expect(sheet.getByText("그룹 없음", { exact: true })).toBeVisible();
  for (const code of ["005935", "000660"]) await expect(sheet.locator(`li[data-code="${code}"]`).getByText(code)).toHaveCount(0);
  await sheet.getByRole("button", { name: "편집", exact: true }).click();
  await sheet.locator('li[data-code="000660"]').getByRole("button", { name: /그룹으로 옮기기$/ }).click();
  await page.getByRole("menu", { name: /그룹으로 옮기기$/ }).getByRole("menuitemradio", { name: "반도체", exact: true }).click();
  await pollSaved(() => servedGroups(scenario)).toEqual([["반도체", ["005935", "000660"]]]);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
});

const membership = (page: Page, group: string, code: string) => panel(page).getByRole("list", { name: group, exact: true }).locator(`li[data-code="${code}"]`);

async function membershipAction(page: Page, group: string, code: string, action: string) {
  await membership(page, group, code).locator("[data-main]").click({ button: "right" });
  await page.getByRole("menu", { name: /행 동작$/ }).getByRole("menuitem", { name: action, exact: true }).click();
}

test("새 그룹으로 옮기기는 선택한 소속만 빼고 다른 소속과 목록 순서는 보존한다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "첫째", symbols: ["005935", "086520"] }, { id: "B", name: "둘째", symbols: ["086520", "000660"] }]);
  await page.goto("/?symbol=005930");
  await expect(membership(page, "첫째", "086520")).toContainText("에코프로");
  await membershipAction(page, "첫째", "086520", "그룹으로 옮기기");
  await page.getByRole("menu", { name: /그룹으로 옮기기$/ }).getByRole("menuitem", { name: "새 그룹…", exact: true }).click();
  await nameGroup(page, "새 목적지");
  const groups = [["첫째", ["005935"]], ["둘째", ["086520", "000660"]], ["새 목적지", ["086520"]]];
  await pollSaved(() => servedGroups(scenario)).toEqual(groups);
  expect(served(scenario).symbols).toEqual(["005930", "086520", "005935", "000660"]);
  await expect(membership(page, "첫째", "086520")).toHaveCount(0);
  await expect(membership(page, "둘째", "086520")).toBeVisible();
  await expect(membership(page, "새 목적지", "086520")).toBeVisible();
  await page.reload();
  await expect(membership(page, "새 목적지", "086520")).toBeVisible();
  expect(servedGroups(scenario)).toEqual(groups);
  await expect(membership(page, "첫째", "086520")).toHaveCount(0);
});

test("중복 소속 행의 정렬·끌기·빼기·되돌리기·전체 제거는 해당 문맥을 지킨다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "첫째", symbols: ["005935", "086520"] }, { id: "B", name: "둘째", symbols: ["005935", "086520", "000660"] }]);
  await page.goto("/?symbol=005930");
  await expect(membership(page, "둘째", "086520")).toContainText("에코프로");
  const second = membership(page, "둘째", "086520").locator("[data-main]");
  await second.press("Alt+ArrowUp");
  await expect(second).toBeFocused();
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["005935", "086520"]], ["둘째", ["086520", "005935", "000660"]]]);
  await membership(page, "둘째", "000660").dragTo(membership(page, "둘째", "086520"));
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["005935", "086520"]], ["둘째", ["000660", "086520", "005935"]]]);
  await membership(page, "둘째", "086520").dragTo(membership(page, "첫째", "005935"));
  expect(servedGroups(scenario)).toEqual([["첫째", ["005935", "086520"]], ["둘째", ["000660", "086520", "005935"]]]);
  await second.press("Delete");
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["005935", "086520"]], ["둘째", ["000660", "005935"]]]);
  expect(served(scenario).symbols).toContain("086520");
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["005935", "086520"]], ["둘째", ["000660", "086520", "005935"]]]);
  await membershipAction(page, "둘째", "086520", "관심종목에서 빼기");
  await pollSaved(() => served(scenario).symbols).not.toContain("086520");
  expect(served(scenario).groups.every((group) => !group.symbols.includes("086520"))).toBe(true);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await pollSaved(() => served(scenario).groups[1]!.symbols).toEqual(["000660", "086520", "005935"]);
  await page.reload();
  await expect(membership(page, "첫째", "086520")).toBeVisible();
  await expect(membership(page, "둘째", "086520")).toBeVisible();
});

test("그룹 추가와 새 그룹은 원래 소속을 보존하고 공유 종목은 그룹 삭제 뒤에도 남는다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "첫째", symbols: ["086520", "005935"] }, { id: "B", name: "둘째", symbols: [] }]);
  await open(page);
  await membershipAction(page, "첫째", "086520", "그룹에 추가");
  const menu = page.getByRole("menu", { name: /그룹에 추가$/ });
  await expect(menu.getByRole("menuitem", { name: "첫째 이미 있음", exact: true })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "둘째", exact: true }).click();
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["086520", "005935"]], ["둘째", ["086520"]]]);
  await membershipAction(page, "둘째", "086520", "그룹에 추가");
  await page.getByRole("menu", { name: /그룹에 추가$/ }).getByRole("menuitem", { name: "새 그룹…", exact: true }).click();
  await nameGroup(page, "셋째");
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["086520", "005935"]], ["둘째", ["086520"]], ["셋째", ["086520"]]]);
  await groupMenu(page, "첫째").click();
  await page.getByRole("menuitem", { name: "그룹 지우기", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("그 안의 1종목");
  await page.getByRole("dialog").getByRole("button", { name: "그룹 지우기", exact: true }).click();
  await pollSaved(() => served(scenario).symbols).toEqual(["005930", "086520", "000660"]);
  await expect(membership(page, "둘째", "086520")).toBeVisible();
  await expect(membership(page, "셋째", "086520")).toBeVisible();
});

test("다른 목록으로 공유 행을 옮기고 목록을 복제해도 다른 소속과 순서는 남는다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "첫째", symbols: ["005935", "086520"] }, { id: "B", name: "둘째", symbols: ["086520", "005935", "000660"] }]);
  await page.goto("/?symbol=005930");
  await expect(membership(page, "둘째", "086520")).toContainText("에코프로");
  await membershipAction(page, "둘째", "086520", "다른 목록에 복사");
  await page.getByRole("menu", { name: /다른 목록으로$/ }).getByRole("menuitem", { name: "다른 목록", exact: true }).last().click();
  await pollSaved(() => scenario.documents.watchlists().lists[1]!.symbols).toEqual(["086520"]);
  expect(servedGroups(scenario)).toEqual([["첫째", ["005935", "086520"]], ["둘째", ["086520", "005935", "000660"]]]);
  await membershipAction(page, "둘째", "086520", "다른 목록에 복사");
  await page.getByRole("menu", { name: /다른 목록으로$/ }).getByRole("menuitem", { name: "다른 목록", exact: true }).first().click();
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["005935", "086520"]], ["둘째", ["005935", "000660"]]]);
  expect(served(scenario).symbols).toContain("086520");
  expect(scenario.documents.watchlists().lists[1]!.symbols).toEqual(["086520"]);
  await panel(page).getByRole("button", { name: "관심종목 목록: 기본", exact: true }).click();
  await page.getByRole("menuitem", { name: "복제", exact: true }).click();
  await pollSaved(() => scenario.documents.watchlists().lists.length).toBe(3);
  const [original, , copy] = scenario.documents.watchlists().lists;
  expect(copy!.groups.map((g) => [g.name, g.symbols])).toEqual(original!.groups.map((g) => [g.name, g.symbols]));
  expect(copy!.groups.every((g) => original!.groups.every((old) => old.id !== g.id))).toBe(true);
  await page.reload();
  await expect(panel(page).getByRole("button", { name: "관심종목 목록: 기본 복사", exact: true })).toBeVisible();
  await expect(membership(page, "첫째", "086520")).toBeVisible();
});

test("휴대폰의 중복 소속 삭제 버튼은 선택한 그룹만 빼고 마지막 소속 뒤 그룹 없음에 남긴다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "첫째", symbols: ["086520"] }, { id: "B", name: "둘째", symbols: ["086520"] }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?symbol=005930");
  await page.getByRole("navigation", { name: "휴대폰 탭" }).getByRole("button", { name: "관심종목" }).click();
  const sheet = page.getByRole("region", { name: "관심종목", exact: true });
  await sheet.getByRole("button", { name: "편집", exact: true }).click();
  await sheet.getByRole("list", { name: "둘째", exact: true }).getByRole("button", { name: "에코프로 지우기", exact: true }).click();
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["086520"]], ["둘째", []]]);
  await sheet.getByRole("list", { name: "첫째", exact: true }).getByRole("button", { name: "에코프로 지우기", exact: true }).click();
  await expect(sheet.getByRole("list", { name: "그룹 없음", exact: true }).locator('li[data-code="086520"]')).toBeVisible();
  expect(served(scenario).symbols).toContain("086520");
});

test("그룹 머리 이름은 굵기 600이고 그룹 안 종목 이름은 그룹 이름에 맞춰 들여쓴다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "g1", name: "반도체", symbols: ["005930", "000660"] }]);
  await open(page);
  const groupName = groupHead(page, "반도체").locator("span.truncate");
  const stockName = row(page, "005930").locator("b");
  expect(await groupName.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("600");
  const left = async (locator: typeof groupName) => (await locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().left;
  }));
  expect(Math.abs(await left(stockName) - await left(groupName))).toBeLessThanOrEqual(2);
});

const ungroupedHead = (page: Page) => panel(page).getByText("그룹 없음", { exact: true });
const ungroupedRow = (page: Page, code: string) => panel(page).getByRole("list", { name: "그룹 없음", exact: true }).locator(`li[data-code="${code}"]`);
const headBox = (page: Page, name: string) => groupHead(page, name).locator("xpath=..");

test("다른 그룹의 줄 위에 놓으면 그 줄 앞으로 옮기고 새로고침 뒤에도 남는다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "첫째", symbols: ["005935", "086520"] }, { id: "B", name: "둘째", symbols: ["000660"] }]);
  await open(page);
  await membership(page, "첫째", "086520").dragTo(membership(page, "둘째", "000660"));
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["005935"]], ["둘째", ["086520", "000660"]]]);
  await expect(membership(page, "둘째", "086520").locator("[data-main]")).toBeFocused();
  await page.reload();
  await expect(membership(page, "둘째", "086520")).toBeVisible();
  expect(servedGroups(scenario)).toEqual([["첫째", ["005935"]], ["둘째", ["086520", "000660"]]]);
});

test("접힌 그룹 머리에 놓으면 맨 끝으로 옮기고 그룹을 편다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "첫째", symbols: ["005935", "086520"] }, { id: "B", name: "둘째", symbols: ["000660"] }]);
  await open(page);
  await groupHead(page, "둘째").click();
  await expect(groupHead(page, "둘째")).toHaveAttribute("aria-expanded", "false");
  await membership(page, "첫째", "005935").dragTo(groupHead(page, "둘째"));
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["086520"]], ["둘째", ["000660", "005935"]]]);
  await expect(groupHead(page, "둘째")).toHaveAttribute("aria-expanded", "true");
  await expect(membership(page, "둘째", "005935").locator("[data-main]")).toBeFocused();
  await pollSaved(() => scenario.documents.uiPrefs().collapsedWatchGroups).toEqual([]);
});

test("Ctrl을 누른 채 놓으면 복사하고 원래 그룹에도 남는다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "첫째", symbols: ["005935", "086520"] }, { id: "B", name: "둘째", symbols: ["000660"] }]);
  await open(page);
  await page.keyboard.down("Control");
  await membership(page, "첫째", "086520").dragTo(membership(page, "둘째", "000660"));
  await page.keyboard.up("Control");
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["005935", "086520"]], ["둘째", ["086520", "000660"]]]);
  await expect(membership(page, "첫째", "086520")).toBeVisible();
});

test("이미 같은 종목이 있는 그룹에는 놓을 수 없고 머리에 이유가 보인다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "첫째", symbols: ["005935", "086520"] }, { id: "B", name: "둘째", symbols: ["086520", "000660"] }]);
  await page.goto("/?symbol=005930");
  await expect(membership(page, "둘째", "086520")).toContainText("에코프로");
  const source = membership(page, "첫째", "086520");
  const box = (await source.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  const head = (await headBox(page, "둘째").boundingBox())!;
  await page.mouse.move(head.x + 40, head.y + head.height / 2, { steps: 8 });
  await expect(headBox(page, "둘째")).toContainText("이미 있음");
  await page.mouse.up();
  await expect(headBox(page, "둘째")).not.toContainText("이미 있음");
  expect(servedGroups(scenario)).toEqual([["첫째", ["005935", "086520"]], ["둘째", ["086520", "000660"]]]);
  expect(await codes(page)).toEqual(["005935", "086520", "086520", "000660", "005930"]);
});

test("그룹 없음에 놓으면 원래 그룹에서 빼고 다른 그룹에도 있으면 그대로 둔다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "첫째", symbols: ["005935", "086520"] }, { id: "B", name: "둘째", symbols: ["086520"] }]);
  await page.goto("/?symbol=005930");
  await expect(membership(page, "둘째", "086520")).toContainText("에코프로");
  await membership(page, "첫째", "086520").dragTo(ungroupedHead(page));
  expect(servedGroups(scenario)).toEqual([["첫째", ["005935", "086520"]], ["둘째", ["086520"]]]);
  await membership(page, "첫째", "005935").dragTo(ungroupedRow(page, "005930"));
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["086520"]], ["둘째", ["086520"]]]);
  await expect(ungroupedRow(page, "005935").locator("[data-main]")).toBeFocused();
  expect(served(scenario).symbols).toEqual(["005930", "086520", "005935", "000660"]);
  await page.reload();
  await expect(ungroupedRow(page, "005935")).toBeVisible();
  expect(servedGroups(scenario)).toEqual([["첫째", ["086520"]], ["둘째", ["086520"]]]);
});

const head = (page: Page) => panel(page).locator("div.border-b").first();
const slot = (page: Page) => panel(page).getByRole("button", { name: "새 그룹", exact: true });
const listMenu = (page: Page) => panel(page).getByRole("button", { name: /^관심종목 목록: / });

test("머리에는 종목 넣기만 있고 새 그룹은 목록 메뉴와 목록 맨 아래 칸에서 만든다", async ({ scenario, page }) => {
  await seed(scenario);
  await open(page);
  await expect(head(page).getByRole("button", { name: "관심종목에 넣기" })).toHaveCount(1);
  await expect(head(page).getByRole("button", { name: "새 그룹" })).toHaveCount(0);
  await expect(slot(page)).toHaveCount(1);

  await listMenu(page).click();
  await page.getByRole("menuitem", { name: "새 그룹", exact: true }).click();
  await expect(panel(page).getByRole("textbox", { name: "그룹 이름" })).toHaveValue("그룹 1");
  await nameGroup(page, "첫째");
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", []]]);

  await slot(page).click();
  await expect(panel(page).getByRole("textbox", { name: "그룹 이름" })).toHaveValue("그룹 1");
  await nameGroup(page, "둘째");
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", []], ["둘째", []]]);
});

test("그룹 안 줄을 새 그룹 칸에 끌어 놓으면 새 그룹으로 옮기고 Ctrl이면 복사하며 그룹 없음의 줄도 옮긴다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "첫째", symbols: ["005935", "086520"] }]);
  await open(page);
  await membership(page, "첫째", "086520").dragTo(slot(page));
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["005935"]], ["그룹 1", ["086520"]]]);
  await nameGroup(page, "옮김");
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["005935"]], ["옮김", ["086520"]]]);

  await page.keyboard.down("Control");
  await membership(page, "첫째", "005935").dragTo(slot(page));
  await page.keyboard.up("Control");
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["005935"]], ["옮김", ["086520"]], ["그룹 1", ["005935"]]]);
  await nameGroup(page, "복사");

  await page.keyboard.down("Control");
  await ungroupedRow(page, "000660").dragTo(slot(page));
  await page.keyboard.up("Control");
  await pollSaved(() => servedGroups(scenario)).toEqual([["첫째", ["005935"]], ["옮김", ["086520"]], ["복사", ["005935"]], ["그룹 1", ["000660"]]]);
  await expect(ungroupedRow(page, "000660")).toHaveCount(0);
});

test("그룹이 100개면 새 그룹 칸은 비활성이고 이유를 보인다", async ({ scenario, page }) => {
  const full = Array.from({ length: 100 }, (_, i): WatchGroup => ({ id: `G${i}`, name: `그룹 ${i + 1}`, symbols: i === 0 ? ["005935"] : [] }));
  await seed(scenario, full);
  await open(page);
  await expect(slot(page)).toBeDisabled();
  await expect(slot(page)).toHaveAttribute("title", "그룹은 100개까지입니다");
  await expect(slot(page)).toContainText("그룹은 100개까지입니다");
});

test("종목이 없는 목록에는 새 그룹 칸이 없다", async ({ scenario, page }) => {
  scenario.documents.saveWatchlists({ revision: 100, lists: [{ id: "L", name: "기본", symbols: [], groups: [] }] });
  await page.goto("/?symbol=005930");
  await expect(panel(page).getByText("기본에 종목이 없습니다")).toBeVisible();
  await expect(slot(page)).toHaveCount(0);
});

test("관심종목 머리는 데스크톱과 휴대폰 폭에서 넘치지 않는다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "첫째", symbols: ["005935"] }]);
  await open(page);
  expect(await head(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("navigation", { name: "휴대폰 탭" }).getByRole("button", { name: "관심종목" }).click();
  const sheet = page.getByRole("region", { name: "관심종목", exact: true });
  await expect(sheet.getByRole("button", { name: "관심종목에 넣기" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "새 그룹", exact: true })).toHaveText(/새 그룹/);
  expect(await sheet.locator("div.border-b").first().evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});

test("그룹이 가득 차면 새 그룹 칸 위에서 앞서 가리키던 놓을 곳의 강조가 사라진다", async ({ scenario, page }) => {
  const full = Array.from({ length: 100 }, (_, i): WatchGroup => ({ id: `G${i}`, name: `그룹 ${i + 1}`, symbols: i === 99 ? ["005935", "086520"] : [] }));
  await seed(scenario, full);
  await open(page);
  const bar = ungroupedHead(page).locator("xpath=..");
  const fill = () => bar.evaluate((el) => getComputedStyle(el).backgroundColor);
  const idle = await fill();
  await slot(page).scrollIntoViewIfNeeded();
  const source = (await membership(page, "그룹 100", "005935").boundingBox())!;
  await page.mouse.move(source.x + 20, source.y + source.height / 2);
  await page.mouse.down();
  const over = (await ungroupedRow(page, "000660").boundingBox())!;
  await page.mouse.move(over.x + 20, over.y + over.height / 2, { steps: 8 });
  await expect.poll(fill).not.toBe(idle);
  const target = (await slot(page).boundingBox())!;
  await page.mouse.move(target.x + 20, target.y + target.height / 2, { steps: 8 });
  await expect.poll(fill).toBe(idle);
  await page.mouse.up();
  await expect(ungroupedRow(page, "000660")).toBeVisible();
});

test("그룹 머리 이름은 바탕 없이 11px --text-2로 보이고 종목 이름은 더 밝은 --text-name이다", async ({ scenario, page }) => {
  await seed(scenario, [{ id: "A", name: "첫째", symbols: ["005935", "086520"] }]);
  await open(page);
  const colors = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const probe = (token: string) => { const el = document.createElement("i"); el.style.color = `var(${token})`; document.body.append(el); const c = getComputedStyle(el).color; el.remove(); return c; };
    return { text2: probe("--text-2"), name: probe("--text-name"), raw: root.getPropertyValue("--text-name").trim() };
  });
  expect(colors.raw.toLowerCase()).toBe("#d3dacc");
  const head = headBox(page, "첫째");
  const label = groupHead(page, "첫째").locator("span.truncate");
  await expect(label).toHaveCSS("color", colors.text2);
  await expect(label).toHaveCSS("font-size", "11px");
  await expect(head).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const name = row(page, "086520").locator("b");
  await expect(name).toHaveCSS("color", colors.name);
  expect(colors.name).not.toBe(colors.text2);
});
