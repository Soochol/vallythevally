import type { Page } from "@playwright/test";
import type { HeatmapBoard } from "../src/api/generated/HeatmapBoard";
import type { KiwoomCatalogInfo } from "../src/api/generated/KiwoomCatalogInfo";
import { KIWOOM_CATALOG, KIWOOM_TABLE, QUOTED_AT, flowSeries, seedHeatmapFlow, seedHeatmapThemes } from "./fixtures/heatmap-data";
import { expect, pollSaved, test, type Scenario } from "./harness";

test.use({ clockStart: "20261109100000" });

const THEMES_PATH = "/api/heatmap/themes";
const SHIPBUILDING = "kiwoom-319";
const SHIPBUILDING_SYMBOLS = ["010140", "009540", "042660"];
const main = (page: Page) => page.getByRole("main", { name: "히트맵", exact: true });
const sourceTab = (page: Page, name: string) => main(page).getByRole("tablist", { name: "테마 출처" }).getByRole("tab", { name });
const themeTiles = (page: Page) => main(page).locator(".hm-theme-tile");
const themeTile = (page: Page, id: string) => main(page).locator(`.hm-theme-tile[data-theme="${id}"]`);
const stockTile = (page: Page, code: string) => main(page).locator(`.hm-tile[data-code="${code}"]`);
const detail = (page: Page, name: string) => main(page).getByRole("region", { name: `${name} 지도` });
const crumbs = (page: Page) => main(page).getByRole("navigation", { name: "키움 테마 경로" });
const toast = (page: Page) => page.locator(".ui-toast");
const importButton = (page: Page) => detail(page, "조선").getByRole("button", { name: "내 테마로 가져오기" });
const themeRequests = (scenario: Scenario) => scenario.requests.filter((request) => new URL(request.url()).pathname === THEMES_PATH).map((request) => request.method());
const storedShape = (scenario: Scenario) => scenario.documents.heatmapThemes().themes.map((theme) => [theme.name, theme.symbols]);

function seedKiwoom(scenario: Scenario) {
  scenario.kiwoomCatalog = KIWOOM_CATALOG;
  return seedHeatmapThemes(scenario, structuredClone(KIWOOM_TABLE));
}

function notReady(state: "collecting" | "empty"): KiwoomCatalogInfo {
  return { date: null, collectedAt: null, themes: 0, state };
}

test("키움 테마 탭을 누르면 주소에 출처가 붙고 내 테마 탭으로 돌아가면 빠진다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  await page.goto("/heatmap");
  await expect(detail(page, "반도체")).toBeVisible();
  await expect(sourceTab(page, "내 테마")).toHaveAttribute("aria-selected", "true");
  await sourceTab(page, "키움 테마").click();
  await expect(page).toHaveURL(/[?&]source=kiwoom(&|$)/);
  await expect(sourceTab(page, "키움 테마")).toHaveAttribute("aria-selected", "true");
  await expect(themeTiles(page)).toHaveCount(3);
  await sourceTab(page, "내 테마").click();
  await expect(page).not.toHaveURL(/source=/);
  await expect(detail(page, "반도체")).toBeVisible();
  await expect(themeTiles(page)).toHaveCount(0);
});

test("키움 테마 탭은 보드를 source=kiwoom으로 요청하고 내 테마 탭은 mine으로 요청한다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  await page.goto("/heatmap?source=kiwoom");
  await expect(themeTiles(page)).toHaveCount(3);
  const sources = () => scenario.requests.filter((request) => new URL(request.url()).pathname === "/api/heatmap/board").map((request) => new URL(request.url()).searchParams.get("source"));
  expect(sources()).toEqual(["kiwoom"]);
  await sourceTab(page, "내 테마").click();
  await expect(detail(page, "반도체")).toBeVisible();
  expect(sources()).toEqual(["kiwoom", "mine"]);
});

test("테마 지도는 테마마다 칸 하나이고 색 부호가 가중 평균을 따른다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  await page.goto("/heatmap?source=kiwoom");
  await expect(themeTile(page, SHIPBUILDING)).toHaveAttribute("data-side", "up");
  await expect(themeTile(page, "kiwoom-101")).toHaveAttribute("data-side", "up");
  await expect(themeTile(page, "kiwoom-777")).toHaveAttribute("data-side", "down");
  await expect(themeTile(page, SHIPBUILDING)).toHaveAccessibleName("조선 +1.50% 상승 2 · 하락 1");
  await expect(themeTile(page, "kiwoom-777")).toHaveAccessibleName("에코프로 단독 −4.00% 상승 0 · 하락 1");
  await expect(main(page).getByRole("img", { name: /^색 범위/ })).toBeVisible();
});

test("종목이 하나뿐인 작은 테마도 지도에서 숨기지 않는다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  await page.goto("/heatmap?source=kiwoom");
  const small = themeTile(page, "kiwoom-777");
  await expect(small).toBeVisible();
  const box = (await small.boundingBox())!;
  expect(box.width).toBeGreaterThan(8);
  expect(box.height).toBeGreaterThan(8);
});

test("테마 칸의 크기는 테마 거래대금 합을 따른다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  await page.goto("/heatmap?source=kiwoom");
  const area = async (id: string) => {
    const box = (await themeTile(page, id).boundingBox())!;
    return box.width * box.height;
  };
  await expect(themeTiles(page)).toHaveCount(3);
  const [chips, ship, small] = [await area("kiwoom-101"), await area(SHIPBUILDING), await area("kiwoom-777")];
  expect(chips).toBeGreaterThan(ship);
  expect(ship).toBeGreaterThan(small);
});

test("키움 테마 지도는 큰 테마부터 놓고 테마 순서 설정은 보이지 않는다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  await page.goto("/heatmap?source=kiwoom");
  await expect(themeTiles(page)).toHaveCount(3);
  const areas = await themeTiles(page).evaluateAll((tiles) => tiles.map((tile) => tile.getBoundingClientRect()).map((box) => box.width * box.height));
  expect(areas).toEqual([...areas].sort((a, b) => b - a));
  await expect(main(page).getByRole("group", { name: "테마 순서" })).toHaveCount(0);
  await expect(main(page).getByRole("group", { name: "색 범위" })).toBeVisible();
});

test("테마 칸을 누르면 그 테마의 칸 지도가 열리고 주소에 테마가 남는다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  await page.goto("/heatmap?source=kiwoom");
  await themeTile(page, SHIPBUILDING).click();
  await expect(page).toHaveURL(/[?&]theme=kiwoom-319(&|$)/);
  await expect(detail(page, "조선").locator(".hm-tile")).toHaveCount(3);
  await expect(themeTiles(page)).toHaveCount(0);
  await expect(detail(page, "조선").getByLabel("테마 요약")).toContainText("상승 2 · 보합 0 · 하락 1");
  await expect(stockTile(page, "010140")).toHaveAccessibleName("삼성중공업 +3.00%");
  await expect(crumbs(page)).toContainText("조선");
});

test("새로 고침하면 고른 테마가 그대로이고 뒤로 가기는 테마 지도로 돌아간다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  await page.goto("/heatmap?source=kiwoom");
  await themeTile(page, SHIPBUILDING).click();
  await expect(detail(page, "조선")).toBeVisible();
  await page.reload();
  await expect(detail(page, "조선").locator(".hm-tile")).toHaveCount(3);
  await page.goBack();
  await expect(themeTiles(page)).toHaveCount(3);
  await expect(page).not.toHaveURL(/theme=/);
});

test("빵부스러기의 키움 테마 링크가 테마 지도로 돌아간다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  await page.goto(`/heatmap?source=kiwoom&theme=${SHIPBUILDING}`);
  await expect(detail(page, "조선")).toBeVisible();
  await crumbs(page).getByRole("link", { name: "키움 테마" }).click();
  await expect(themeTiles(page)).toHaveCount(3);
  await expect(page).toHaveURL(/[?&]source=kiwoom(&|$)/);
  await expect(page).not.toHaveURL(/theme=/);
});

test("주소의 테마가 목록에 없으면 찾지 못했다고 알리고 돌아갈 링크를 둔다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  await page.goto("/heatmap?source=kiwoom&theme=kiwoom-999");
  await expect(main(page).getByText("고른 키움 테마를 찾지 못했습니다")).toBeVisible();
  await crumbs(page).getByRole("link", { name: "키움 테마" }).click();
  await expect(themeTiles(page)).toHaveCount(3);
});

test("키움 테마 탭에는 테마 편집 단추가 없다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  await page.goto("/heatmap?source=kiwoom");
  await expect(themeTiles(page)).toHaveCount(3);
  await expect(main(page).getByRole("button", { name: "테마 편집", exact: true })).toHaveCount(0);
  await sourceTab(page, "내 테마").click();
  await expect(main(page).getByRole("button", { name: "테마 편집", exact: true })).toBeVisible();
});

test("키움 테마의 종목 칸을 우클릭해도 테마 편집 메뉴가 뜨지 않는다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  await page.goto(`/heatmap?source=kiwoom&theme=${SHIPBUILDING}`);
  await expect(stockTile(page, "010140")).toBeVisible();
  await expect(stockTile(page, "010140")).not.toHaveAttribute("aria-haspopup", /.*/);
  await stockTile(page, "010140").dispatchEvent("contextmenu");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("내 테마로 가져오기는 같은 이름과 종목으로 맨 뒤에 추가하고 토스트로 알린다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  await page.goto(`/heatmap?source=kiwoom&theme=${SHIPBUILDING}`);
  await importButton(page).click();
  await expect(toast(page)).toHaveText("‘조선’ 테마를 내 테마로 가져왔습니다 (종목 3개)");
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["005930", "000660"]], ["지주", ["028260", "086520"]], ["조선", SHIPBUILDING_SYMBOLS]]);
  await sourceTab(page, "내 테마").click();
  await expect(detail(page, "조선").locator(".hm-tile")).toHaveCount(3);
});

test("같은 이름의 내 테마가 있으면 가져오지 않고 토스트로 알린다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  scenario.documents.saveHeatmapThemes({ revision: 100, themes: [{ id: "mine-ship", name: "조선", symbols: ["005930"] }] });
  await page.goto(`/heatmap?source=kiwoom&theme=${SHIPBUILDING}`);
  await importButton(page).click();
  await expect(toast(page)).toHaveText("이름이 같은 내 테마가 이미 있어 가져오지 않았습니다: 조선");
  expect(storedShape(scenario)).toEqual([["조선", ["005930"]]]);
  expect(themeRequests(scenario)).not.toContain("PUT");
});

test("내 테마로 가져올 때 종목이 60개를 넘으면 앞의 60개만 담고 알린다", async ({ page, scenario }) => {
  const codes = Array.from({ length: 75 }, (_, i) => String(300000 + i));
  seedKiwoom(scenario);
  scenario.kiwoomCatalog = { ...KIWOOM_CATALOG, themes: [{ id: "kiwoom-500", name: "큰 테마", symbols: codes }] };
  await page.goto("/heatmap?source=kiwoom&theme=kiwoom-500");
  await detail(page, "큰 테마").getByRole("button", { name: "내 테마로 가져오기" }).click();
  await expect(toast(page)).toHaveText("‘큰 테마’ 테마를 내 테마로 가져왔습니다 (종목 60개, 75개 중 앞의 60개만)");
  await pollSaved(() => scenario.documents.heatmapThemes().themes.at(-1)?.symbols).toEqual(codes.slice(0, 60));
});

test("흐름 비교는 키움 탭에서 고른 테마 하나만 요청하고 그린다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  const asked = seedHeatmapFlow(scenario, { [SHIPBUILDING_SYMBOLS.join(",")]: flowSeries([0.2, 0.9, 1.5], SHIPBUILDING_SYMBOLS) });
  await page.goto(`/heatmap?source=kiwoom&theme=${SHIPBUILDING}`);
  await expect(detail(page, "조선")).toBeVisible();
  await main(page).getByRole("tab", { name: "흐름 비교" }).click();
  await expect(main(page).locator(".hm-flow-line")).toHaveCount(1);
  await expect(main(page).getByRole("img", { name: "테마별 장중 가중 평균 등락률" }).getByText("조선 +1.50%")).toBeVisible();
  expect(asked).toEqual([SHIPBUILDING_SYMBOLS.join(",")]);
  await expect(page).toHaveURL(/[?&]view=flow(&|$)/);
  await expect(page).toHaveURL(/[?&]theme=kiwoom-319(&|$)/);
});

test("고른 테마가 없으면 흐름 비교는 안내만 하고 흐름을 요청하지 않는다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  const asked = seedHeatmapFlow(scenario, {});
  await page.goto("/heatmap?source=kiwoom&view=flow");
  await expect(main(page).getByText("테마를 고르면 그 테마의 흐름을 보입니다")).toBeVisible();
  await expect(main(page).locator(".hm-flow-line")).toHaveCount(0);
  expect(asked).toEqual([]);
  await main(page).getByRole("button", { name: "키움 테마 지도로" }).click();
  await expect(themeTiles(page)).toHaveCount(3);
});

test("구성종목을 받는 중이면 받는 중이라고 안내한다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  scenario.kiwoomCatalog = { info: notReady("collecting"), themes: [] };
  await page.goto("/heatmap?source=kiwoom");
  await expect(main(page).getByText("키움 테마 구성종목을 받는 중입니다")).toBeVisible();
  await expect(themeTiles(page)).toHaveCount(0);
});

test("키움 테마를 받은 적이 없으면 08:30 이후 받는다고 안내한다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  scenario.kiwoomCatalog = { info: notReady("empty"), themes: [] };
  await page.goto("/heatmap?source=kiwoom");
  await expect(main(page).getByText("키움 테마를 아직 받지 못했습니다")).toBeVisible();
  await expect(main(page).getByText("키움이 연결되면 08:30 이후 받습니다")).toBeVisible();
});

test("신선도 줄에 구성종목 기준일이 붙고 내 테마 탭에는 붙지 않는다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  const freshness = page.getByRole("status", { name: "자료 신선도" });
  await page.goto("/heatmap?source=kiwoom");
  await expect(themeTiles(page)).toHaveCount(3);
  await expect(freshness).toContainText("구성종목 2026-11-09 기준");
  await sourceTab(page, "내 테마").click();
  await expect(detail(page, "반도체")).toBeVisible();
  await expect(freshness).not.toContainText("구성종목");
});

test("탭을 바꾸는 동안 이전 탭의 테마가 새 탭 자리에 남아 보이지 않는다", async ({ page, scenario }) => {
  seedKiwoom(scenario);
  await page.goto("/heatmap");
  await expect(detail(page, "반도체")).toBeVisible();
  const held = scenario.hold((url) => url.pathname === "/api/heatmap/board" && url.searchParams.get("source") === "kiwoom");
  await sourceTab(page, "키움 테마").click();
  await held.received;
  await expect(main(page).locator(".hm-group")).toHaveCount(0);
  held.reply({ body: { revision: 0, order: "rate", asOf: QUOTED_AT, source: "kiwoom", catalog: notReady("empty"), themes: [] } satisfies HeatmapBoard });
  await expect(main(page).getByText("키움 테마를 아직 받지 못했습니다")).toBeVisible();
});
