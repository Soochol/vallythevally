import type { Page } from "@playwright/test";
import { expect, test, type Scenario } from "./harness";
import { HEATMAP_TABLE, seedHeatmapThemes } from "./fixtures/heatmap-data";
import type { PublicSession } from "./fixtures/public-mode-data";
import { rankingRows, serveRankings } from "./fixtures/ranking-data";

test.use({ clockStart: "20261109100000" });

const SESSION: PublicSession = { provider: "google", createdAt: Date.parse("2026-11-09T09:30:00+09:00") / 1000 };
const landing = (page: Page) => page.getByTestId("landing");
const pathOf = (request: { url(): string }) => new URL(request.url()).pathname;

function listenerOnlyForbidden(scenario: Scenario) {
  const forbidden = scenario.requests.map(pathOf).filter((p) => p.startsWith("/api/bars") || p === "/api/quotes" || p.startsWith("/api/system/") || p.startsWith("/api/account") || p.startsWith("/api/trading/"));
  expect(forbidden).toEqual([]);
  expect(scenario.live.opened).toBe(0);
}

test("Google·네이버 단추는 브라우저 로그인 시작 경로로 최상위 이동하고 로그인 전에는 금지 API를 부르지 않는다", async ({ page, scenario }) => {
  scenario.publicMode.enable(null);
  await page.goto("/");
  await expect(landing(page)).toBeVisible();
  expect(scenario.requests.filter((r) => pathOf(r) === "/v1/session")).toHaveLength(1);
  listenerOnlyForbidden(scenario);

  await page.getByRole("button", { name: "로그인", exact: true }).click();
  const started = page.waitForRequest((request) => pathOf(request) === "/v1/session/google/start");
  await page.getByRole("button", { name: "Google로 로그인" }).click();
  const request = await started;
  expect(request.isNavigationRequest()).toBe(true);
  expect(request.frame()).toBe(page.mainFrame());
  expect(request.method()).toBe("GET");
});

test("로그인 뒤 순위 창·히트맵·공개 불가 창이 금지 경로 호출 없이 동작한다", async ({ page, scenario }) => {
  scenario.publicMode.enable(SESSION);
  serveRankings(scenario, { rows: () => rankingRows(30), pageSize: 30 });
  await page.goto("/");
  await expect(page.getByRole("complementary", { name: "관심종목" })).toBeVisible();
  await expect(page.getByTestId("public-unavailable").first()).toContainText("실시간·차트 연결은 준비 중입니다");
  seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
  await page.goto("/heatmap");
  await expect(page.getByRole("main", { name: "히트맵", exact: true }).locator('.hm-list-row[data-code="005930"]')).toContainText("+2.00%");
  listenerOnlyForbidden(scenario);
});
