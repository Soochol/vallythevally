import type { Page } from "@playwright/test";
import type { HeatmapTheme } from "../src/api/generated/HeatmapTheme";
import type { WatchGroup } from "../src/api/generated/WatchGroup";
import { HEATMAP_TABLE, seedHeatmapThemes, type HeatmapTable } from "./fixtures/heatmap-data";
import { expect, pollSaved, test, type Scenario } from "./harness";

test.use({ clockStart: "20261109100000" });

const THEMES_PATH = "/api/heatmap/themes";
const main = (page: Page) => page.getByRole("main", { name: "히트맵", exact: true });
const listGroup = (page: Page, name: string) => main(page).getByRole("region", { name: `${name} 목록` });
const boardGroup = (page: Page, name: string) => main(page).getByRole("region", { name: `${name} 지도` });
const tile = (page: Page, code: string) => main(page).locator(`.hm-tile[data-code="${code}"]`);
const addPop = (page: Page) => page.getByRole("dialog", { name: "테마 추가" });
const newName = (page: Page) => addPop(page).getByRole("textbox", { name: "새 테마 이름" });
const searchField = (page: Page, name: string) => listGroup(page, name).getByRole("searchbox", { name: `${name} 종목 검색` });
const result = (page: Page, name: string, code: string) => listGroup(page, name).getByRole("list", { name: `${name} 종목 검색 결과` }).locator(`button[data-code="${code}"]`);
const table = (): HeatmapTable => structuredClone(HEATMAP_TABLE);
const stored = (scenario: Scenario) => scenario.documents.heatmapThemes();
const storedShape = (scenario: Scenario) => stored(scenario).themes.map((theme) => [theme.name, theme.symbols]);
const themeRequests = (scenario: Scenario) => scenario.requests.filter((request) => new URL(request.url()).pathname === THEMES_PATH).map((request) => request.method());
const toast = (page: Page) => page.locator(".ui-toast").last();
const groupNames = (page: Page) => main(page).locator(".hm-list-group .hm-list-title h2").allTextContents();
const rowCodes = (page: Page, themeName: string) => listGroup(page, themeName).locator(".hm-list-row").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.code));

function seedList(scenario: Scenario, groups: WatchGroup[]) {
  scenario.documents.saveWatchlists({ revision: 100, lists: [{ id: "L", name: "히트맵", symbols: groups.flatMap((g) => g.symbols), groups }, { id: "empty", name: "그룹 없음", symbols: [] }] });
}

const codes = (count: number, from = 100000) => Array.from({ length: count }, (_, i) => String(from + i));
const sixty = (): HeatmapTheme => ({ id: "full", name: "가득", symbols: codes(60) });

async function openAddPopover(page: Page) {
  await main(page).getByRole("button", { name: "테마 추가", exact: true }).click();
  await expect(addPop(page)).toBeVisible();
}

test("테마 추가 팝오버에서 새 테마를 만들고 인라인 검색으로 종목을 넣으면 즉시 저장되고 새로 고침해도 남는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap");
  await expect(listGroup(page, "반도체")).toBeVisible();
  await openAddPopover(page);
  await newName(page).fill("로봇");
  await newName(page).press("Enter");

  await expect(listGroup(page, "로봇")).toBeVisible();
  await expect(searchField(page, "로봇")).toBeFocused();
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["005930", "000660"]], ["지주", ["028260", "086520"]], ["로봇", []]]);

  await searchField(page, "로봇").fill("에코프로");
  await result(page, "로봇", "086520").click();
  await expect(listGroup(page, "로봇").locator(".hm-list-row")).toHaveCount(1);
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["005930", "000660"]], ["지주", ["028260", "086520"]], ["로봇", ["086520"]]]);
  expect(stored(scenario).revision).toBeGreaterThan(100);

  await page.reload();
  await expect(listGroup(page, "로봇").locator(".hm-list-row")).toHaveCount(1);
});

test("테마 이름을 인라인으로 바꾸면 즉시 저장되고 Esc는 취소한다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap");
  await listGroup(page, "반도체").locator(".hm-list-head").hover();
  await listGroup(page, "반도체").getByRole("button", { name: "반도체 이름 바꾸기" }).click();
  const field = listGroup(page, "반도체").getByRole("textbox", { name: "반도체 새 이름" });
  await expect(field).toBeFocused();
  await field.fill("취소할 이름");
  await page.keyboard.press("Escape");
  await expect(listGroup(page, "반도체")).toBeVisible();
  expect(storedShape(scenario)[0]![0]).toBe("반도체");

  await listGroup(page, "반도체").locator(".hm-list-title").dblclick();
  const again = listGroup(page, "반도체").getByRole("textbox", { name: "반도체 새 이름" });
  await again.fill("반도체 소부장");
  await again.press("Enter");
  await expect(listGroup(page, "반도체 소부장")).toBeVisible();
  await pollSaved(() => storedShape(scenario)[0]).toEqual(["반도체 소부장", ["005930", "000660"]]);
});

test("종목이 있는 테마를 지우려면 인라인 확인이 필요하고 지운 뒤 Ctrl+Z로 되돌릴 수 있다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap");
  await listGroup(page, "지주").locator(".hm-list-head").hover();
  await listGroup(page, "지주").getByRole("button", { name: "지주 지우기", exact: true }).click();
  await expect(listGroup(page, "지주")).toBeVisible();
  await listGroup(page, "지주").getByRole("button", { name: "지주 지우기 취소" }).click();
  await expect(listGroup(page, "지주")).toBeVisible();

  await listGroup(page, "지주").locator(".hm-list-head").hover();
  await listGroup(page, "지주").getByRole("button", { name: "지주 지우기", exact: true }).click();
  await listGroup(page, "지주").getByRole("button", { name: "지주 지우기 확인" }).click();
  await expect(listGroup(page, "지주")).toHaveCount(0);
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["005930", "000660"]]]);

  await page.keyboard.press("Control+z");
  await expect(listGroup(page, "지주")).toBeVisible();
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["005930", "000660"]], ["지주", ["028260", "086520"]]]);
});

test("그룹 헤더를 끌어 놓으면 내 순서로 자동 전환되며 위치가 저장된다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap");
  await expect.poll(() => groupNames(page)).toEqual(["지주", "반도체"]);
  await listGroup(page, "반도체").locator(".hm-list-head").dragTo(listGroup(page, "지주"), { targetPosition: { x: 10, y: 12 } });
  await expect(page).toHaveURL(/[?&]order=custom(&|$)/);
  await expect.poll(() => groupNames(page)).toEqual(["반도체", "지주"]);
  await pollSaved(() => storedShape(scenario).map(([name]) => name)).toEqual(["반도체", "지주"]);
});

test("종목을 같은 그룹 안에서 끌어 순서를 바꾸면 내 순서로 자동 전환되고 호버 빼기 뒤 되돌리기로 복원된다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table(), { revision: 100, themes: [{ id: "chips", name: "반도체", symbols: ["005930", "000660", "028260"] }] });
  await page.goto("/heatmap");
  const rowOf = (code: string) => listGroup(page, "반도체").locator(`.hm-list-row[data-code="${code}"]`);
  await expect.poll(() => rowCodes(page, "반도체")).toEqual(["028260", "005930", "000660"]);

  await rowOf("000660").dragTo(rowOf("028260"), { targetPosition: { x: 40, y: 2 } });
  await expect(page).toHaveURL(/[?&]sort=custom(&|$)/);
  await expect.poll(() => rowCodes(page, "반도체")).toEqual(["000660", "028260", "005930"]);
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["000660", "028260", "005930"]]]);

  await rowOf("028260").hover();
  await rowOf("028260").getByRole("button", { name: "삼성물산 빼기" }).click();
  await expect.poll(() => rowCodes(page, "반도체")).toEqual(["000660", "005930"]);
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["000660", "005930"]]]);

  await toast(page).getByRole("button", { name: /되돌리기/ }).click();
  await expect.poll(() => rowCodes(page, "반도체")).toEqual(["000660", "028260", "005930"]);
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["000660", "028260", "005930"]]]);
});

test("종목을 다른 그룹으로 끌면 이동하고 Shift+드래그하면 복제된다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap?order=custom&sort=custom");
  const rowIn = (themeName: string, code: string) => listGroup(page, themeName).locator(`.hm-list-row[data-code="${code}"]`);

  await rowIn("반도체", "000660").dragTo(rowIn("지주", "086520"), { targetPosition: { x: 40, y: 20 } });
  await expect.poll(() => rowCodes(page, "반도체")).toEqual(["005930"]);
  await expect.poll(() => rowCodes(page, "지주")).toEqual(["028260", "086520", "000660"]);
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["005930"]], ["지주", ["028260", "086520", "000660"]]]);

  await page.keyboard.down("Shift");
  await rowIn("반도체", "005930").dragTo(rowIn("지주", "000660"), { targetPosition: { x: 40, y: 20 } });
  await page.keyboard.up("Shift");
  await expect.poll(() => rowCodes(page, "반도체")).toEqual(["005930"]);
  await expect.poll(() => rowCodes(page, "지주")).toEqual(["028260", "086520", "000660", "005930"]);
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["005930"]], ["지주", ["028260", "086520", "000660", "005930"]]]);
});

test("테마 이름 유효성 검증(빈 값·중복·40자)과 지수 제외·중복·60개 상한을 지킨다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table(), { revision: 100, themes: [{ id: "chips", name: "반도체", symbols: ["005930"] }, sixty()] });
  await page.goto("/heatmap");

  await openAddPopover(page);
  await newName(page).fill("   ");
  await newName(page).press("Enter");
  await expect(addPop(page).getByRole("alert")).toHaveText("테마 이름을 적어 주세요");

  await newName(page).fill("반도체");
  await newName(page).press("Enter");
  await expect(addPop(page).getByRole("alert")).toHaveText("같은 이름의 테마가 이미 있습니다: 반도체");

  await newName(page).fill("가".repeat(41));
  await newName(page).press("Enter");
  await expect(addPop(page).getByRole("alert")).toHaveText("테마 이름은 40자까지입니다");

  await newName(page).fill("가".repeat(40));
  await newName(page).press("Enter");
  await expect(listGroup(page, "가".repeat(40))).toBeVisible();

  await listGroup(page, "반도체").locator(".hm-list-head").hover();
  await listGroup(page, "반도체").getByRole("button", { name: "반도체 종목 추가" }).click();
  await searchField(page, "반도체").fill("코스피");
  await expect(listGroup(page, "반도체").getByText("찾은 종목이 없습니다")).toBeVisible();
  await searchField(page, "반도체").fill("삼성전자");
  await expect(result(page, "반도체", "005930")).toBeDisabled();
  await expect(result(page, "반도체", "005930")).toContainText("이미 있음");
  await expect(result(page, "반도체", "005935")).toBeEnabled();

  await listGroup(page, "가득").locator(".hm-list-head").hover();
  await listGroup(page, "가득").getByRole("button", { name: "가득 종목 추가" }).click();
  await searchField(page, "가득").fill("에코프로");
  await expect(result(page, "가득", "086520")).toBeDisabled();
  await expect(result(page, "가득", "086520")).toContainText("가득 참");
});

test("테마 추가 팝오버에서 관심종목 그룹을 가져오면 중복은 건너뛰고 관심종목은 바뀌지 않는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  seedList(scenario, [
    { id: "g1", name: "반도체", symbols: ["005930"] },
    { id: "g2", name: "신규 테마", symbols: ["086520", "005930"] },
    { id: "g3", name: "둘째 신규", symbols: ["028260"] },
  ]);
  const before = scenario.documents.watchlists();
  await page.goto("/heatmap?order=custom");
  await openAddPopover(page);
  await addPop(page).getByRole("button", { name: /히트맵/ }).click();
  const notices = addPop(page).getByRole("status", { name: "가져오기 결과" });
  await expect(notices).toContainText("‘히트맵’ 목록에서 테마 2개를 가져왔습니다.");
  await expect(notices).toContainText("이름이 같은 테마가 이미 있어 건너뜀: 반도체");
  await pollSaved(() => storedShape(scenario)).toEqual([
    ["반도체", ["005930", "000660"]],
    ["지주", ["028260", "086520"]],
    ["신규 테마", ["086520", "005930"]],
    ["둘째 신규", ["028260"]],
  ]);
  expect(scenario.documents.watchlists()).toEqual(before);
  expect(scenario.requests.filter((request) => new URL(request.url()).pathname === "/api/watchlists" && request.method() === "PUT")).toHaveLength(0);
});

test("테마가 없을 때 빈 화면에서 바로 관심종목 가져오기와 직접 만들기가 동작한다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table(), { revision: 100, themes: [] });
  seedList(scenario, [
    { id: "g1", name: "많음", symbols: codes(65) },
    { id: "g2", name: "섞임", symbols: ["IDX:001", "005930", "IDX:101"] },
  ]);
  await page.goto("/heatmap");
  await expect(main(page).getByText("테마가 없습니다")).toBeVisible();
  await main(page).getByRole("button", { name: "테마 직접 만들기" }).click();
  await expect(main(page).getByRole("textbox", { name: "새 테마 이름" })).toBeFocused();
  await main(page).getByRole("button", { name: "관심종목 그룹에서 가져오기" }).click();
  await main(page).getByRole("button", { name: "히트맵 · 그룹 2개" }).click();
  await expect(listGroup(page, "많음")).toBeVisible();
  await pollSaved(() => stored(scenario).themes.map((theme) => [theme.name, theme.symbols.length])).toEqual([["많음", 60], ["섞임", 1]]);
  expect(stored(scenario).themes[0]!.symbols).toEqual(codes(60));
  expect(stored(scenario).themes[1]!.symbols).toEqual(["005930"]);
});

test("서버가 자동 저장을 거절하면 오류 알림을 보이고 낙관적 변경을 되돌린다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  scenario.on((url, request) => url.pathname === THEMES_PATH && request.method() === "PUT", () => ({ status: 400, body: { error: { code: "bad_request", message: "종목 코드가 올바르지 않습니다", reason: null, retryAt: null, manualActionRequired: false } } }));
  await page.goto("/heatmap");
  await openAddPopover(page);
  await newName(page).fill("거절될 테마");
  await newName(page).press("Enter");
  await expect(toast(page)).toContainText("테마를 저장하지 못했습니다: 종목 코드가 올바르지 않습니다");
  await expect(listGroup(page, "거절될 테마")).toHaveCount(0);
  expect(storedShape(scenario).map(([name]) => name)).toEqual(["반도체", "지주"]);
});

test("히트맵 탭 칸 우클릭 메뉴에서 다른 테마 추가·빼기·되돌리기·키보드 열기가 동작한다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap?view=board");
  await expect(tile(page, "028260")).toBeVisible();
  await tile(page, "028260").click({ button: "right" });
  const actions = page.getByRole("menu", { name: "삼성물산 칸 동작" });
  await actions.getByRole("menuitem", { name: "다른 테마에 추가" }).click();
  const themes = page.getByRole("menu", { name: "삼성물산 다른 테마에 추가" });
  await expect(themes.getByRole("menuitem", { name: "지주" })).toHaveCount(0);
  await themes.getByRole("menuitem", { name: "반도체" }).click();
  await expect(toast(page)).toHaveText("‘반도체’ 테마에 추가했습니다: 삼성물산");
  await expect(boardGroup(page, "반도체").locator(".hm-tile")).toHaveCount(3);
  expect(storedShape(scenario)).toEqual([["반도체", ["005930", "000660", "028260"]], ["지주", ["028260", "086520"]]]);
  expect(themeRequests(scenario)).toEqual(["GET", "PUT"]);

  await tile(page, "000660").click({ button: "right" });
  await page.getByRole("menu", { name: "SK하이닉스 칸 동작" }).getByRole("menuitem", { name: "이 테마에서 빼기" }).click();
  await expect(tile(page, "000660")).toHaveCount(0);
  await toast(page).getByRole("button", { name: /되돌리기/ }).click();
  await expect(tile(page, "000660")).toBeVisible();
  expect(storedShape(scenario)).toEqual([["반도체", ["005930", "000660", "028260"]], ["지주", ["028260", "086520"]]]);

  await tile(page, "086520").focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "에코프로 칸 동작" });
  await expect(menu.getByRole("menuitem", { name: "이 테마에서 빼기" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(tile(page, "086520")).toBeFocused();
});

test("다른 곳에서 테마를 먼저 더했어도 인라인 저장은 최신 문서를 받아 덮어쓰지 않는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap");
  await expect(listGroup(page, "반도체")).toBeVisible();
  const latest = stored(scenario);
  scenario.documents.saveHeatmapThemes({ revision: latest.revision + 50, themes: [...latest.themes, { id: "added-elsewhere", name: "다른 곳에서 더함", symbols: ["000660"] }] });
  await listGroup(page, "반도체").locator(".hm-list-row[data-code='005930']").click({ button: "right" });
  await page.getByRole("menu", { name: "삼성전자 칸 동작" }).getByRole("menuitem", { name: "다른 테마에 추가" }).click();
  await page.getByRole("menu", { name: "삼성전자 다른 테마에 추가" }).getByRole("menuitem", { name: "지주" }).click();
  await pollSaved(() => storedShape(scenario)).toEqual([
    ["반도체", ["005930", "000660"]],
    ["지주", ["028260", "086520", "005930"]],
    ["다른 곳에서 더함", ["000660"]],
  ]);
});
