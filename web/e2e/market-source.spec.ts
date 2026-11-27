import type { Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { MarketSourceStatus } from "../src/api/generated/MarketSourceStatus";
import type { Ranking } from "../src/api/generated/Ranking";
import { KIS_MARKET_SOURCE, KIS_SOURCE_KIWOOM_FEED, KIWOOM_MARKET_SOURCE, MARKET_FEATURES } from "./fixtures/market-source";
import { anyMarketOverviewCall, marketOverviewCalls, serveMarketRankings } from "./fixtures/market-data";
import { rankingCalls, serveRankings } from "./fixtures/ranking-data";
import { readyStatus } from "./fixtures/screener";
import { DEFAULT_LAYOUT_ID, expect, pollSaved, test, type Scenario } from "./harness";
import { openScreener, panel as screenerPanel, results, rows as resultRows, runButton, storeLine } from "./screener-page";
import { test as screenerTest } from "./screener-harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const EXCLUDES = { etfEtn: true, preferred: false };
const TRADE_AMOUNT: Ranking = { kind: "tradeAmount", market: "all", venue: "combined", excludes: EXCLUDES, excludeManaged: false };
const FOREIGN_STREAK: Ranking = { kind: "foreignStreak", market: "all", venue: "combined", direction: "netBuy", excludes: EXCLUDES };
const MOST_VIEWED_MINUTE: Ranking = { kind: "mostViewed", span: "minute1", excludes: EXCLUDES };
const INVESTOR: Ranking = { kind: "investorNetBuy", market: "all", investor: "foreign", direction: "netBuy", unit: "amount", excludes: EXCLUDES };

function openLayout(scenario: Scenario, ranking: Ranking) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chart: LayoutWindow = { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS };
  const windows: LayoutWindow[] = [chart, { id: "ranking", link: null, kind: "ranking", ranking }, ...layout.windows.filter((w) => w.kind !== "chart" && w.kind !== "ranking")];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
}

const savedRanking = (scenario: Scenario) => {
  const window = scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.find((w) => w.kind === "ranking");
  return window?.kind === "ranking" ? window.ranking : null;
};

const dialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const rankingWindow = (page: Page) => page.getByTestId("ranking-window");
const field = (page: Page, label: string) => page.getByRole("combobox", { name: `순위 ${label}` });
const openConditions = async (page: Page) => {
  if (!(await page.getByRole("dialog", { name: "순위 조건" }).isVisible())) await page.getByRole("button", { name: "조건", exact: true }).click();
};
const statusBar = (page: Page) => page.locator("footer.status-bar");
const main = (page: Page) => page.getByRole("main", { name: "시장 종합", exact: true });

async function openRanking(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(rankingWindow(page)).toBeVisible();
}

test("시세 공급원이 한투이고 순위를 키움에서 받으면 순위 창 머리에 '키움'이 보인다. 시세 공급원도 키움이면 아무 표시가 없다", async ({ page, scenario }) => {
  scenario.live.marketSource = KIS_SOURCE_KIWOOM_FEED;
  serveRankings(scenario, { source: "kiwoom" });
  openLayout(scenario, TRADE_AMOUNT);
  await openRanking(page);
  await expect(page.getByTestId("ranking-row").first()).toBeVisible();
  await expect(page.getByTestId("ranking-source-mark")).toHaveText("키움");

  scenario.live.source(KIWOOM_MARKET_SOURCE);
  await expect(page.getByTestId("ranking-source-mark")).toHaveCount(0);
});

test("시세 공급원이 한투이고 시장 개요를 키움에서 받으면 칸 머리마다 '키움'이 붙고, 키움이면 붙지 않는다", async ({ page, scenario }) => {
  scenario.live.marketSource = KIS_SOURCE_KIWOOM_FEED;
  serveMarketRankings(scenario);
  await page.goto("/market");
  const marks = main(page).getByTestId("feed-source-mark");
  await expect(marks.first()).toHaveText("키움");
  await expect.poll(() => marks.count()).toBeGreaterThanOrEqual(5);
  for (const card of ["지수·폭", "업종 지도", "누가 사고 파나", "거래대금 추이", "종목"]) await expect(main(page).getByRole("region", { name: card }).getByTestId("feed-source-mark")).toHaveText("키움");

  scenario.live.source(KIWOOM_MARKET_SOURCE);
  await expect(marks).toHaveCount(0);
});

test("한투로만 받을 때 외국인 연속 순매수 순위 자리에 안내와 시스템 설정 이어가기가 보이고, 창은 닫히지 않는다. 거래대금 순위는 그대로 그려진다", async ({ page, scenario }) => {
  scenario.live.marketSource = KIS_MARKET_SOURCE;
  serveRankings(scenario, { source: "kis" });
  openLayout(scenario, FOREIGN_STREAK);
  await openRanking(page);
  const notice = page.getByTestId("ranking-unavailable");
  await expect(notice).toContainText("한투로는 받을 수 없습니다. 키움 키를 더하면 보입니다");
  await expect(page.getByTestId("ranking-row")).toHaveCount(0);
  expect(rankingCalls(scenario)).toEqual([]);
  await expect(page.getByRole("tab", { name: "외국인 연속", selected: true })).toBeVisible();
  await expect(rankingWindow(page)).toBeVisible();

  await notice.getByRole("button", { name: "시스템 설정 이어가기" }).click();
  await expect(dialog(page).getByRole("tab", { name: /^증권사 · 계좌/ })).toHaveAttribute("aria-selected", "true");
  await dialog(page).getByRole("button", { name: "닫기" }).click();
  await expect(rankingWindow(page)).toBeVisible();

  await page.getByRole("tab", { name: "거래", exact: true }).click();
  await expect(page.getByRole("tab", { name: "거래대금", selected: true })).toBeVisible();
  await expect(page.getByTestId("ranking-row").first()).toBeVisible();
  await expect(page.getByTestId("ranking-unavailable")).toHaveCount(0);
  await expect(page.getByTestId("ranking-source-mark")).toHaveCount(0);
});

test("한투로만 받을 때 시장 종합의 연속 매매 카드 자리에 안내와 시스템 설정 이어가기가 보이고 요청이 없다. 다른 칸은 그대로 그려진다", async ({ page, scenario }) => {
  scenario.live.marketSource = KIS_MARKET_SOURCE;
  serveMarketRankings(scenario);
  await page.goto("/market");
  const stocks = main(page).getByRole("region", { name: "종목" });
  await expect(stocks.getByRole("button", { name: "삼성전자" })).toBeVisible();
  await expect(main(page).getByRole("region", { name: "지수·폭" }).getByText("코스피", { exact: true })).toBeVisible();
  for (const tab of ["외국인 연속", "기관 연속"]) {
    await stocks.getByRole("tab", { name: tab }).click();
    await expect(stocks.getByTestId("feed-unavailable")).toContainText("한투로는 받을 수 없습니다. 키움 키를 더하면 보입니다");
  }
  expect(marketOverviewCalls(scenario, "streaks", "kospi")).toBe(0);
  expect(anyMarketOverviewCall(scenario)).toBe(true);
  await stocks.getByTestId("feed-unavailable").getByRole("button", { name: "시스템 설정 이어가기" }).click();
  await expect(dialog(page).getByRole("tab", { name: /^증권사 · 계좌/ })).toHaveAttribute("aria-selected", "true");
});

test("한투로 받을 때 많이 본 종목의 30초 기간과 투자자 순매수의 투신은 흐리고 고를 수 없다", async ({ page, scenario }) => {
  scenario.live.marketSource = KIS_MARKET_SOURCE;
  serveRankings(scenario, { source: "kis" });
  openLayout(scenario, INVESTOR);
  await openRanking(page);
  await openConditions(page);
  await field(page, "투자자").click();
  const investorMenu = page.getByRole("menu", { name: "순위 투자자", exact: true });
  const trust = investorMenu.locator('[data-option-value="investmentTrust"]');
  await expect(trust).toBeDisabled();
  await expect(trust).toHaveAttribute("title", "한투로 받을 때는 고를 수 없습니다");
  await expect(investorMenu.locator('[data-option-value="foreign"]')).toBeEnabled();
  await expect(investorMenu.locator('[data-option-value="institution"]')).toBeEnabled();

  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "기타", exact: true }).click();
  await page.getByRole("tab", { name: "많이 본 종목" }).click();
  await openConditions(page);
  await field(page, "구간").click();
  const spanMenu = page.getByRole("menu", { name: "순위 구간", exact: true });
  await expect(spanMenu.locator('[data-option-value="seconds30"]')).toBeDisabled();
  await expect(spanMenu.locator('[data-option-value="seconds30"]')).toHaveAttribute("title", "한투로 받을 때는 고를 수 없습니다");
  await expect(spanMenu.locator('[data-option-value="today"]')).toBeEnabled();

  scenario.live.source(KIWOOM_MARKET_SOURCE);
  await expect(spanMenu.locator('[data-option-value="seconds30"]')).toBeEnabled();
});

test("이미 고른 값을 한투가 받지 않으면 첫 받는 값으로 바꾸고 바꿨다고 알린다", async ({ page, scenario }) => {
  scenario.live.marketSource = KIS_MARKET_SOURCE;
  serveRankings(scenario, { source: "kis" });
  openLayout(scenario, MOST_VIEWED_MINUTE);
  await openRanking(page);
  await openConditions(page);
  await expect(field(page, "구간")).toHaveAttribute("data-value", "today");
  await expect(page.getByRole("status").filter({ hasText: "조회 기간을 ‘당일 누적’으로 바꿨습니다" })).toBeVisible();
  await pollSaved(() => savedRanking(scenario)).toEqual({ ...MOST_VIEWED_MINUTE, span: "today" });
});

test("한투로 받을 때 위 막대 연결 표시에 한투 이름이 붙고 키움이면 그대로다", async ({ page, scenario }) => {
  scenario.live.marketSource = KIS_MARKET_SOURCE;
  await page.goto("/");
  await expect(statusBar(page).getByRole("status")).toHaveText("한투 실시간 연결됨");
  scenario.live.source(KIWOOM_MARKET_SOURCE);
  await expect(statusBar(page).getByRole("status")).toHaveText("실시간 연결됨");
});

test("한투 시세 공급원이 연결 안 함이면 위 막대와 차트 안내가 한투를 말하고 키움 키 안내가 아니다", async ({ page, scenario }) => {
  scenario.live.marketSource = { ...KIS_MARKET_SOURCE, state: "disconnected" };
  scenario.live.status({ realtime: "notConnected", since: Math.floor(scenario.now / 1000), backfilling: false });
  await page.goto("/");
  await expect(statusBar(page).getByRole("button", { name: /한투에 연결하지 않았습니다/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "키움 연결 안내" }).getByRole("heading", { name: "한투에 연결하지 않았습니다" })).toBeVisible();
});

test("공급원 기능에 분봉이 없으면 분봉 주기 메뉴가 흐리고 안내가 보이며 고를 수 없다", async ({ page, scenario }) => {
  const features: MarketSourceStatus["features"] = MARKET_FEATURES.filter((feature) => feature !== "minuteBars");
  scenario.live.marketSource = { ...KIWOOM_MARKET_SOURCE, features };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const minute = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "분봉" });
  await expect(minute).toHaveAttribute("aria-disabled", "true");
  await expect(minute).toHaveAttribute("title", "이 시세 공급원은 분봉을 주지 않습니다");
  await minute.click({ force: true });
  const menu = page.getByRole("menu", { name: "분봉" });
  await expect(menu).toContainText("이 시세 공급원은 분봉을 주지 않습니다");
  await expect(menu.getByRole("menuitemradio").first()).toHaveAttribute("aria-disabled", "true");
  await menu.getByRole("menuitemradio").first().click({ force: true });
  await expect(page.getByRole("button", { name: "일", exact: true })).toHaveAttribute("aria-pressed", "true");

  scenario.live.source(KIWOOM_MARKET_SOURCE);
  await expect(minute).not.toHaveAttribute("aria-disabled", "true");
});

screenerTest.describe("스크리너 갱신", () => {
  screenerTest("키움 키가 없으면 스크리너 갱신 단추가 꺼져 있고 툴팁이 있으며, 검색은 된다", async ({ page, scenario, screener }) => {
    scenario.live.marketSource = KIS_MARKET_SOURCE;
    screener.showStatus(readyStatus());
    scenario.documents.saveScreens({ screens: [{ id: "high", name: "고점", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "D", field: "close", n: 60, recentBars: 1 }] }], revision: 1 });
    await page.goto("/");
    await openScreener(page);
    const update = storeLine(page).getByRole("button", { name: /^업데이트/ });
    await expect(update).toBeDisabled();
    await expect(update).toHaveAttribute("title", "키움 키가 있어야 갱신합니다");
    await runButton(page).click();
    await expect(results(page)).toHaveAttribute("aria-busy", "false");
    await expect(resultRows(page).first()).toBeVisible();

    scenario.live.source(KIS_SOURCE_KIWOOM_FEED);
    await expect(update).toBeEnabled();
    await expect(update).not.toHaveAttribute("title", /./);
    await expect(screenerPanel(page)).toBeVisible();
  });
});
