import type { Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { Screen } from "../src/api/generated/Screen";
import type { RankingPage } from "../src/api/generated/RankingPage";
import { HEATMAP_TABLE, seedHeatmapThemes } from "./fixtures/heatmap-data";
import { marketOverviewBaseline } from "./fixtures/market-data";
import { isRankingRequest, rankingRows } from "./fixtures/ranking-data";
import { currentResult } from "./fixtures/screener";
import { DEFAULT_LAYOUT_ID, expect, type Scenario, test } from "./screener-harness";
import { openScreener, results, runButton, updateBand, waitForUpdateToFinish } from "./screener-page";

test.use({ clockStart: "20261109100000" });

const MINUTE = 60_000;
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const notes = (page: Page) => page.getByTestId("data-age");

function openRankingLayout(scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chart: LayoutWindow = { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS };
  const ranking: LayoutWindow = { id: "ranking", link: null, kind: "ranking", ranking: { kind: "tradeAmount", market: "all", venue: "combined", excludes: { etfEtn: true, preferred: false }, excludeManaged: false } };
  scenario.documents.saveLayout({ ...layout, windows: [chart, ranking], placement: {}, revision: layout.revision + 1 });
}

function serveRankingPageAt(scenario: Scenario, fetchedAt: number) {
  scenario.on(isRankingRequest, () => ({ body: { rows: rankingRows(3), pages: 1, end: true, limited: false, hidden: 0, fetchedAt, source: "kiwoom" } satisfies RankingPage }));
}

test("순위 창은 받은 시각이 새것이면 나이를 숨기고, 시간이 흘러 낡으면 나이와 낡음 표시를 보인다", async ({ page, scenario }) => {
  openRankingLayout(scenario);
  serveRankingPageAt(scenario, scenario.now / 1000);
  await page.clock.install({ time: scenario.now });
  await page.goto("/");
  await expect(page.getByTestId("ranking-status")).toContainText("받은 시각");
  await expect(notes(page)).toHaveCount(0);

  await page.clock.runFor(30_000);
  await expect(notes(page)).toHaveText("30초 전 자료");
  await expect(notes(page)).toHaveAttribute("data-stale", "false");

  await page.clock.runFor(6 * MINUTE);
  await expect(notes(page)).toHaveText("6분 전 자료 · 자료가 늦어지고 있습니다");
  await expect(notes(page)).toHaveAttribute("data-stale", "true");
});

test("순위 창은 미리 만들지 않은 조건이면 안내만 보이고 창과 조건은 그대로다", async ({ page, scenario }) => {
  openRankingLayout(scenario);
  scenario.on(isRankingRequest, () => ({ status: 404, body: { error: { code: "not_prepared", message: "준비되지 않은 순위", reason: null, retryAt: null, manualActionRequired: false } } }));
  await page.goto("/");
  await expect(page.getByTestId("ranking-window")).toBeVisible();
  await expect(page.getByTestId("ranking-window").getByText("미리 만든 조건만 볼 수 있습니다")).toBeVisible();
  await expect(page.getByTestId("ranking-window")).toHaveAttribute("data-ranking", "tradeAmount");
  await expect(page.getByRole("tab", { name: "거래대금", selected: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "다시 시도" })).toHaveCount(0);
});

test("시장 종합은 장중이면 낡음까지, 장 마감이면 나이만 보인다", async ({ page, scenario }) => {
  const phase = { value: "regular" };
  scenario.on(
    (url) => url.pathname === "/api/market-overview/index",
    (request) => {
      const reply = marketOverviewBaseline(new URL(request.url()), "GET")!;
      const body = reply.body as { context: { phase: string } };
      return { body: { ...body, context: { ...body.context, phase: phase.value } } };
    },
  );
  await page.clock.install({ time: scenario.now });
  await page.goto("/market");
  const bar = page.getByRole("status", { name: "자료 신선도" });
  await expect(bar).toContainText("받은 시각");
  await expect(notes(page)).toHaveCount(0);

  await page.clock.runFor(2 * MINUTE + 5_000);
  await expect(notes(page)).toHaveText("2분 전 자료");
  await expect(notes(page)).toHaveAttribute("data-stale", "false");

  await page.clock.runFor(4 * MINUTE);
  await expect(notes(page)).toHaveText("6분 전 자료 · 자료가 늦어지고 있습니다");

  phase.value = "closed";
  await page.clock.runFor(MINUTE);
  await expect(bar).toContainText("장 마감");
  await expect(notes(page)).toHaveText("7분 전 자료");
  await expect(notes(page)).toHaveAttribute("data-stale", "false");
});

test("히트맵 보드는 기준 시각이 낡으면 나이와 낡음 표시를 보이고 30초마다 다시 받는다", async ({ page, scenario }) => {
  const asked = seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
  await page.clock.install({ time: scenario.now });
  await page.goto("/heatmap");
  await expect(page.getByRole("region", { name: "반도체 목록" })).toBeVisible();
  await expect(notes(page)).toHaveCount(0);
  const first = asked.length;

  await page.clock.runFor(31_000);
  await expect.poll(() => asked.length).toBeGreaterThan(first);
  const second = asked.length;
  await page.clock.runFor(30_000);
  await expect.poll(() => asked.length).toBeGreaterThan(second);

  await page.clock.runFor(6 * MINUTE);
  await expect(notes(page)).toContainText("자료가 늦어지고 있습니다");
  await expect(notes(page)).toHaveAttribute("data-stale", "true");
});

test("스크리너 결과는 수집이 낡으면 나이와 낡음 표시를 보이고 새것이면 보이지 않는다", async ({ page, scenario, screener }) => {
  const nowSeconds = scenario.now / 1000;
  const screen: Screen = { id: "current", name: "최신 자료 확인", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "D", field: "close", n: 1, recentBars: 1 }] };
  scenario.documents.saveScreens({ screens: [screen], revision: 1 });
  screener.showResult({ ...currentResult(), asOf: "2026-11-09", collectionStartedAt: nowSeconds - 4, collectionCompletedAt: nowSeconds });
  await page.clock.install({ time: scenario.now });
  await page.goto("/");
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
  await runButton(page).click();
  await expect(results(page)).toHaveAttribute("aria-busy", "false");
  await expect(notes(page)).toHaveCount(0);

  await page.clock.runFor(6 * MINUTE);
  await expect(results(page).getByTestId("data-age")).toHaveText("6분 전 자료 · 자료가 늦어지고 있습니다");
});
