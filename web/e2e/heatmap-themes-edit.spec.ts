import type { Page } from "@playwright/test";
import type { HeatmapTheme } from "../src/api/generated/HeatmapTheme";
import type { WatchGroup } from "../src/api/generated/WatchGroup";
import { HEATMAP_TABLE, seedHeatmapThemes, type HeatmapTable } from "./fixtures/heatmap-data";
import { expect, pollSaved, test, type Scenario } from "./harness";

test.use({ clockStart: "20261109100000" });

const THEMES_PATH = "/api/heatmap/themes";
const main = (page: Page) => page.getByRole("main", { name: "히트맵", exact: true });
const group = (page: Page, name: string) => main(page).getByRole("region", { name: `${name} 지도` });
const tile = (page: Page, code: string) => main(page).locator(`.hm-tile[data-code="${code}"]`);
const drawer = (page: Page) => page.getByRole("dialog", { name: "테마 편집" });
const themeRows = (page: Page) => drawer(page).getByRole("list", { name: "테마" });
const themeRow = (page: Page, name: string) => themeRows(page).getByRole("listitem").filter({ has: page.getByRole("button", { name: `${name} 테마 고르기`, exact: true }) });
const memberRows = (page: Page) => drawer(page).getByRole("list", { name: "담은 종목" });
const save = (page: Page) => drawer(page).getByRole("button", { name: "저장", exact: true });
const footer = (page: Page) => drawer(page).locator(".hm-edit-msg");
const newName = (page: Page) => drawer(page).getByRole("textbox", { name: "새 테마 이름" });
const searchField = (page: Page) => drawer(page).getByRole("searchbox", { name: "종목 검색" });
const result = (page: Page, code: string) => drawer(page).getByRole("list", { name: "종목 검색 결과" }).locator(`button[data-code="${code}"]`);
const table = (): HeatmapTable => structuredClone(HEATMAP_TABLE);
const stored = (scenario: Scenario) => scenario.documents.heatmapThemes();
const storedShape = (scenario: Scenario) => stored(scenario).themes.map((theme) => [theme.name, theme.symbols]);
const themeRequests = (scenario: Scenario) => scenario.requests.filter((request) => new URL(request.url()).pathname === THEMES_PATH).map((request) => request.method());
const toast = (page: Page) => page.locator(".ui-toast");

const THEME_LIST_NAMES = (page: Page) => themeRows(page).locator(".hm-edit-main b").allTextContents();

async function openEditor(page: Page) {
  await page.goto("/heatmap");
  await expect(tile(page, "005930")).toBeVisible();
  await main(page).getByRole("button", { name: "테마 편집", exact: true }).click();
  await expect(themeRows(page)).toBeVisible();
}

async function addTheme(page: Page, name: string) {
  await newName(page).fill(name);
  await newName(page).press("Enter");
}

function seedList(scenario: Scenario, groups: WatchGroup[]) {
  scenario.documents.saveWatchlists({ revision: 100, lists: [{ id: "L", name: "히트맵", symbols: groups.flatMap((g) => g.symbols), groups }, { id: "empty", name: "그룹 없음", symbols: [] }] });
}

const codes = (count: number, from = 100000) => Array.from({ length: count }, (_, i) => String(from + i));
const sixty = (): HeatmapTheme => ({ id: "full", name: "가득", symbols: codes(60) });

test("테마 편집 단추가 서랍을 열고 Esc로 닫으며 바꾼 것이 없으면 저장을 끈다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await openEditor(page);
  await expect(footer(page)).toHaveText("바꾼 내용이 없습니다");
  await expect(save(page)).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
  expect(themeRequests(scenario)).toEqual(["GET"]);
});

test("테마를 만들고 종목을 넣어 저장하면 보드에 나타나고 새로 고침해도 남는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await openEditor(page);
  await addTheme(page, "로봇");
  await expect(searchField(page)).toBeVisible();
  await expect(save(page)).toBeEnabled();
  await searchField(page).fill("에코프로");
  await result(page, "086520").click();
  await expect(memberRows(page).getByRole("listitem")).toHaveCount(1);
  await expect(footer(page)).toHaveText("저장하지 않은 변경이 있습니다");
  expect(storedShape(scenario)).toEqual([["반도체", ["005930", "000660"]], ["지주", ["028260", "086520"]]]);
  await save(page).click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(group(page, "로봇").locator(".hm-tile")).toHaveCount(1);
  await expect(toast(page)).toHaveText("테마를 저장했습니다");
  expect(storedShape(scenario)).toEqual([["반도체", ["005930", "000660"]], ["지주", ["028260", "086520"]], ["로봇", ["086520"]]]);
  expect(stored(scenario).revision).toBeGreaterThan(100);
  await page.reload();
  await expect(group(page, "로봇").locator(".hm-tile")).toHaveCount(1);
  await expect(tile(page, "086520")).toHaveCount(2);
});

test("취소하면 고친 내용을 버리고 저장하지 않는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await openEditor(page);
  await addTheme(page, "버릴 테마");
  await expect(themeRow(page, "버릴 테마")).toBeVisible();
  await drawer(page).getByRole("button", { name: "취소", exact: true }).click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(main(page).getByRole("region", { name: "버릴 테마 지도" })).toHaveCount(0);
  expect(themeRequests(scenario)).toEqual(["GET"]);
  await main(page).getByRole("button", { name: "테마 편집", exact: true }).click();
  await expect(themeRow(page, "버릴 테마")).toHaveCount(0);
});

test("바깥을 눌러도 고친 내용이 있으면 서랍이 닫히지 않는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await openEditor(page);
  await addTheme(page, "남길 테마");
  await page.mouse.click(5, 300);
  await expect(drawer(page)).toBeVisible();
  await expect(themeRow(page, "남길 테마")).toBeVisible();
});

test("테마 이름을 바꾸면 저장 뒤에 보드 머리가 바뀐다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await openEditor(page);
  await drawer(page).getByRole("button", { name: "반도체 이름 바꾸기" }).click();
  const field = drawer(page).getByRole("textbox", { name: "반도체 새 이름" });
  await expect(field).toBeFocused();
  await field.fill("반도체 소부장");
  await field.press("Enter");
  await expect(themeRow(page, "반도체 소부장")).toBeVisible();
  await save(page).click();
  await expect(group(page, "반도체 소부장")).toBeVisible();
  expect(storedShape(scenario)[0]).toEqual(["반도체 소부장", ["005930", "000660"]]);
});

test("이름 바꾸기 중 Esc는 이름만 되돌리고 서랍은 닫지 않는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await openEditor(page);
  await drawer(page).getByRole("button", { name: "반도체 이름 바꾸기" }).click();
  const field = drawer(page).getByRole("textbox", { name: "반도체 새 이름" });
  await field.fill("바뀌면 안 됨");
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  await expect(themeRow(page, "반도체")).toBeVisible();
  await expect(save(page)).toBeDisabled();
});

test("테마를 지우려면 한 번 더 확인해야 한다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await openEditor(page);
  await drawer(page).getByRole("button", { name: "지주 지우기", exact: true }).click();
  await expect(themeRow(page, "지주")).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await drawer(page).getByRole("button", { name: "지주 지우기 취소" }).click();
  await expect(themeRow(page, "지주")).toBeVisible();
  await drawer(page).getByRole("button", { name: "지주 지우기", exact: true }).click();
  await drawer(page).getByRole("button", { name: "지주 지우기 확인" }).click();
  await expect(themeRow(page, "지주")).toHaveCount(0);
  await save(page).click();
  await expect(group(page, "지주")).toHaveCount(0);
  expect(storedShape(scenario)).toEqual([["반도체", ["005930", "000660"]]]);
});

test("테마 순서를 아래 단추로 바꾸면 저장 뒤 내 순서 보드가 따른다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap?order=custom");
  await expect(tile(page, "005930")).toBeVisible();
  await main(page).getByRole("button", { name: "테마 편집", exact: true }).click();
  await expect(drawer(page).getByRole("button", { name: "반도체 위로" })).toBeDisabled();
  await drawer(page).getByRole("button", { name: "반도체 아래로" }).click();
  await expect.poll(() => THEME_LIST_NAMES(page)).toEqual(["지주", "반도체"]);
  await save(page).click();
  await expect.poll(() => main(page).locator(".hm-group h2").allTextContents()).toEqual(["지주", "반도체"]);
  expect(storedShape(scenario).map(([name]) => name)).toEqual(["지주", "반도체"]);
});

test("테마 줄을 끌어 놓으면 순서가 바뀐다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await openEditor(page);
  await themeRow(page, "지주").locator(".hm-edit-grip").dragTo(themeRow(page, "반도체"), { targetPosition: { x: 40, y: 2 } });
  await expect.poll(() => THEME_LIST_NAMES(page)).toEqual(["지주", "반도체"]);
  await expect(save(page)).toBeEnabled();
});

test("종목을 끌거나 아래 단추로 순서를 바꾸고 빼면 저장 뒤 그대로 남는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table(), { revision: 100, themes: [{ id: "chips", name: "반도체", symbols: ["005930", "000660", "028260"] }] });
  await openEditor(page);
  const row = (code: string) => memberRows(page).locator(`li[data-code="${code}"]`);
  const order = () => memberRows(page).locator("li").evaluateAll((rows) => rows.map((el) => el.getAttribute("data-code")));
  await row("028260").locator(".hm-edit-grip").dragTo(row("005930"), { targetPosition: { x: 40, y: 2 } });
  await expect.poll(order).toEqual(["028260", "005930", "000660"]);
  await drawer(page).getByRole("button", { name: "삼성전자 아래로" }).click();
  await expect.poll(order).toEqual(["028260", "000660", "005930"]);
  await drawer(page).getByRole("button", { name: "SK하이닉스 빼기" }).click();
  await expect.poll(order).toEqual(["028260", "005930"]);
  await save(page).click();
  await expect(drawer(page)).toHaveCount(0);
  expect(storedShape(scenario)).toEqual([["반도체", ["028260", "005930"]]]);
});

test("테마 이름이 비었으면 만들지 못하고 문구로 알린다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await openEditor(page);
  await newName(page).fill("   ");
  await newName(page).press("Enter");
  await expect(footer(page)).toHaveText("테마 이름을 적어 주세요");
  await expect(footer(page)).toHaveAttribute("role", "alert");
  await expect(save(page)).toBeDisabled();
});

test("다른 테마와 같은 이름은 만들거나 바꿀 수 없다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await openEditor(page);
  await addTheme(page, "지주");
  await expect(footer(page)).toHaveText("같은 이름의 테마가 이미 있습니다: 지주");
  await drawer(page).getByRole("button", { name: "반도체 이름 바꾸기" }).click();
  const field = drawer(page).getByRole("textbox", { name: "반도체 새 이름" });
  await field.fill("지주");
  await field.press("Enter");
  await expect(footer(page)).toHaveText("같은 이름의 테마가 이미 있습니다: 지주");
  await expect(themeRow(page, "반도체")).toBeVisible();
  await expect(save(page)).toBeDisabled();
});

test("테마 이름이 40자를 넘으면 만들지 못하고 40자는 받는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await openEditor(page);
  await addTheme(page, "가".repeat(41));
  await expect(footer(page)).toHaveText("테마 이름은 40자까지입니다");
  await newName(page).fill("가".repeat(40));
  await newName(page).press("Enter");
  await expect(themeRow(page, "가".repeat(40))).toBeVisible();
});

test("종목 검색은 지수를 보이지 않는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await openEditor(page);
  await searchField(page).fill("코스피");
  await expect(drawer(page).getByText("찾은 종목이 없습니다")).toBeVisible();
  await searchField(page).fill("KODEX");
  await expect(result(page, "069500")).toBeVisible();
});

test("이미 든 종목은 이미 있음으로 막는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await openEditor(page);
  await searchField(page).fill("삼성전자");
  await expect(result(page, "005930")).toBeDisabled();
  await expect(result(page, "005930")).toContainText("이미 있음");
  await expect(result(page, "005935")).toBeEnabled();
});

test("종목이 60개 찬 테마에는 더 넣지 못한다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table(), { revision: 100, themes: [sixty()] });
  await page.goto("/heatmap");
  await main(page).getByRole("button", { name: "테마 편집", exact: true }).click();
  await expect(drawer(page).getByText("종목 60 / 60")).toBeVisible();
  await searchField(page).fill("에코프로");
  await expect(result(page, "086520")).toBeDisabled();
  await expect(result(page, "086520")).toContainText("가득 참");
});

test("관심종목 그룹에서 가져오면 같은 이름·순서의 테마가 더해지고 이름이 같은 그룹은 건너뛴다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  seedList(scenario, [
    { id: "g1", name: "반도체", symbols: ["005930"] },
    { id: "g2", name: "신규 테마", symbols: ["086520", "005930"] },
    { id: "g3", name: "둘째 신규", symbols: ["028260"] },
  ]);
  const before = scenario.documents.watchlists();
  await openEditor(page);
  await drawer(page).getByRole("button", { name: "관심종목 그룹에서 가져오기" }).click();
  await drawer(page).getByRole("button", { name: "히트맵 · 그룹 3개" }).click();
  const notices = drawer(page).getByRole("status", { name: "가져오기 결과" });
  await expect(notices).toContainText("‘히트맵’ 목록에서 테마 2개를 가져왔습니다.");
  await expect(notices).toContainText("이름이 같은 테마가 이미 있어 건너뜀: 반도체");
  await expect.poll(() => THEME_LIST_NAMES(page)).toEqual(["반도체", "지주", "신규 테마", "둘째 신규"]);
  await expect(themeRow(page, "신규 테마")).toHaveAttribute("aria-current", "true");
  await save(page).click();
  await expect(group(page, "신규 테마").locator(".hm-tile")).toHaveCount(2);
  expect(storedShape(scenario)).toEqual([["반도체", ["005930", "000660"]], ["지주", ["028260", "086520"]], ["신규 테마", ["086520", "005930"]], ["둘째 신규", ["028260"]]]);
  expect(scenario.documents.watchlists()).toEqual(before);
  expect(scenario.requests.filter((request) => new URL(request.url()).pathname === "/api/watchlists" && request.method() === "PUT")).toHaveLength(0);
});

test("가져오는 그룹의 종목이 60개를 넘으면 앞의 60개만 넣고 지수는 빼며 알린다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table(), { revision: 100, themes: [] });
  seedList(scenario, [
    { id: "g1", name: "많음", symbols: codes(65) },
    { id: "g2", name: "섞임", symbols: ["IDX:001", "005930", "IDX:101"] },
  ]);
  await page.goto("/heatmap");
  await main(page).getByRole("button", { name: "관심종목 그룹에서 가져오기" }).click();
  await drawer(page).getByRole("button", { name: "히트맵 · 그룹 2개" }).click();
  const notices = drawer(page).getByRole("status", { name: "가져오기 결과" });
  await expect(notices).toContainText("‘많음’ 그룹은 종목이 65개라 앞의 60개만 넣었습니다.");
  await expect(notices).toContainText("‘섞임’ 그룹의 지수 2개는 뺐습니다.");
  await save(page).click();
  await expect(drawer(page)).toHaveCount(0);
  expect(stored(scenario).themes.map((theme) => [theme.name, theme.symbols.length])).toEqual([["많음", 60], ["섞임", 1]]);
  expect(stored(scenario).themes[0]!.symbols).toEqual(codes(60));
  expect(stored(scenario).themes[1]!.symbols).toEqual(["005930"]);
});

test("그룹이 없는 관심종목 목록을 고르면 가져올 것이 없다고 알린다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  seedList(scenario, []);
  await openEditor(page);
  await drawer(page).getByRole("button", { name: "관심종목 그룹에서 가져오기" }).click();
  await drawer(page).getByRole("button", { name: "그룹 없음 · 그룹 0개" }).click();
  await expect(drawer(page).getByRole("status", { name: "가져오기 결과" })).toContainText("‘그룹 없음’ 목록에는 그룹이 없어 가져올 테마가 없습니다.");
  await expect(save(page)).toBeDisabled();
});

test("테마가 없을 때 가져오기 단추는 서랍을 가져오기 상태로 연다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table(), { revision: 100, themes: [] });
  seedList(scenario, [{ id: "g1", name: "반도체", symbols: ["005930"] }]);
  await page.goto("/heatmap");
  await expect(main(page).getByText("테마가 없습니다")).toBeVisible();
  await main(page).getByRole("button", { name: "관심종목 그룹에서 가져오기" }).click();
  await expect(drawer(page).getByRole("group", { name: "관심종목 그룹에서 가져오기" })).toBeVisible();
  await expect(drawer(page).getByRole("button", { name: "히트맵 · 그룹 1개" })).toBeVisible();
});

test("테마가 없을 때 직접 만들기 단추는 새 테마 이름 칸에 초점을 둔다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table(), { revision: 100, themes: [] });
  await page.goto("/heatmap");
  await main(page).getByRole("button", { name: "테마 직접 만들기" }).click();
  await expect(newName(page)).toBeFocused();
  await expect(drawer(page).getByRole("group", { name: "관심종목 그룹에서 가져오기" })).toHaveCount(0);
  await addTheme(page, "첫 테마");
  await save(page).click();
  await expect(group(page, "첫 테마")).toBeVisible();
  expect(storedShape(scenario)).toEqual([["첫 테마", []]]);
});

test("다른 곳에서 테마가 먼저 바뀌어 409가 나면 알리고 고친 내용을 남기며 최신 문서를 다시 받을 수 있다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await openEditor(page);
  await addTheme(page, "내 테마");
  scenario.documents.saveHeatmapThemes({ revision: 2_000_000_000_000_000, themes: [{ id: "other", name: "다른 곳에서 만든 테마", symbols: [] }] });
  await save(page).click();
  await expect(footer(page)).toContainText("최신 문서를 다시 받아야 합니다");
  await expect(footer(page)).toHaveAttribute("role", "alert");
  await expect(drawer(page)).toBeVisible();
  await expect(themeRow(page, "내 테마")).toBeVisible();
  expect(storedShape(scenario)).toEqual([["다른 곳에서 만든 테마", []]]);
  await drawer(page).getByRole("button", { name: "최신 문서 다시 받기" }).click();
  await expect.poll(() => THEME_LIST_NAMES(page)).toEqual(["다른 곳에서 만든 테마"]);
  await expect(save(page)).toBeDisabled();
  await addTheme(page, "이어서 만든 테마");
  await save(page).click();
  await expect(drawer(page)).toHaveCount(0);
  expect(storedShape(scenario)).toEqual([["다른 곳에서 만든 테마", []], ["이어서 만든 테마", []]]);
});

test("서버가 저장을 거절하면 메시지를 보이고 고친 내용을 남긴다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  scenario.on((url, request) => url.pathname === THEMES_PATH && request.method() === "PUT", () => ({ status: 400, body: { error: { code: "bad_request", message: "종목 코드가 올바르지 않습니다", reason: null, retryAt: null, manualActionRequired: false } } }));
  await openEditor(page);
  await addTheme(page, "거절될 테마");
  await save(page).click();
  await expect(footer(page)).toHaveText("저장하지 못했습니다: 종목 코드가 올바르지 않습니다");
  await expect(footer(page)).toHaveAttribute("role", "alert");
  await expect(drawer(page)).toBeVisible();
  await expect(themeRow(page, "거절될 테마")).toBeVisible();
  await expect(save(page)).toBeEnabled();
  expect(storedShape(scenario).map(([name]) => name)).toEqual(["반도체", "지주"]);
});

test("칸을 우클릭해 다른 테마에 추가하면 서랍 없이 한 번의 저장으로 보드에 나타난다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap");
  await expect(tile(page, "028260")).toBeVisible();
  await tile(page, "028260").click({ button: "right" });
  const actions = page.getByRole("menu", { name: "삼성물산 칸 동작" });
  await actions.getByRole("menuitem", { name: "다른 테마에 추가" }).click();
  const themes = page.getByRole("menu", { name: "삼성물산 다른 테마에 추가" });
  await expect(themes.getByRole("menuitem", { name: "지주" })).toHaveCount(0);
  await themes.getByRole("menuitem", { name: "반도체" }).click();
  await expect(toast(page)).toHaveText("‘반도체’ 테마에 추가했습니다: 삼성물산");
  await expect(group(page, "반도체").locator(".hm-tile")).toHaveCount(3);
  await expect(drawer(page)).toHaveCount(0);
  expect(storedShape(scenario)).toEqual([["반도체", ["005930", "000660", "028260"]], ["지주", ["028260", "086520"]]]);
  expect(themeRequests(scenario)).toEqual(["GET", "PUT"]);
});

test("이미 든 테마는 메뉴에서 이미 있음으로 막힌다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table(), { revision: 100, themes: [{ id: "chips", name: "반도체", symbols: ["005930", "000660"] }, { id: "both", name: "대형주", symbols: ["005930"] }, { id: "other", name: "기타", symbols: [] }] });
  await page.goto("/heatmap");
  await expect(tile(page, "005930").first()).toBeVisible();
  await group(page, "반도체").locator('.hm-tile[data-code="005930"]').click({ button: "right" });
  await page.getByRole("menu", { name: "삼성전자 칸 동작" }).getByRole("menuitem", { name: "다른 테마에 추가" }).click();
  const themes = page.getByRole("menu", { name: "삼성전자 다른 테마에 추가" });
  await expect(themes.getByRole("menuitem", { name: /^대형주/ })).toBeDisabled();
  await expect(themes.getByRole("menuitem", { name: /^대형주/ })).toContainText("이미 있음");
  await expect(themes.getByRole("menuitem", { name: "기타" })).toBeEnabled();
});

test("칸 메뉴로 이 테마에서 빼면 바로 저장하고 그 칸이 사라진다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap");
  await expect(tile(page, "000660")).toBeVisible();
  await tile(page, "000660").click({ button: "right" });
  await page.getByRole("menu", { name: "SK하이닉스 칸 동작" }).getByRole("menuitem", { name: "이 테마에서 빼기" }).click();
  await expect(tile(page, "000660")).toHaveCount(0);
  await expect(toast(page).locator(".ui-toast-text")).toHaveText("‘반도체’ 테마에서 뺐습니다: SK하이닉스");
  expect(storedShape(scenario)).toEqual([["반도체", ["005930"]], ["지주", ["028260", "086520"]]]);
  expect(themeRequests(scenario)).toEqual(["GET", "PUT"]);
});

test("칸 메뉴 첫 항목은 차트로 보내기와 관심종목에 추가이고 테마 목록에서 뒤로 돌아간다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap");
  await tile(page, "005930").click({ button: "right" });
  const actions = page.getByRole("menu", { name: "삼성전자 칸 동작" });
  await expect(actions.getByRole("menuitem").first()).toHaveAccessibleName("차트로 보내기");
  await expect(actions.getByRole("menuitem").nth(1)).toHaveAccessibleName("관심종목에 추가");
  await actions.getByRole("menuitem", { name: "관심종목에 추가" }).click();
  await expect(toast(page).locator(".ui-toast-text")).toContainText("삼성전자");
  await tile(page, "005930").click({ button: "right" });
  await page.getByRole("menu", { name: "삼성전자 칸 동작" }).getByRole("menuitem", { name: "다른 테마에 추가" }).click();
  await page.getByRole("menu", { name: "삼성전자 다른 테마에 추가" }).getByRole("menuitem", { name: /뒤로/ }).click();
  await expect(page.getByRole("menu", { name: "삼성전자 칸 동작" })).toBeVisible();
});

test("뺀 알림의 되돌리기는 같은 자리에 그 종목을 다시 넣는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table(), { revision: 100, themes: [{ id: "chips", name: "반도체", symbols: ["005930", "000660", "028260"] }] });
  await page.goto("/heatmap");
  await tile(page, "000660").click({ button: "right" });
  await page.getByRole("menu", { name: "SK하이닉스 칸 동작" }).getByRole("menuitem", { name: "이 테마에서 빼기" }).click();
  await expect(tile(page, "000660")).toHaveCount(0);
  expect(storedShape(scenario)).toEqual([["반도체", ["005930", "028260"]]]);
  await toast(page).getByRole("button", { name: /되돌리기/ }).click();
  await expect(tile(page, "000660")).toBeVisible();
  expect(storedShape(scenario)).toEqual([["반도체", ["005930", "000660", "028260"]]]);
});

test("칸 메뉴는 키보드 Shift+F10으로도 열리고 Esc로 닫힌다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap");
  await tile(page, "086520").focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "에코프로 칸 동작" });
  await expect(menu.getByRole("menuitem", { name: "이 테마에서 빼기" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(tile(page, "086520")).toBeFocused();
});

test("칸 메뉴의 저장은 최신 문서를 받아 적용해 다른 곳에서 더한 테마를 지우지 않는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap");
  await expect(tile(page, "005930")).toBeVisible();
  const latest = stored(scenario);
  scenario.documents.saveHeatmapThemes({ revision: latest.revision + 50, themes: [...latest.themes, { id: "added-elsewhere", name: "다른 곳에서 더함", symbols: ["000660"] }] });
  await tile(page, "005930").click({ button: "right" });
  await page.getByRole("menu", { name: "삼성전자 칸 동작" }).getByRole("menuitem", { name: "다른 테마에 추가" }).click();
  await page.getByRole("menu", { name: "삼성전자 다른 테마에 추가" }).getByRole("menuitem", { name: "지주" }).click();
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["005930", "000660"]], ["지주", ["028260", "086520", "005930"]], ["다른 곳에서 더함", ["000660"]]]);
  expect(themeRequests(scenario)).toEqual(["GET", "PUT"]);
});

test("칸 메뉴의 저장이 거절되면 메시지를 알리고 문서를 바꾸지 않는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  scenario.on((url, request) => url.pathname === THEMES_PATH && request.method() === "PUT", () => ({ status: 400, body: { error: { code: "bad_request", message: "테마가 너무 큽니다", reason: null, retryAt: null, manualActionRequired: false } } }));
  await page.goto("/heatmap");
  await expect(tile(page, "000660")).toBeVisible();
  await tile(page, "000660").click({ button: "right" });
  await page.getByRole("menu", { name: "SK하이닉스 칸 동작" }).getByRole("menuitem", { name: "이 테마에서 빼기" }).click();
  await expect(toast(page)).toHaveText("테마를 저장하지 못했습니다: 테마가 너무 큽니다");
  await expect(tile(page, "000660")).toBeVisible();
  expect(storedShape(scenario)).toEqual([["반도체", ["005930", "000660"]], ["지주", ["028260", "086520"]]]);
});
