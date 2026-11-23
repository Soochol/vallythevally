import type { Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { MarketSourceStatus } from "../src/api/generated/MarketSourceStatus";
import type { Ranking } from "../src/api/generated/Ranking";
import { serveMarketRankings } from "./fixtures/market-data";
import { KIS_MARKET_SOURCE, KIS_SOURCE_KIWOOM_FEED } from "./fixtures/market-source";
import { serveRankings } from "./fixtures/ranking-data";
import { readyStatus } from "./fixtures/screener";
import { CONNECTED_KIWOOM } from "./fixtures/scenario";
import { DEFAULT_LAYOUT_ID, expect, test, type Scenario } from "./screener-harness";
import { openScreener, storeLine } from "./screener-page";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const EXCLUDES = { etfEtn: true, preferred: false };
const EXPECTED: Ranking = { kind: "expected", market: "all", venue: "combined", sort: "gainers", excludes: EXCLUDES, excludeManaged: true };
const TRADE_AMOUNT: Ranking = { kind: "tradeAmount", market: "all", venue: "combined", excludes: EXCLUDES, excludeManaged: false };
const NEW_HIGH = { kind: "new_high", period: "D", field: "close", n: 60, recentBars: 1 } as const;

const KIS_FAILED_KIWOOM_RECEIVES: MarketSourceStatus = { ...KIS_SOURCE_KIWOOM_FEED, state: "failed", problem: "network" };
const KIS_FAILED_NOBODY_RECEIVES: MarketSourceStatus = { ...KIS_FAILED_KIWOOM_RECEIVES, feedBroker: null };

const main = (page: Page) => page.getByRole("main", { name: "시장 종합", exact: true });
const card = (page: Page, name: string) => main(page).getByRole("region", { name });
const update = (page: Page) => storeLine(page).getByRole("button", { name: /^(업데이트|연결 뒤)/ });

function openRankingLayout(scenario: Scenario, ranking: Ranking = TRADE_AMOUNT) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chart: LayoutWindow = { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS };
  const windows: LayoutWindow[] = [chart, { id: "ranking", link: null, kind: "ranking", ranking }, ...layout.windows.filter((w) => w.kind !== "chart" && w.kind !== "ranking")];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
}

function showFailedKisWithConnectedKiwoom(scenario: Scenario, source: MarketSourceStatus) {
  scenario.live.kiwoomLink = CONNECTED_KIWOOM;
  scenario.live.marketSource = source;
}

test.describe("한투 연결이 실패해도 키움이 받는 시장 종합·순위 창·스크리너 갱신은 막지 않는다", () => {
  test.describe("한투 연결이 실패했고 키움이 받는 곳일 때", () => {
    test.beforeEach(({ scenario }) => showFailedKisWithConnectedKiwoom(scenario, KIS_FAILED_KIWOOM_RECEIVES));

    test("시장 종합이 막히지 않고 지수 카드와 수급 카드가 보인다", async ({ page, scenario }) => {
      serveMarketRankings(scenario);
      await page.goto("/market");
      await expect(card(page, "지수·폭").getByText("코스피", { exact: true })).toBeVisible();
      await expect(card(page, "누가 사고 파나").locator('[data-subject="foreign"]').first()).toBeVisible();
      await expect(main(page).getByText("키움 연결 전입니다")).toHaveCount(0);
    });

    test("순위 창이 행을 보인다", async ({ page, scenario }) => {
      serveRankings(scenario, { source: "kiwoom" });
      openRankingLayout(scenario);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/");
      await expect(page.getByTestId("ranking-row").first()).toBeVisible();
      await expect(page.getByTestId("ranking-window").getByText("키움 연결 전입니다")).toHaveCount(0);
    });

    test("스크리너 업데이트 단추가 '연결 뒤'가 아니라 눌린다", async ({ page, scenario, screener }) => {
      screener.showStatus(readyStatus());
      scenario.documents.saveScreens({ screens: [{ id: "high", name: "고점", markets: [], exclude: [], conditions: [NEW_HIGH] }], revision: 1 });
      await page.goto("/");
      await openScreener(page);
      await expect(update(page)).toHaveText("업데이트");
      await expect(update(page)).toBeEnabled();
    });
  });

  test.describe("한투 연결이 실패했고 받을 곳이 없을 때", () => {
    test.beforeEach(({ scenario }) => showFailedKisWithConnectedKiwoom(scenario, KIS_FAILED_NOBODY_RECEIVES));

    test("시장 종합은 키움 연결 전 안내로 막는다", async ({ page, scenario }) => {
      serveMarketRankings(scenario);
      await page.goto("/market");
      await expect(main(page).getByText("키움 연결 전입니다")).toBeVisible();
      await expect(card(page, "지수·폭")).toHaveCount(0);
    });

    test("순위 창은 키움 연결 전 안내로 막는다", async ({ page, scenario }) => {
      serveRankings(scenario, { source: "kiwoom" });
      openRankingLayout(scenario);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/");
      await expect(page.getByTestId("ranking-window").getByText("키움 연결 전입니다")).toBeVisible();
      await expect(page.getByTestId("ranking-row")).toHaveCount(0);
    });

    test("스크리너 업데이트 단추는 '연결 뒤'로 막힌다", async ({ page, scenario, screener }) => {
      screener.showStatus(readyStatus());
      scenario.documents.saveScreens({ screens: [{ id: "high", name: "고점", markets: [], exclude: [], conditions: [NEW_HIGH] }], revision: 1 });
      await page.goto("/");
      await openScreener(page);
      await expect(update(page)).toHaveText("연결 뒤");
      await expect(update(page)).toBeDisabled();
    });
  });

  test("한투가 받는 예상체결 순위는 관리종목 빼기를 끄고 쓸 수 없게 보인다", async ({ page, scenario }) => {
    scenario.live.marketSource = KIS_MARKET_SOURCE;
    serveRankings(scenario, { source: "kis" });
    openRankingLayout(scenario, EXPECTED);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "조건", exact: true }).click();
    const managed = page.getByRole("dialog", { name: "순위 조건" }).getByRole("button", { name: "관리종목 빼기" });
    await expect(managed).toBeDisabled();
    await expect(managed).toHaveAttribute("aria-pressed", "false");
    await expect(managed).toHaveAttribute("title", "한투로 받을 때는 고를 수 없습니다");
  });
});
